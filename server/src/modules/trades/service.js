import { stmt, tx } from '../../db/index.js';
import { ist } from '../../lib/time.js';

/** Store broker fills; already-seen ids are ignored, so this is safe to call on every sync. */
export const upsertFills = tx((userId, fills) => {
  const ins = stmt(`
    INSERT OR IGNORE INTO trades (user_id, day, ts, kind, ext_id, symbol, side, qty, price, pnl, status, order_id)
    VALUES (?, ?, ?, 'exec', ?, ?, ?, ?, ?, ?, 'COMPLETE', ?)`);
  for (const f of fills) ins.run(userId, ist(f.ts).day, f.ts, f.id, f.symbol, f.side, f.qty, f.price, f.pnl ?? null, f.orderId ?? null);
});

export const fillsForDay = (userId, day) =>
  stmt(`SELECT symbol, side, qty, price, ts, order_id AS orderId FROM trades WHERE user_id = ? AND day = ? AND kind = 'exec' ORDER BY ts, id`).all(userId, day);

export const closedStats = (userId, day) =>
  stmt(`SELECT COALESCE(SUM(pnl > 0), 0) AS wins, COALESCE(SUM(pnl < 0), 0) AS losses
        FROM trades WHERE user_id = ? AND day = ? AND kind = 'exec' AND pnl IS NOT NULL`).get(userId, day);

export function logRiskEvent(userId, day, trig) {
  stmt(`INSERT OR IGNORE INTO trades (user_id, day, ts, kind, ext_id, symbol, side, status, note)
        VALUES (?, ?, ?, 'event', ?, ?, ?, 'LOGGED', ?)`)
    .run(userId, day, Date.now(), `evt:${day}:${trig.id}`, trig.title, trig.level === 'breach' ? 'LIMIT' : 'ALERT', trig.body);
}

/**
 * One row per broker order: the exchange often fills a big order in many pieces (freeze quantity,
 * liquidity). Pieces are merged into total quantity, average price and a fill count. Fills saved
 * before order ids were kept are grouped by symbol, side and second.
 */
export function groupFills(rows) {
  const out = [];
  const byOrder = new Map();
  for (const r of rows) {
    if (r.kind !== 'exec') { out.push(r); continue; }
    const key = r.order_id ? `o:${r.order_id}` : `t:${r.symbol}|${r.side}|${Math.floor(r.ts / 1000)}`;
    const g = byOrder.get(key);
    if (!g) {
      const row = { ...r, fills: 1, value: r.qty * r.price };
      delete row.order_id;
      byOrder.set(key, row);
      out.push(row);
      continue;
    }
    g.fills++;
    g.qty += r.qty;
    g.value += r.qty * r.price;
    g.price = Math.round((g.value / g.qty) * 100) / 100;
    if (r.pnl != null) g.pnl = (g.pnl ?? 0) + r.pnl;
  }
  for (const r of out) delete r.value;
  return out;
}

export function listTrades(userId, day) {
  const rows = groupFills(stmt(`SELECT id, ts, kind, symbol, side, qty, price, pnl, status, note, order_id FROM trades
                     WHERE user_id = ? AND day = ? ORDER BY ts, id`).all(userId, day));
  const s = stmt('SELECT realized, unrealized FROM day_state WHERE user_id = ? AND day = ?').get(userId, day) || { realized: 0, unrealized: 0 };
  return { day, rows, summary: { realized: s.realized, unrealized: s.unrealized, net: s.realized + s.unrealized } };
}
