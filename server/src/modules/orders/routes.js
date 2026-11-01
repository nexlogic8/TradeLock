// Orders routed through TradeLock. Every new order passes the risk gate; exits always pass.
import { v } from '../../lib/validate.js';
import { bad, forbidden, HttpError } from '../../lib/errors.js';
import { limit } from '../../lib/ratelimit.js';
import { ist, marketOpen } from '../../lib/time.js';
import { accountFor, adapterFor } from '../broker/registry.js';
import { getBook, getKillStatus } from '../broker/book.js';
import { getRules } from '../rules/service.js';
import { getSubscription } from '../billing/service.js';
import { checkOrder } from '../risk/gate.js';
import { dayState, patchDay, capitalFor } from '../risk/service.js';
import { syncAccount } from '../risk/monitor.js';
import { audit } from '../audit/service.js';
import { notify } from '../notifications/service.js';

const EXIT_FOLLOW_S = 20;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * After a one-click close: watch the exit order until the broker fills or rejects it. A fill refreshes
 * the positions at once; a rejection (static IP, freeze limit, margin...) is raised as an alert.
 */
async function followExit(userId, acct, symbol, orderId) {
  const adapter = adapterFor(acct);
  if (!adapter.orderStatus || !orderId) return;
  for (let k = 0; k < EXIT_FOLLOW_S; k++) {
    await sleep(1000);
    let s;
    try { s = await adapter.orderStatus(orderId); } catch { continue; }
    if (s.status === 'filled') {
      audit(userId, 'position.exited', { symbol, price: s.price ?? null });
      await syncAccount(acct, { force: true }).catch(() => {});
      return;
    }
    if (s.status === 'failed') {
      audit(userId, 'position.exit_failed', { symbol, reason: s.reason });
      notify(userId, { kind: 'risk', level: 'critical', title: `Could not close ${symbol}`,
        body: `${adapter.label} rejected the exit order${s.reason ? `: ${s.reason}` : ''}. Close it in the ${adapter.label} app.` });
      await syncAccount(acct, { force: true }).catch(() => {});
      return;
    }
  }
  notify(userId, { kind: 'risk', level: 'warn', title: `${symbol}: exit not confirmed yet`,
    body: `${adapter.label} has not confirmed the exit after ${EXIT_FOLLOW_S} seconds. Check the position in the ${adapter.label} app.` });
}

function requireAccount(userId) {
  const acct = accountFor(userId);
  if (!acct) throw bad('NO_BROKER', 'Connect a broker first.');
  return acct;
}

const brokerCall = async fn => {
  try { return await fn(); } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, 'BROKER_REJECTED', `Broker rejected the request: ${e.message}`);
  }
};

// Users with a new entry being placed right now (one trade at a time). Shared with the ORB auto-trader.
export const entriesInFlight = new Set();

export function ordersRoutes(r) {
  r.post('/api/orders', async ctx => {
    limit(`order:${ctx.user.id}`, 30, 60e3);
    const b = ctx.body;
    const order = {
      symbol: v.str(b.symbol, 'Instrument', { min: 2, max: 60 }).toUpperCase(),
      side: v.oneOf(b.side, 'Side', ['BUY', 'SELL']),
      qty: v.num(b.qty, 'Quantity', { min: 1, max: 100_000, int: true }),
      type: v.oneOf(b.type || 'MARKET', 'Order type', ['MARKET', 'LIMIT']),
      securityId: b.securityId ? String(b.securityId) : undefined,
      exchangeSegment: b.exchangeSegment,
      productType: b.productType,
    };
    if (order.type === 'LIMIT') order.price = v.num(b.price, 'Limit price', { min: 0.05, max: 1_000_000 });

    const acct = requireAccount(ctx.user.id);
    const t = ist();
    const s = dayState(ctx.user.id, t.day);
    const verdict = checkOrder(order, {
      rules: getRules(ctx.user.id).active,
      positions: getBook(ctx.user.id).positions,
      orders: getBook(ctx.user.id).orders || [],
      entryInFlight: entriesInFlight.has(ctx.user.id),
      entries: s.entries,
      pnl: s.realized + s.unrealized,
      minutes: marketOpen() ? t.minutes : null,
      capital: capitalFor(ctx.user.id, s),
      paused: !!s.paused,
      killSwitchActive: !!s.ks_active_at || getKillStatus(ctx.user.id)?.active === true,
      pauseReason: s.pause_reason,
      subscriptionActive: getSubscription(ctx.user.id).active,
      algoOnly: !!(acct.algo_on && acct.agent_on && acct.manual_on !== 1),   // manual entries are refused while Algo Trading runs, unless allowed
    });
    if (!verdict.ok) {
      patchDay(ctx.user.id, t.day, { blocked: s.blocked + 1 });
      audit(ctx.user.id, 'order.blocked', { order, code: verdict.code }, ctx.ip);
      throw forbidden('ORDER_BLOCKED', verdict.reason, { rule: verdict.code });
    }
    // Hold the one-trade lock while this entry is placed and the book is refreshed, so a second
    // request arriving meanwhile cannot slip through before the position shows up.
    if (!verdict.reducing) entriesInFlight.add(ctx.user.id);
    let result;
    try {
      result = await brokerCall(() => adapterFor(acct).placeOrder(order));
      audit(ctx.user.id, 'order.placed', { order, result }, ctx.ip);
      await syncAccount(acct);
    } finally { if (!verdict.reducing) entriesInFlight.delete(ctx.user.id); }
    ctx.status = 201;
    return { order: { ...order, ...result }, reducing: verdict.reducing };
  });

  r.delete('/api/orders/:id', async ctx => {
    const acct = requireAccount(ctx.user.id);
    await brokerCall(() => adapterFor(acct).cancelOrder(ctx.params.id));
    audit(ctx.user.id, 'order.cancelled', { id: ctx.params.id }, ctx.ip);
    await syncAccount(acct);
    return { ok: true };
  });

  r.post('/api/positions/exit', async ctx => {
    const symbol = v.str(ctx.body.symbol, 'Instrument', { min: 2, max: 60 });
    const acct = requireAccount(ctx.user.id);
    const pos = getBook(ctx.user.id).positions.find(p => p.symbol === symbol && p.qty !== 0);
    if (!pos) throw bad('NO_POSITION', `No open position in ${symbol}.`);
    const result = await brokerCall(() => adapterFor(acct).exitPosition(pos));
    audit(ctx.user.id, 'position.exit', { symbol, result }, ctx.ip);
    followExit(ctx.user.id, acct, symbol, result?.id).catch(e => console.error('[exit]', e.message));
    ctx.status = 202;
    return { order: result };
  });
}
