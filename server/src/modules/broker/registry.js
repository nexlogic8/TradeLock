/**
 * Broker adapter contract (implemented by adapters/*.js):
 *   label, alwaysOn, capabilities: { positions, squareOff, accountLock }
 *   verify()                         → throws if credentials are bad
 *   snapshot({ funds?, orders?, prevPosSig?, prevOrderSig? })
 *                                    → { positions[], orders[]?, trades[] | null, funds?, posSig?, orderSig? }
 *                                      (orders/funds undefined = not fetched; trades null = no new fills)
 *   placeOrder({symbol, side, qty, type, price, ...}) → { id, status }
 *   cancelOrder(id)                  → { status }
 *   exitPosition(position)           → { id, status: 'pending' }
 *   orderStatus(id)                  → { status: 'pending'|'filled'|'failed', price?, reason? }
 * Add a broker by writing an adapter and registering it in FACTORIES and CATALOG.
 */
import { stmt } from '../../db/index.js';
import { decrypt, encrypt } from '../../lib/crypto.js';
import { bad } from '../../lib/errors.js';
import { config } from '../../config.js';
import { createMockAdapter } from './adapters/mock.js';
import { createDhanAdapter, tokenExpiry } from './adapters/dhan.js';
import { createStoxkartAdapter } from './adapters/stoxkart.js';
import { createPaperAdapter } from './adapters/paper.js';
import { getBook, getPermissions, getKillStatus } from './book.js';
import { withSharedData, feedCredentials } from './market-data.js';
import { egressFor } from './static-ip.js';

const FACTORIES = { dhan: createDhanAdapter, mock: createMockAdapter };

export const CATALOG = [
  { id: 'dhan', name: 'Dhan', status: 'available', note: 'Orders, positions and P&L through DhanHQ API v2' },
  ...(config.isProd ? [] : [{ id: 'mock', name: 'Demo broker', status: 'available', note: 'Simulated NIFTY options book for trying TradeLock' }]),
  // Linked on top of the Dhan connection (Dhan keeps the market data); choosing its tab sends the orders to it.
  { id: 'stoxkart', name: 'StoxKart', status: 'planned', link: true },
  { id: 'zerodha', name: 'Zerodha', status: 'planned' },
  { id: 'upstox', name: 'Upstox', status: 'planned' },
  { id: 'angelone', name: 'Angel One', status: 'planned' },
];

const live = new Map();

export function createAdapter(broker, creds) {
  const factory = FACTORIES[broker];
  const reviewDemo = broker === 'mock' && creds?.reviewDemo === true;   // the store reviewers' simulated account only
  if (!factory || (!reviewDemo && !CATALOG.some(b => b.id === broker && b.status === 'available'))) throw bad('BROKER_UNAVAILABLE', 'That broker is not available yet.');
  return factory(creds);
}

export function adapterFor(acct) {
  let entry = live.get(acct.id);
  // Orders through StoxKart (trade_via): its link must be verified; its credentials can change on their own.
  const link = acct.trade_via === 'stoxkart' ? stmt(`SELECT creds_enc, status, updated_at FROM broker_links WHERE user_id = ? AND broker = 'stoxkart'`).get(acct.user_id) : null;
  // Paper mode (AI Algo Trading: Real | Paper): the paper broker trades, Dhan still supplies the prices.
  const via = acct.paper_mode === 1 ? 'paper' : link?.status === 'verified' ? `stoxkart:${link.updated_at}` : 'own';
  // A new token (reconnect, or renewed by the token keeper service) means a fresh adapter.
  if (!entry || entry.tokenEnc !== acct.token_enc || entry.via !== via) {
    const own = acct.broker === 'paper' ? {} : ownAdapter(acct);   // a Paper account (no broker): shared market data only
    entry = { tokenEnc: acct.token_enc, via, adapter: via === 'paper' ? createPaperAdapter({ userId: acct.user_id, data: withSharedData(own) })
      : withSharedData(via === 'own' ? own : tradeThroughStoxkart(own, JSON.parse(decrypt(link.creds_enc)))) };
    live.set(acct.id, entry);
  }
  return entry.adapter;
}

const ownAdapter = acct => createAdapter(acct.broker, { clientId: acct.client_id, accessToken: acct.token_enc ? decrypt(acct.token_enc) : null,
  egress: () => egressFor(acct.user_id), reviewDemo: !!config.reviewUserId && acct.user_id === config.reviewUserId });

/**
 * A fresh, uncached adapter trading through `via` ('own' | 'stoxkart'), to test the broker the account is NOT trading
 * through without touching the live one. null when that broker is not set up (StoxKart not linked and tested).
 */
export function probeAdapter(acct, via) {
  if (via !== 'stoxkart') return acct.token_enc ? withSharedData(ownAdapter(acct)) : null;
  const link = stmt(`SELECT creds_enc, status FROM broker_links WHERE user_id = ? AND broker = 'stoxkart'`).get(acct.user_id);
  return link?.status === 'verified' ? withSharedData(tradeThroughStoxkart(ownAdapter(acct), JSON.parse(decrypt(link.creds_enc)))) : null;
}

/**
 * Dhan for market data (option chain, quotes, candles, the live feed), StoxKart for everything that trades or reads
 * the trading account: positions, orders, fills, funds, exits. The same NSE instrument tokens serve both. No broker
 * kill switch or static-IP check through StoxKart's API, so those features are off while it is the trading broker.
 */
function tradeThroughStoxkart(dhan, creds) {
  // Market orders go to StoxKart as protected limits, priced from the live LTP (shared Dhan data).
  const data = withSharedData(dhan), sx = createStoxkartAdapter({ creds, ltp: (segment, securityId) => data.ltp(segment, securityId) });
  return { ...dhan, label: 'StoxKart', tradingBroker: 'stoxkart', capabilities: sx.capabilities,
    verify: sx.verify, snapshot: sx.snapshot, placeOrder: sx.placeOrder, orderStatus: sx.orderStatus, cancelOrder: sx.cancelOrder,
    modifyStopLoss: sx.modifyStopLoss, exitPosition: p => sx.exitPosition(p),
    tradeHistory: sx.tradeHistory, getKillSwitch: undefined, activateKillSwitch: undefined, permissions: undefined };
}

// Bumped whenever an account is connected, disconnected or its agent is started/stopped, so the
// monitor's cached account list is refreshed at once.
let accountsVersion = 0;
export const accountsChanged = () => { accountsVersion++; };
export const getAccountsVersion = () => accountsVersion;

export const dropAdapter = accountId => { live.delete(accountId); accountsChanged(); };

export const accountFor = userId =>
  stmt(`SELECT * FROM broker_accounts WHERE user_id = ? AND status != 'disconnected' ORDER BY created_at DESC LIMIT 1`).get(userId);

// The market-feed socket logs in with the shared data account (MARKET_DATA_USER_ID), else the user's own Dhan token.
// Keep the decryption server-side; never return these credentials from an HTTP route or websocket event.
const ownFeedCredentials = userId => {
  const acct = accountFor(userId);
  if (!acct || acct.status !== 'connected' || acct.broker !== 'dhan' || !acct.token_enc) return null;
  return { clientId: acct.client_id, accessToken: decrypt(acct.token_enc) };
};
export const marketFeedCredentials = userId => feedCredentials(userId, ownFeedCredentials);

const mask = s => (s.length > 4 ? `•••• ${s.slice(-4)}` : s);

export function accountSummary(acct) {
  if (!acct) return null;
  const a = adapterFor(acct);
  return {
    id: acct.id,
    broker: acct.broker,
    label: a.label,
    clientId: mask(acct.client_id),
    status: acct.status,
    agentOn: acct.agent_on !== 0,
    algoOn: acct.algo_on === 1,
    emaCrossOn: acct.cross_on !== 0,
    orbOn: acct.orb_on !== 0,
    gapOn: acct.gap_on === 1,
    ema915On: acct.ema915_on === 1,
    manualOn: acct.manual_on === 1,
    gapLockOn: acct.gap_lock !== 0,
    retestPaperOn: acct.retest_paper_on === 1,
    paperMode: acct.paper_mode === 1,
    tradeVia: acct.trade_via === 'stoxkart' ? 'stoxkart' : acct.broker,
    algoUnderlyings: String(acct.algo_underlying || 'NIFTY').split(','),
    lastSyncAt: getBook(acct.user_id).at ?? acct.last_sync_at,   // the DB copy is only refreshed every 30 s
    lastError: acct.last_error,
    tokenExpiresAt: getPermissions(acct.user_id)?.tokenValidUntil ?? acct.token_expires_at,
    capabilities: a.capabilities,
    permissions: getPermissions(acct.user_id),
    killSwitch: getKillStatus(acct.user_id),
  };
}

const DHAN_TOKEN_TTL = 24 * 3600e3;

/** Create or refresh the user's account for a broker; credentials are encrypted at rest. */
export function upsertAccount(userId, { broker, clientId, accessToken = null }) {
  const now = Date.now();
  stmt(`
    INSERT INTO broker_accounts (user_id, broker, client_id, token_enc, status, token_expires_at, created_at)
    VALUES (?, ?, ?, ?, 'connected', ?, ?)
    ON CONFLICT (user_id, broker) DO UPDATE SET client_id = excluded.client_id, token_enc = excluded.token_enc,
      status = 'connected', last_error = NULL, token_expires_at = excluded.token_expires_at, created_at = excluded.created_at`)
    .run(userId, broker, clientId, accessToken ? encrypt(accessToken) : null, broker === 'dhan' ? (tokenExpiry(accessToken) ?? now + DHAN_TOKEN_TTL) : null, now);
  const acct = stmt('SELECT * FROM broker_accounts WHERE user_id = ? AND broker = ?').get(userId, broker);
  dropAdapter(acct.id);
  return acct;
}
