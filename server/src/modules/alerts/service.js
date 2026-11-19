// Price alerts from the Power Scalper chart ("+" → Alert at this price). Checked on every live tick of the contract
// (the user's market feed, live.js); when the price reaches the level the alert fires once: a notification, a push to
// open screens (SSE "alert": sound + browser notification, the Android app's alarm when open), and the Android app's
// background service rings for it on its next poll (/api/algo/entries → alerts).
import { stmt } from '../../db/index.js';
import { bad, notFound } from '../../lib/errors.js';
import { emit } from '../../lib/bus.js';
import { notify } from '../notifications/service.js';
import { markDirty } from '../broker/book.js';
import { ist } from '../../lib/time.js';

const MAX_ACTIVE = 50, KEEP_DAYS = 7;
const row = r => r && ({ id: r.id, segment: r.segment, securityId: r.security_id, symbol: r.symbol, price: r.price, dir: r.dir,
  createdAt: r.created_at, triggeredAt: r.triggered_at, triggeredPrice: r.triggered_price, ...(r.order_json ? { order: JSON.parse(r.order_json) } : {}) });
// The start of today (IST), as a timestamp: alerts that carry an order are for the day they were set, like a DAY order.
const todayStart = () => Date.parse(`${ist().day}T00:00:00+05:30`);

/** Active (not yet fired) alerts of a user. An order alert from an earlier day is dropped (never buys on another day). */
export function activeAlerts(userId) {
  stmt('DELETE FROM price_alerts WHERE user_id = ? AND triggered_at IS NULL AND order_json IS NOT NULL AND created_at < ?').run(userId, todayStart());
  return stmt('SELECT * FROM price_alerts WHERE user_id = ? AND triggered_at IS NULL ORDER BY id').all(userId).map(row);
}
// In memory per user for the tick check (ticks can come many times a second); dropped on every change.
const cache = new Map();
const cached = userId => { let a = cache.get(userId); if (!a) { a = activeAlerts(userId); cache.set(userId, a); } return a; };
const forget = userId => { cache.delete(userId); markDirty(userId); };   // and push the dashboard (the chart's markers)
/** Fired alerts newer than `afterId` (for the Android app's alarm). */
export const firedAlertsAfter = (userId, afterId) => stmt('SELECT * FROM price_alerts WHERE user_id = ? AND triggered_at IS NOT NULL AND id > ? ORDER BY id LIMIT 10').all(userId, afterId).map(row);
export const lastAlertId = userId => stmt('SELECT COALESCE(MAX(id), 0) AS id FROM price_alerts WHERE user_id = ?').get(userId).id;
/** Feed keys ("MCX_COMM:123") the user's active alerts need. */
export const alertKeys = userId => new Set(activeAlerts(userId).map(a => `${a.segment}:${a.securityId}`));

/**
 * A new alert; dir from the current price (at or above it: rings on the way up, else on the way down). `order` (optional):
 * placed when it fires (see placeFromAlert).
 */
export function createAlert(userId, { segment, securityId, symbol, price, ltp, order = null }) {
  if (!(price > 0)) throw bad('ALERT_PRICE', 'Choose a price for the alert.');
  if (stmt('SELECT COUNT(*) AS n FROM price_alerts WHERE user_id = ? AND triggered_at IS NULL').get(userId).n >= MAX_ACTIVE) throw bad('ALERT_LIMIT', `Up to ${MAX_ACTIVE} alerts at a time. Remove some first.`);
  stmt('DELETE FROM price_alerts WHERE user_id = ? AND created_at < ?').run(userId, Date.now() - KEEP_DAYS * 86_400_000);
  const dir = ltp > 0 && price < ltp ? 'below' : 'above';
  const { lastInsertRowid } = stmt('INSERT INTO price_alerts (user_id, segment, security_id, symbol, price, dir, created_at, order_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(userId, segment, String(securityId), symbol, price, dir, Date.now(), order ? JSON.stringify(order) : null);
  forget(userId);
  return row(stmt('SELECT * FROM price_alerts WHERE id = ?').get(lastInsertRowid));
}
export function moveAlert(userId, id, { price, ltp }) {
  const cur = stmt('SELECT * FROM price_alerts WHERE id = ? AND user_id = ? AND triggered_at IS NULL').get(id, userId);
  if (!cur) throw notFound('That alert has already fired or was removed.');
  if (!(price > 0)) throw bad('ALERT_PRICE', 'Choose a price for the alert.');
  const dir = ltp > 0 ? (price < ltp ? 'below' : 'above') : cur.dir;
  stmt('UPDATE price_alerts SET price = ?, dir = ? WHERE id = ?').run(price, dir, id);
  forget(userId);
  return row(stmt('SELECT * FROM price_alerts WHERE id = ?').get(id));
}
export function deleteAlert(userId, id) { stmt('DELETE FROM price_alerts WHERE id = ? AND user_id = ? AND triggered_at IS NULL').run(id, userId); forget(userId); }

/** Has the price reached the alert? (on the way up for 'above', down for 'below') */
export const reached = (alert, ltp) => ltp > 0 && (alert.dir === 'above' ? ltp >= alert.price : ltp <= alert.price);

/** A tick for `key`: fire every active alert of that contract the price has reached. Returns the fired alerts. */
export function checkAlerts(userId, key, ltp, now = Date.now()) {
  const fired = [];
  for (const a of cached(userId)) {
    if (`${a.segment}:${a.securityId}` !== key || !reached(a, ltp)) continue;
    // An order alert set on an earlier day never fires (the cache can outlive midnight): it is dropped instead.
    if (a.order && a.createdAt < todayStart()) { stmt('DELETE FROM price_alerts WHERE id = ? AND triggered_at IS NULL').run(a.id); forget(userId); continue; }
    const done = stmt('UPDATE price_alerts SET triggered_at = ?, triggered_price = ? WHERE id = ? AND triggered_at IS NULL').run(now, ltp, a.id);
    if (!done.changes) continue;   // another tick fired it a moment ago
    forget(userId);
    const hit = { ...a, triggeredAt: now, triggeredPrice: ltp };
    fired.push(hit);
    if (a.order) placeFromAlert(userId, hit).catch(e => console.error('[alerts] order', e.message));
    else notify(userId, { kind: 'risk', level: 'warn', title: `Price alert: ${a.symbol} ${a.dir === 'above' ? '≥' : '≤'} ${a.price}`, body: `${a.symbol} traded at ${ltp}.` });
    emit(userId, 'alert', hit);
  }
  return fired;
}

/**
 * The index reached the level of an alert that carries an order: buy that contract now, at market, through the same
 * path as the ticket (risk gate, kill switch, one trade at a time, Super Order...). The result, placed or refused, is a
 * notification. Hooks for tests: ALERT_ORDER.place.
 */
export const ALERT_ORDER = { place: async (userId, body) => (await import('../orders/routes.js')).placeOrderFor(userId, body, 'alert') };
export async function placeFromAlert(userId, a) {
  const o = a.order, when = `${a.symbol} ${a.dir === 'above' ? 'rose to' : 'fell to'} ${a.triggeredPrice ?? a.price}`;
  const lots = o.lots ? `${o.lots} lot${o.lots === 1 ? '' : 's'}` : `${o.qty} qty`;
  try {
    await ALERT_ORDER.place(userId, { symbol: o.symbol, securityId: o.securityId, exchangeSegment: o.segment, side: o.side || 'BUY', qty: o.qty, type: 'MARKET', productType: 'INTRADAY' });
    notify(userId, { kind: 'risk', level: 'warn', title: `Bought ${lots} ${o.symbol}`, body: `${when}: your index order was sent at market.` });
    return { placed: true };
  } catch (e) {
    notify(userId, { kind: 'risk', level: 'critical', title: `Index order not placed: ${o.symbol}`, body: `${when}, but the buy of ${lots} was refused: ${e.message}` });
    return { placed: false, reason: e.message };
  }
}
