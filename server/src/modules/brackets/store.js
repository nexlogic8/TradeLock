// Take-profit / stop-loss set on a position from the Power Scalper chart (one row per user and contract).
// Read by the dashboard (shown on the chart) and by the bracket watcher; written by brackets/service.js.
// superId: the position was entered as a Dhan Super Order; its target / stop-loss are legs of that order at Dhan.
import { stmt } from '../../db/index.js';

/** [{ securityId, segment, symbol, side (1 long / -1 short), qty, tp, sl, slOrderId, superId, updatedAt }] */
export function bracketsFor(userId) {
  return stmt('SELECT * FROM position_brackets WHERE user_id = ?').all(userId).map(r => ({
    securityId: r.security_id, segment: r.segment, symbol: r.symbol, side: r.side, qty: r.qty,
    tp: r.tp, sl: r.sl, slOrderId: r.sl_order_id, superId: r.super_id ?? null, updatedAt: r.updated_at,
  }));
}
export const bracketOf = (userId, securityId) => bracketsFor(userId).find(b => b.securityId === String(securityId)) || null;

export function saveBracket(userId, b) {
  stmt(`INSERT INTO position_brackets (user_id, security_id, segment, symbol, side, qty, tp, sl, sl_order_id, super_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (user_id, security_id) DO UPDATE SET segment = excluded.segment, symbol = excluded.symbol, side = excluded.side,
          qty = excluded.qty, tp = excluded.tp, sl = excluded.sl, sl_order_id = excluded.sl_order_id, super_id = excluded.super_id,
          updated_at = excluded.updated_at`)
    .run(userId, String(b.securityId), b.segment, b.symbol, b.side, b.qty, b.tp ?? null, b.sl ?? null, b.slOrderId ?? null, b.superId ?? null, Date.now());
}
export const dropBracket = (userId, securityId) => stmt('DELETE FROM position_brackets WHERE user_id = ? AND security_id = ?').run(userId, String(securityId));
export const usersWithBrackets = () => stmt('SELECT DISTINCT user_id AS id FROM position_brackets').all().map(r => r.id);
