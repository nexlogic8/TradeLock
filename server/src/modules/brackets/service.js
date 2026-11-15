// Take-profit / stop-loss for an open position, dragged on the Power Scalper chart.
//   Stop-loss: a real stop-loss order at the broker (exit side, the position's quantity), so it protects the position
//   even if TradeLock or the internet is down. Dragging the line moves that order (Modify Order).
//   Target: watched by TradeLock on every sync and live tick; when reached, the stop order is cancelled FIRST (and
//   confirmed cancelled), then the position is exited at market. Two resting exit orders at the broker could both
//   fill and open a reverse position; this way there is only ever one.
// Algo Trading's own trades keep their own stop and exit: they cannot be edited here.
import { stmt } from '../../db/index.js';
import { bad, HttpError } from '../../lib/errors.js';
import { adapterFor } from '../broker/registry.js';
import { getBook, setBook, markDirty } from '../broker/book.js';
import { liveTick } from '../scalper/live.js';
import { indexOptionInstruments } from '../scalper/instruments.js';
import { audit } from '../audit/service.js';
import { notify } from '../notifications/service.js';
import { bracketsFor, bracketOf, saveBracket, dropBracket } from './store.js';
import { mcxLotValue } from '../risk/charges.js';

// The broker for an account (a mutable object so tests can stand in for it).
export const BROKER = { adapterFor };
export const SL_LIMIT_BUFFER = 0.05;   // stop-loss limit price 5% beyond the trigger, so a fast market still fills
const TICK_FRESH_MS = 5_000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
export const roundTick = (n, tick = 0.05) => Math.round(Math.round(n / tick) * tick * 10_000) / 10_000;

/** Rupees per 1 point per unit of qty: MCX mini contracts count quantity in lots (×10); others 1. */
export const pointValue = (segment, symbol) => (/^MCX/.test(String(segment || '')) ? mcxLotValue(symbol) : 1);

/** The stop-loss order's limit price: a buffer beyond the trigger on the exit side, at least one tick away. */
export function stopLimitFor(sl, long, tick = 0.05) {
  const buffered = roundTick(long ? sl * (1 - SL_LIMIT_BUFFER) : sl * (1 + SL_LIMIT_BUFFER), tick);
  return long ? Math.max(tick, Math.min(buffered, roundTick(sl - tick, tick))) : Math.max(buffered, roundTick(sl + tick, tick));
}

/** Check a new target / stop against the side and the current price. Returns an error message or null. */
export function checkLevels({ long, ltp, tp, sl }) {
  for (const [name, v] of [['Target', tp], ['Stop-loss', sl]]) if (v != null && !(Number.isFinite(v) && v > 0)) return `${name} must be a positive price.`;
  if (tp != null && sl != null && (long ? tp <= sl : tp >= sl)) return long ? 'The target must be above the stop-loss.' : 'The target must be below the stop-loss.';
  if (!(ltp > 0)) return null;
  if (sl != null && (long ? sl >= ltp : sl <= ltp)) return long ? `Stop-loss must be below the current price (${ltp}).` : `Stop-loss must be above the current price (${ltp}).`;
  if (tp != null && (long ? tp <= ltp : tp >= ltp)) return long ? `Target must be above the current price (${ltp}).` : `Target must be below the current price (${ltp}).`;
  return null;
}
/** Has the price reached the target (or, with no stop order at the broker, the stop)? 'tp' | 'sl' | null */
export function triggered({ long, ltp, tp, sl, slAtBroker }) {
  if (!(ltp > 0)) return null;
  if (tp != null && (long ? ltp >= tp : ltp <= tp)) return 'tp';
  if (!slAtBroker && sl != null && (long ? ltp <= sl : ltp >= sl)) return 'sl';
  return null;
}

const positionOf = (userId, securityId) => getBook(userId).positions.find(p => String(p.securityId) === String(securityId) && p.qty !== 0) || null;
/** Live price: the feed's tick if fresh, else from the broker's own unrealized P&L on the last sync. */
export function priceOf(userId, pos) {
  const t = liveTick(userId, `${pos.exchangeSegment}:${pos.securityId}`, { since: Date.now() - TICK_FRESH_MS });
  if (t?.ltp > 0) return t.ltp;
  if (pos.ltp > 0) return pos.ltp;
  const per = pointValue(pos.exchangeSegment, pos.symbol) * pos.qty;
  return per && Number.isFinite(pos.unrealized) && pos.avg > 0 ? Math.round((pos.avg + pos.unrealized / per) * 100) / 100 : null;
}
async function tickOf(pos) {
  try {
    const exch = String(pos.exchangeSegment).split('_')[0];
    return (await indexOptionInstruments()).get(`${exch}:${pos.securityId}`)?.meta?.tickSize || 0.05;
  } catch { return 0.05; }
}
const algoManaged = (userId, securityId) => !!stmt(`SELECT 1 FROM auto_trades WHERE user_id = ? AND security_id = ? AND status IN ('placing', 'open', 'closing') LIMIT 1`).get(userId, String(securityId));
const legsOf = id => String(id || '').split(',').filter(Boolean);
const pendingAtBroker = (userId, id) => { const open = new Set((getBook(userId).orders || []).map(o => String(o.id))); return legsOf(id).some(l => open.has(l)); };

async function placeStop(adapter, pos, sl, tick) {
  const long = pos.qty > 0, qty = Math.abs(pos.qty);
  const order = { side: long ? 'SELL' : 'BUY', qty, type: 'STOP_LOSS', triggerPrice: sl, price: stopLimitFor(sl, long, tick),
    securityId: pos.securityId, exchangeSegment: pos.exchangeSegment, productType: pos.productType, symbol: pos.symbol };
  try { return (await adapter.placeOrder(order)).id; }
  catch (e) { if (qty > 900 && !['TOKEN_EXPIRED', 'NETWORK'].includes(e?.code)) return (await adapter.placeOrder({ ...order, slice: true })).id; throw e; }
}

/**
 * Set (or clear with null) the target and stop of an open position. Places, moves or cancels the stop order at the
 * broker. Returns the saved bracket (or null when both are cleared).
 */
export async function setBracket(userId, acct, { securityId, tp = null, sl = null }, ip = null) {
  const pos = positionOf(userId, securityId);
  if (!pos) throw bad('NO_POSITION', 'There is no open position in this contract.');
  if (algoManaged(userId, securityId)) throw bad('ALGO_MANAGED', 'This position belongs to Algo Trading, which manages its own stop-loss and exit.');
  const long = pos.qty > 0, tick = await tickOf(pos), adapter = BROKER.adapterFor(acct);
  if (tp != null) tp = roundTick(Number(tp), tick);
  if (sl != null) sl = roundTick(Number(sl), tick);
  const problem = checkLevels({ long, ltp: priceOf(userId, pos), tp, sl });
  if (problem) throw bad('BRACKET_LEVEL', problem);

  const cur = bracketOf(userId, securityId), qty = Math.abs(pos.qty);
  let slOrderId = cur?.slOrderId && cur.side === Math.sign(pos.qty) ? cur.slOrderId : null;
  try {
    if (sl == null && slOrderId) { await adapter.cancelOrder(slOrderId).catch(() => {}); slOrderId = null; }
    else if (sl != null) {
      if (slOrderId && pendingAtBroker(userId, slOrderId) && adapter.modifyStopLoss) {
        try { await adapter.modifyStopLoss(slOrderId, { triggerPrice: sl, price: stopLimitFor(sl, long, tick), qty }); }
        catch { await adapter.cancelOrder(slOrderId).catch(() => {}); slOrderId = await placeStop(adapter, pos, sl, tick); }
      } else slOrderId = await placeStop(adapter, pos, sl, tick);
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, 'BROKER_REJECTED', `Broker rejected the stop-loss order: ${e.message}`);
  }
  if (tp == null && sl == null) { dropBracket(userId, securityId); markDirty(userId); audit(userId, 'bracket.cleared', { symbol: pos.symbol }, ip); return null; }
  const b = { securityId: String(pos.securityId), segment: pos.exchangeSegment, symbol: pos.symbol, side: Math.sign(pos.qty), qty, tp, sl, slOrderId };
  saveBracket(userId, b); markDirty(userId);
  audit(userId, 'bracket.set', { symbol: pos.symbol, tp, sl, slOrderId }, ip);
  return bracketOf(userId, securityId);
}

/** Cancel the stop order and wait until the broker confirms: 'cancelled' (with any part filled), 'filled' or 'unknown'. */
async function cancelConfirmed(adapter, id) {
  await adapter.cancelOrder(id).catch(() => {});
  for (let i = 0; i < 6; i++) {
    const s = await adapter.orderStatus?.(id).catch(() => null);
    if (s?.status === 'failed') return { state: 'cancelled', filledQty: Number(s.filledQty) || 0 };
    if (s?.status === 'filled') return { state: 'filled' };
    await sleep(400);
  }
  return { state: 'unknown' };
}

// Outside NSE hours the account sync slows to every 5 minutes, but MCX trades until 23:55: while a user has an MCX
// bracket in its session, this loop reads fresh positions and orders from the broker every 2 seconds and watches them.
const MCX_OPEN = 9 * 60, MCX_CLOSE = 23 * 60 + 55;
export const mcxSessionOpen = (at = Date.now()) => {
  const local = new Date(at + 330 * 60_000), day = local.getUTCDay(), m = local.getUTCHours() * 60 + local.getUTCMinutes();
  return day > 0 && day < 6 && m >= MCX_OPEN && m < MCX_CLOSE;
};
export function startBracketWatcher({ everyMs = 2_000, nseOpen, accountFor, usersWithBrackets }) {
  const timer = setInterval(async () => {
    if (nseOpen() || !mcxSessionOpen()) return;   // NSE hours: the account sync (every 2 s) already watches brackets
    for (const uid of usersWithBrackets()) {
      if (!bracketsFor(uid).some(b => /^MCX/.test(b.segment))) continue;
      const acct = accountFor(uid);
      if (!acct || busy.has(uid)) continue;
      try {
        const snap = await BROKER.adapterFor(acct).snapshot({ funds: false });
        setBookLive(uid, snap);
        await watchBrackets(uid, acct);
      } catch (e) { console.error('[brackets] mcx', e.message); }
    }
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
// Fresh positions and working orders from the broker, so the checks (and the screen) use them.
function setBookLive(uid, snap) {
  const prev = getBook(uid);
  setBook(uid, { ...prev, positions: snap.positions, orders: snap.orders ?? prev.orders, at: Date.now() });
  markDirty(uid);
}

const busy = new Set();
/**
 * Every sync / tick for a user with brackets: drop brackets whose position closed, resize the stop after a partial
 * exit, and exit at the target (or at a stop that has no order at the broker).
 */
export async function watchBrackets(userId, acct) {
  const rows = bracketsFor(userId);
  if (!rows.length || busy.has(userId)) return;
  busy.add(userId);
  try {
    const adapter = BROKER.adapterFor(acct);
    for (const b of rows) {
      const pos = positionOf(userId, b.securityId);
      if (!pos || Math.sign(pos.qty) !== b.side) {
        // Closed: the stop filled, the user exited, or a limit closed it. A stop order still resting would open a new position.
        if (b.slOrderId && pendingAtBroker(userId, b.slOrderId)) await adapter.cancelOrder(b.slOrderId).catch(() => {});
        dropBracket(userId, b.securityId); markDirty(userId);
        continue;
      }
      const qty = Math.abs(pos.qty), long = pos.qty > 0;
      if (b.slOrderId && qty !== b.qty && adapter.modifyStopLoss) {
        const tick = await tickOf(pos);
        await adapter.modifyStopLoss(b.slOrderId, { triggerPrice: b.sl, price: stopLimitFor(b.sl, long, tick), qty }).catch(() => {});
        saveBracket(userId, { ...b, qty });
      }
      const ltp = priceOf(userId, pos), hit = triggered({ long, ltp, tp: b.tp, sl: b.sl, slAtBroker: !!b.slOrderId });
      if (!hit) continue;
      let exitQty = qty;
      if (b.slOrderId) {
        const c = await cancelConfirmed(adapter, b.slOrderId);
        if (c.state === 'filled') { dropBracket(userId, b.securityId); markDirty(userId); continue; }   // the stop got there first
        if (c.state === 'unknown') {
          notify(userId, { kind: 'risk', level: 'critical', title: `Target reached on ${pos.symbol}: not exited`, body: `The stop-loss order at your broker could not be confirmed cancelled, so TradeLock did not send the exit (it could sell twice). Check the position in your broker app.` });
          continue;
        }
        exitQty = Math.max(0, qty - c.filledQty);
      }
      if (exitQty > 0) await adapter.exitPosition({ ...pos, qty: Math.sign(pos.qty) * exitQty });
      dropBracket(userId, b.securityId); markDirty(userId);
      const what = hit === 'tp' ? `Target ${b.tp}` : `Stop-loss ${b.sl}`;
      audit(userId, hit === 'tp' ? 'bracket.target_hit' : 'bracket.stop_hit', { symbol: pos.symbol, ltp, tp: b.tp, sl: b.sl });
      notify(userId, { kind: 'risk', level: hit === 'tp' ? 'ok' : 'warn', title: `${what} reached on ${pos.symbol}`, body: `Exited ${exitQty} at market (price ${ltp}).` });
    }
  } catch (e) { console.error('[brackets]', e.message); }
  finally { busy.delete(userId); }
}
