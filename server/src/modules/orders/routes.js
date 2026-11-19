// Orders routed through TradeLock. Every new order passes the risk gate; exits always pass.
import { v } from '../../lib/validate.js';
import { bad, forbidden, HttpError } from '../../lib/errors.js';
import { limit } from '../../lib/ratelimit.js';
import { ist, marketOpen } from '../../lib/time.js';
import { accountFor, adapterFor } from '../broker/registry.js';
import { getBook, getKillStatus, killSwitchLock } from '../broker/book.js';
import { getRules } from '../rules/service.js';
import { getSubscription } from '../billing/service.js';
import { checkOrder } from '../risk/gate.js';
import { dayState, patchDay, capitalFor } from '../risk/service.js';
import { syncAccount } from '../risk/monitor.js';
import { mcxMultiplier } from '../scalper/underlyings.js';
import { audit } from '../audit/service.js';
import { notify } from '../notifications/service.js';
import { saveSuperBracket, releaseForExit } from '../brackets/service.js';
import { bracketsFor } from '../brackets/store.js';
import { exitAutoTrade } from '../scalper/autotrade.js';

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

// ---- Super Order entries ----
// Accounts whose Dhan refused a Super Order (not activated): plain orders until the server restarts.
const superOff = new Set();
const tickRound = p => Math.round(Math.round(p / 0.05) * 0.05 * 100) / 100;
/** The limit a stop entry works at once triggered: 5% past the trigger (a buy above it, a sell below), on the tick. */
export const stopLimitPrice = (side, trigger) => Math.max(0.05, tickRound(side === 'BUY' ? trigger * 1.05 : trigger * 0.95));

/**
 * { sl, tp } for a new option entry at market placed as a Dhan Super Order, or null for a plain order. The stop is the
 * Option SL room from the Risk rules (e.g. 20% below the price for a buy) and the target 1:2 (twice that distance the
 * other way). Only Dhan accounts trading through Dhan, with the Option SL room on and a live price.
 */
export function superLevels(userId, acct, adapter, order, ltp) {
  if (acct.broker !== 'dhan' || !adapter.placeSuperOrder || superOff.has(acct.id) || acct.paper_mode === 1) return null;
  if (order.type !== 'MARKET' || !/_FNO$/.test(String(order.exchangeSegment || '')) || !(ltp > 0)) return null;
  if (order.qty > 900) return null;   // near a freeze limit: a sliced plain order (a super order is not sliced)
  const room = getRules(userId).active.optionSl;
  if (!room?.on || !(room.value > 0)) return null;
  const long = order.side === 'BUY', risk = ltp * room.value / 100;
  const sl = tickRound(long ? ltp - risk : ltp + risk), tp = tickRound(long ? ltp + 2 * risk : ltp - 2 * risk);
  return sl > 0 && tp > 0 && sl !== tp ? { sl, tp } : null;
}

const ENTRY_FOLLOW_S = 10;
/**
 * After a new order: the broker answers "pending" and only rejects a moment later (funds, IP, freeze limit...).
 * Watch it for a few seconds; a rejection is raised as an alert (app and web) with the broker's own reason.
 */
async function followEntry(userId, acct, order, orderId, isSuper = false) {
  const adapter = adapterFor(acct);
  if (!orderId || !(isSuper ? adapter.superOrder : adapter.orderStatus)) return;
  // A super order is read from Dhan's super order book; its states map to filled / failed / pending.
  const statusOf = async id => {
    if (!isSuper) return adapter.orderStatus(id);
    const so = await adapter.superOrder(id);
    if (!so) return { status: 'pending' };
    return { status: ['REJECTED', 'CANCELLED'].includes(so.status) ? 'failed' : ['TRADED', 'CLOSED', 'TRIGGERED'].includes(so.status) ? 'filled' : 'pending', reason: so.reason };
  };
  for (let k = 0; k < ENTRY_FOLLOW_S; k++) {
    await sleep(1000);
    let s;
    try { s = await statusOf(orderId); } catch { continue; }
    // Filled: refresh the positions now (after the NSE close the regular sync would show it only minutes later).
    if (s.status === 'filled') { await syncAccount(acct, { force: !marketOpen() }).catch(() => {}); return; }
    if (s.status === 'failed') {
      // Dhan's RMS text carries the order id first ("RMS:3422…:You have insufficient funds…"): keep the readable part.
      const reason = String(s.reason || '').replace(/^RMS:\d+:/, '').trim();
      audit(userId, 'order.rejected', { symbol: order.symbol, side: order.side, qty: order.qty, reason });
      notify(userId, { kind: 'risk', level: 'critical', title: `${adapter.label} rejected ${order.side} ${order.symbol}`,
        body: reason || `${adapter.label} did not accept the order. Check it in the ${adapter.label} app.` });
      await syncAccount(acct, { force: true }).catch(() => {});
      return;
    }
  }
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

/**
 * Place an order for a user, as the Power Scalper ticket does: validated, checked by the risk gate (kill switch, pause,
 * one trade at a time, capital per trade...), placed (a Dhan Super Order when it can), synced and followed. Used by
 * POST /api/orders and by index alerts that carry an order. Throws HttpError when refused.
 */
export async function placeOrderFor(userId, b = {}, ip = null) {
  const order = {
    symbol: v.str(b.symbol, 'Instrument', { min: 2, max: 60 }).toUpperCase(),
    side: v.oneOf(b.side, 'Side', ['BUY', 'SELL']),
    qty: v.num(b.qty, 'Quantity', { min: 1, max: 100_000, int: true }),
    type: v.oneOf(b.type || 'MARKET', 'Order type', ['MARKET', 'LIMIT', 'STOP_LOSS']),
    securityId: b.securityId ? String(b.securityId) : undefined,
    exchangeSegment: b.exchangeSegment,
    productType: b.productType,
  };
  if (order.type === 'LIMIT') order.price = v.num(b.price, 'Limit price', { min: 0.05, max: 1_000_000 });
  // A stop entry (chart "+" above the market for a buy, below for a sell): rests until the price crosses the trigger,
  // then works as a limit a little past it (5%), so it fills on a breakout without chasing a runaway price.
  if (order.type === 'STOP_LOSS') {
    order.triggerPrice = v.num(b.triggerPrice ?? b.price, 'Trigger price', { min: 0.05, max: 1_000_000 });
    order.price = stopLimitPrice(order.side, order.triggerPrice);
  }
  // MCX: Dhan's quantity is in lots, so a lot's rupee value is premium × the contract multiplier (CRUDEOILM / GOLDM 10).
  if (/^MCX/.test(String(order.exchangeSegment || ''))) order.multiplier = mcxMultiplier(order.symbol) ?? 1;
  // The live premium the ticket was sized at (market orders): checked against Capital per trade, not sent to the broker.
  const sizedAt = b.ltp != null ? v.num(b.ltp, 'Price', { min: 0.05, max: 1_000_000 }) : null;
  // A stop on the wrong side of the market would trigger at once: that is a limit (or market) order instead.
  if (order.type === 'STOP_LOSS' && sizedAt && (order.side === 'BUY' ? order.triggerPrice <= sizedAt : order.triggerPrice >= sizedAt))
    throw bad('VALIDATION', order.side === 'BUY' ? `A buy stop goes above the current price (${sizedAt}). At or below it, use a buy limit.`
      : `A sell stop goes below the current price (${sizedAt}). At or above it, use a sell limit.`);

  const acct = requireAccount(userId);
  const t = ist();
  const s = dayState(userId, t.day);
  // A stop entry is checked (Capital per trade) at its trigger, the price it is meant to fill near.
  const verdict = checkOrder(order.type === 'STOP_LOSS' ? { ...order, price: order.triggerPrice } : order, {
    rules: getRules(userId).active,
    positions: getBook(userId).positions,
    orders: getBook(userId).orders || [],
    entryInFlight: entriesInFlight.has(userId),
    entries: s.entries,
    pnl: s.realized + s.unrealized,
    minutes: marketOpen() ? t.minutes : null,
    capital: capitalFor(userId, s),
    price: sizedAt,
    paused: !!s.paused,
    killSwitchActive: !!killSwitchLock(userId, s), killSwitchLabel: killSwitchLock(userId, s),
    pauseReason: s.pause_reason,
    subscriptionActive: getSubscription(userId).active,
    algoOnly: false,   // manual trading is always allowed, also while Algo Trading runs
  });
  if (!verdict.ok) {
    patchDay(userId, t.day, { blocked: s.blocked + 1 });
    audit(userId, 'order.blocked', { order, code: verdict.code }, ip);
    throw forbidden('ORDER_BLOCKED', verdict.reason, { rule: verdict.code });
  }
  // Hold the one-trade lock while this entry is placed and the book is refreshed, so a second
  // request arriving meanwhile cannot slip through before the position shows up.
  if (!verdict.reducing) entriesInFlight.add(userId);
  let result, sup = null, superNote = null;
  try {
    // A new option entry at market goes to Dhan as a Super Order when it can (see superLevels): its stop-loss at the
    // Option SL room and its target at 1:2 are legs at Dhan from the start.
    const adapter = adapterFor(acct), levels = verdict.reducing ? null : superLevels(userId, acct, adapter, order, sizedAt);
    if (levels) {
      try {
        result = await adapter.placeSuperOrder({ ...order, targetPrice: levels.tp, stopLossPrice: levels.sl });
        sup = levels;
      } catch (e) {
        // Dhan refused the super order outright: no order exists, so a plain order is safe now. A refusal that is about
        // funds would refuse the plain order too: reported as it is. A network failure may have placed it: never resent.
        if (['NETWORK', 'TOKEN_EXPIRED'].includes(e?.code) || /fund|margin|insufficient/i.test(e?.message || '')) throw e;
        superOff.add(acct.id);
        superNote = `Dhan did not accept a Super Order (${e.message}). Placed a normal order instead: set TP / SL by dragging. Activate Super Order on your Dhan account to have them at Dhan.`;
        audit(userId, 'order.super_refused', { symbol: order.symbol, reason: e.message }, ip);
        notify(userId, { kind: 'risk', level: 'warn', title: 'Super Order not available: normal order placed', body: superNote });
      }
    }
    if (!result) result = await adapter.placeOrder(order);
    if (sup) saveSuperBracket(userId, { securityId: order.securityId, segment: order.exchangeSegment, symbol: order.symbol,
      side: order.side === 'BUY' ? 1 : -1, qty: order.qty, tp: sup.tp, sl: sup.sl, superId: result.id });
    audit(userId, 'order.placed', { order, result, ...(sup && { super: sup }) }, ip);
    // Forced: after the NSE close the account sync is otherwise skipped for 5 minutes (an MCX fill would not show).
    await syncAccount(acct, { force: !marketOpen() });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, 'BROKER_REJECTED', `Broker rejected the request: ${e.message}`);
  } finally { if (!verdict.reducing) entriesInFlight.delete(userId); }
  // A market order's rejection comes after "pending" (a limit can rest, or be cancelled by the user: not followed).
  if (order.type === 'MARKET') followEntry(userId, acct, order, result?.id, !!sup).catch(() => {});
  return { order: { ...order, ...result }, reducing: verdict.reducing, ...(sup && { super: sup }), ...(superNote && { note: superNote }) };
}

export function ordersRoutes(r) {
  r.post('/api/orders', async ctx => {
    limit(`order:${ctx.user.id}`, 30, 60e3);
    const res = await placeOrderFor(ctx.user.id, ctx.body, ctx.ip);
    ctx.status = 201;
    return res;
  });

  // Move a pending LIMIT order to a new price (dragging its line on the Power Scalper chart). Same order, same quantity.
  r.put('/api/orders/:id', async ctx => {
    limit(`order-modify:${ctx.user.id}`, 60, 60e3);
    const acct = requireAccount(ctx.user.id);
    const price = v.num(ctx.body?.price, 'Limit price', { min: 0.05, max: 1_000_000 });
    const o = (getBook(ctx.user.id).orders || []).find(x => String(x.id) === String(ctx.params.id));
    if (!o) throw bad('NO_ORDER', 'That order is no longer pending.');
    const stop = o.type === 'STOP_LOSS' || o.type === 'SL';
    if (o.type !== 'LIMIT' && !stop) throw bad('NOT_LIMIT', 'Only a limit or stop order can be moved here.');
    // A position's stop-loss moves with its TP / SL on the chart (brackets), not here.
    if (stop && bracketsFor(ctx.user.id).some(b => String(b.slOrderId) === String(o.id))) throw bad('BRACKET_STOP', 'Move the stop-loss with the SL line of the position.');
    const adapter = adapterFor(acct);
    if (!(stop ? adapter.modifyStopLoss : adapter.modifyOrder)) throw bad('UNSUPPORTED', 'This broker does not allow changing an order here.');
    const result = await brokerCall(() => stop
      ? adapter.modifyStopLoss(o.id, { triggerPrice: price, price: stopLimitPrice(o.side, price), qty: o.qty })
      : adapter.modifyOrder(o.id, { price, qty: o.qty }));
    audit(ctx.user.id, 'order.modified', { id: o.id, symbol: o.symbol, from: stop ? (o.triggerPrice ?? o.price) : o.price, to: price, ...(stop && { trigger: true }) }, ctx.ip);
    // Forced after the NSE close: the off-hours sync is otherwise skipped for minutes and the chart keeps the old price.
    await syncAccount(acct, { force: !marketOpen() });
    return { order: { ...o, price, ...result } };
  });

  r.delete('/api/orders/:id', async ctx => {
    const acct = requireAccount(ctx.user.id);
    await brokerCall(() => adapterFor(acct).cancelOrder(ctx.params.id));
    audit(ctx.user.id, 'order.cancelled', { id: ctx.params.id }, ctx.ip);
    await syncAccount(acct, { force: !marketOpen() });   // as above: a cancelled order leaves the chart at once
    return { ok: true };
  });

  r.post('/api/positions/exit', async ctx => {
    const symbol = v.str(ctx.body.symbol, 'Instrument', { min: 2, max: 60 });
    const acct = requireAccount(ctx.user.id);
    const pos = getBook(ctx.user.id).positions.find(p => p.symbol === symbol && p.qty !== 0);
    if (!pos) throw bad('NO_POSITION', `No open position in ${symbol}.`);
    // An Algo Trading position: its own exit cancels its stop-loss order (confirmed) before selling.
    const auto = exitAutoTrade(ctx.user.id, pos.securityId);
    if (auto) {
      audit(ctx.user.id, 'position.exit', { symbol, via: 'algo', tradeId: auto.id }, ctx.ip);
      ctx.status = 202;
      return { order: null, algo: true, note: `Closing ${symbol}: its Algo stop-loss is cancelled first, then the exit is sent.` };
    }
    // Its target / stop at the broker first (Super Order legs, or the stop-loss order): none left behind to trade after
    // the exit, and the broker does not take the exit for a new short.
    const rel = await releaseForExit(ctx.user.id, acct, pos.securityId);
    if (rel.closed) { await syncAccount(acct, { force: true }).catch(() => {}); ctx.status = 202; return { order: null, closed: true, note: 'The stop-loss already closed this position.' }; }
    if (rel.unknown) throw bad('STOP_NOT_CANCELLED', `The stop-loss order on ${symbol} could not be confirmed cancelled, so TradeLock did not send the exit (it could sell twice). Exit it in the ${adapterFor(acct).label} app.`);
    const left = Math.abs(pos.qty) - (rel.filledQty || 0);
    if (left <= 0) { ctx.status = 202; return { order: null, closed: true }; }
    const result = await brokerCall(() => adapterFor(acct).exitPosition({ ...pos, qty: Math.sign(pos.qty) * left }));
    audit(ctx.user.id, 'position.exit', { symbol, result }, ctx.ip);
    followExit(ctx.user.id, acct, symbol, result?.id).catch(e => console.error('[exit]', e.message));
    ctx.status = 202;
    return { order: result };
  });
}
