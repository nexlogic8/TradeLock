// One Dhan account (MARKET_DATA_USER_ID, with Dhan's Data APIs) supplies the market data for every user: option
// chains, quotes, candles, expired-option history and the live feed. Each user's own broker still gets every order.
// Calls through the shared token are cached and paced to Dhan's limits (option chain one per 3 s, quotes one a
// second, other data five a second), so many users asking for the same chain cost one call.
import { stmt } from '../../db/index.js';
import { decrypt } from '../../lib/crypto.js';
import { config } from '../../config.js';
import { createDhanAdapter } from './adapters/dhan.js';

/** Market-data methods of the Dhan adapter, with how long an answer is reused and which pace lane it uses. */
const METHODS = {
  optionChain: { ttl: 3_000, lane: 'chain' },
  optionExpiries: { ttl: 10 * 60_000, lane: 'data' },
  quotes: { ttl: 1_000, lane: 'quote' },
  quote: { ttl: 1_000, lane: 'quote' },
  ltp: { ttl: 1_000, lane: 'quote' },
  intradayCandles: { ttl: 4_000, lane: 'data' },
  rollingOption: { ttl: 30_000, lane: 'data' },
};
const GAP = { chain: 3_100, quote: 1_050, data: 220 };

let source = null;   // { tokenEnc, userId, clientId, adapter, cache, lanes }

/** The shared data account, or null (not configured, or its Dhan token is not connected). */
export function sharedSource() {
  const uid = Number(config.marketDataUserId) || 0;
  if (!uid) return null;
  const acct = stmt(`SELECT * FROM broker_accounts WHERE user_id = ? AND broker = 'dhan' AND status = 'connected' AND token_enc IS NOT NULL
                     ORDER BY created_at DESC LIMIT 1`).get(uid);
  if (!acct) return null;
  if (source?.tokenEnc !== acct.token_enc) {
    const accessToken = decrypt(acct.token_enc);
    source = { tokenEnc: acct.token_enc, userId: uid, clientId: acct.client_id, accessToken,
      adapter: createDhanAdapter({ clientId: acct.client_id, accessToken }), cache: new Map(), lanes: { chain: 0, quote: 0, data: 0 } };
  }
  return source;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function slot(src, lane) {
  const now = Date.now(), at = Math.max(now, src.lanes[lane]);
  src.lanes[lane] = at + GAP[lane];
  if (at > now) await sleep(at - now);
}

function shared(src, name, args) {
  const { ttl, lane } = METHODS[name], key = `${name}:${JSON.stringify(args)}`, hit = src.cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.promise;
  const promise = slot(src, lane).then(() => src.adapter[name](...args));
  src.cache.set(key, { at: Date.now(), promise });
  promise.catch(() => { if (src.cache.get(key)?.promise === promise) src.cache.delete(key); });
  if (src.cache.size > 2_000) for (const [k, v] of src.cache) if (Date.now() - v.at > 60_000) src.cache.delete(k);
  return promise;
}

/** The adapter with its market-data methods answered by the shared account (when there is one). */
export function withSharedData(adapter) {
  if (!Number(config.marketDataUserId)) return adapter;
  const out = { ...adapter };
  for (const name of Object.keys(METHODS)) {
    const own = adapter[name];
    out[name] = (...args) => {
      const src = sharedSource();
      if (src) return shared(src, name, args);
      if (typeof own !== 'function') return Promise.reject(new Error('Market data is not available right now.'));
      return own(...args);
    };
  }
  return out;
}

/** Live-feed login: the shared account's when configured, else the user's own Dhan token. key groups users per socket. */
export function feedCredentials(userId, own) {
  const src = sharedSource();
  if (src) return { key: 'shared', clientId: src.clientId, accessToken: src.accessToken };
  const mine = own(userId);
  return mine ? { key: `u${userId}`, ...mine } : null;
}
