// Live P&L from the market feed (WebSocket ticks), for NSE, BSE and MCX positions alike.
// The broker sync (every 2 s) gives the positions: quantity, average and realized P&L. Their open P&L is then
// recomputed on every tick of their contracts and pushed to the user's screens (SSE "pnl", up to 4 a second),
// and the intraday P&L curve is recorded from it. Risk rules keep using the broker's own figures (monitor.js).
import { getBook } from '../broker/book.js';
import { emit, hasListeners } from '../../lib/bus.js';
import { ist } from '../../lib/time.js';
import { config } from '../../config.js';
import { liveTick, positionsWatch, onTick, broadcastScalperUser } from '../scalper/live.js';
import { recordPoint, algoSecurityIds, algoPnlOf } from './service.js';
import { mcxLotValue, estimateCharges } from './charges.js';
import { fillsForDay } from '../trades/service.js';
import { stmt } from '../../db/index.js';
import { activeAlerts, alertKeys, checkAlerts } from '../alerts/service.js';

const FLUSH_MS = 250, TICK_FRESH_MS = 60_000, FRESH_MS = 5_000;
const state = new Map();   // userId -> { keys, snap, algoIds }
const dirty = new Set();

/** Rupees per point per unit of quantity: MCX positions count lots (CRUDEOIL 100, CRUDEOILM 10, GOLD 100…), else 1. */
export const pointValue = p => (/^MCX/.test(String(p.exchangeSegment || '')) ? mcxLotValue(p.symbol) : 1);
const keyOf = p => `${p.exchangeSegment}:${p.securityId}`;

/**
 * P&L of a book with live prices: realized as the broker reports it; open positions at the latest tick
 * ((ltp − avg) × qty × point value), or the broker's own figure when there is no fresh tick.
 * ltpOf(position) → price or null.
 */
export function livePnlOf(positions, ltpOf) {
  let realized = 0, unrealized = 0;
  const rows = {};
  for (const p of positions || []) {
    realized += Number(p.realized) || 0;
    if (!p.qty) continue;
    const ltp = ltpOf(p), live = ltp > 0 && p.avg > 0;
    const u = live ? (ltp - p.avg) * p.qty * pointValue(p) : Number(p.unrealized) || 0;
    unrealized += u;
    rows[String(p.securityId)] = { ltp: live ? ltp : null, unrealized: Math.round(u * 100) / 100 };
  }
  return { realized: Math.round(realized * 100) / 100, unrealized: Math.round(unrealized * 100) / 100, pnl: Math.round((realized + unrealized) * 100) / 100, positions: rows };
}

/** After each broker sync: follow this user's open contracts on the feed (none open: stop). */
export function trackPositions(userId) {
  // The feed follows open positions (live P&L), contracts with a price alert (alerts/service.js) and the contracts of
  // pending orders that TradeLock matches itself (paper limits and stops carry their segment), so they fill on time
  // with no screen open: the REST quote fallback is rate-limited.
  const book = getBook(userId), open = book.positions.filter(p => p.qty !== 0);
  const resting = (book.orders || []).filter(o => o.exchangeSegment && o.securityId);
  const keys = new Set([...open.map(keyOf), ...resting.map(keyOf), ...alertKeys(userId)]);
  const st = state.get(userId) || { keys: new Set(), snap: null };
  const same = keys.size === st.keys.size && [...keys].every(k => st.keys.has(k));
  if (!same) { try { positionsWatch(userId, keys); } catch (e) { console.error('[live-pnl] watch', e.message); } st.keys = keys; }
  if (!keys.size && !open.length) { state.delete(userId); return; }
  state.set(userId, st);
  dirty.add(userId);
}

// Today's charges, estimated from today's fills (charges.js), recomputed only when a new fill arrives.
const chargeCache = new Map();   // userId -> { day, count, value }
export function chargesToday(userId, day = ist().day) {
  const count = stmt(`SELECT COUNT(*) AS n FROM trades WHERE user_id = ? AND day = ? AND kind = 'exec'`).get(userId, day).n;
  const hit = chargeCache.get(userId);
  if (hit && hit.day === day && hit.count === count) return hit.value;
  const value = count ? estimateCharges(fillsForDay(userId, day)) : { total: 0, orders: 0 };
  chargeCache.set(userId, { day, count, value });
  return value;
}

/** The latest live figures for the dashboard (null when not fresh: the broker's numbers are shown instead). */
export function livePnl(userId) {
  const s = state.get(userId)?.snap;
  return s && Date.now() - s.at < FRESH_MS ? s : null;
}

function flush(now = Date.now()) {
  const t = ist(now);
  for (const userId of dirty) {
    dirty.delete(userId);
    const st = state.get(userId);
    if (!st) continue;
    const book = getBook(userId);
    // Before 09:15 the broker still lists yesterday's closed positions: only what is still open counts.
    const positions = t.minutes < config.market.open ? book.positions.filter(p => p.qty !== 0) : book.positions;
    const v = livePnlOf(positions, p => liveTick(userId, keyOf(p), { since: now - TICK_FRESH_MS })?.ltp ?? null);
    const prev = st.snap, charges = chargesToday(userId, t.day).total;
    st.snap = { ...v, charges, net: Math.round((v.pnl - charges) * 100) / 100, at: now };
    if (prev && prev.pnl === v.pnl && prev.unrealized === v.unrealized) continue;
    if (hasListeners(userId)) emit(userId, 'pnl', st.snap);
    if (t.minutes >= config.market.open) {
      // The intraday curve: the last value of each minute, from ticks (the Algo part from its own contracts).
      if (!st.algoIds || st.algoIds.day !== t.day || now - st.algoIds.at > 10_000) st.algoIds = { day: t.day, at: now, ids: algoSecurityIds(userId, t.day) };
      const algo = algoPnlOf(positions.map(p => ({ ...p, unrealized: v.positions[String(p.securityId)]?.unrealized ?? p.unrealized })), st.algoIds.ids);
      recordPoint(userId, t.day, t.minutes, v.pnl, algo, charges);
    }
  }
}

export function startLivePnl() {
  const off = onTick((userId, key, tick) => {
    if (!state.get(userId)?.keys.has(key)) return;
    dirty.add(userId);
    if (tick?.ltp > 0) { try {
      if (checkAlerts(userId, key, tick.ltp).length) {
        trackPositions(userId);
        broadcastScalperUser(userId, { type: 'alerts', alerts: activeAlerts(userId) });
      }
    } catch (e) { console.error('[alerts]', e.message); } }
  });
  const timer = setInterval(() => { try { flush(); } catch (e) { console.error('[live-pnl]', e.message); } }, FLUSH_MS);
  timer.unref?.();
  return () => { off(); clearInterval(timer); };
}
