// Each trading broker (Dhan, or StoxKart linked on top of it) keeps its own settings and its own P&L: the Protection
// and Algo Trading switches, the strategy choices, the day's risk state, the P&L curve, the trade list and the P&L
// calendar history. The live tables hold the trading broker's copy; switching brokers parks it in broker_stash and
// brings back the other broker's (or a fresh start, everything off).
import { stmt, tx, flushWrites } from '../../db/index.js';

export const FLAGS = ['agent_on', 'algo_on', 'cross_on', 'orb_on', 'gap_on', 'ema915_on', 'manual_on', 'gap_lock', 'gap_auto_exit', 'retest_paper_on', 'algo_underlying', 'strangle_on', 'algo_grid'];
const FRESH = { agent_on: 0, algo_on: 0, cross_on: 0, orb_on: 0, gap_on: 0, ema915_on: 0, manual_on: 1, gap_lock: 1, gap_auto_exit: 1, retest_paper_on: 0, algo_underlying: 'NIFTY', strangle_on: 0, algo_grid: null };
// Tables whose rows belong to the trading broker. trades.id is a plain rowid, so it is reassigned on the way back.
const TABLES = ['day_state', 'pnl_points', 'trades', 'broker_fills', 'broker_pnl_days', 'broker_sync'];
const NEW_ID = { trades: 'id' };

export const tradingBroker = acct => (acct?.paper_mode === 1 ? 'paper' : acct?.trade_via === 'stoxkart' ? 'stoxkart' : acct?.broker);

const putStash = (userId, broker, kind, data) => stmt(`INSERT INTO broker_stash (user_id, broker, kind, data, saved_at) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(user_id, broker, kind) DO UPDATE SET data = excluded.data, saved_at = excluded.saved_at`).run(userId, broker, kind, JSON.stringify(data), Date.now());
const takeStash = (userId, broker, kind) => {
  const r = stmt('SELECT data FROM broker_stash WHERE user_id = ? AND broker = ? AND kind = ?').get(userId, broker, kind);
  if (r) stmt('DELETE FROM broker_stash WHERE user_id = ? AND broker = ? AND kind = ?').run(userId, broker, kind);
  return r ? JSON.parse(r.data) : null;
};

/**
 * Park `from`'s settings and P&L rows and restore `to`'s, in one transaction. `keep(table, row)` (optional) leaves a
 * row in the live tables instead of parking it (used once to split a day that mixed both brokers).
 */
export function swapBrokerState(acct, from, to, { keep } = {}) {
  const userId = acct.user_id;
  flushWrites();   // queued live-P&L writes belong to the broker being parked
  tx(() => {
    putStash(userId, from, 'flags', Object.fromEntries(FLAGS.map(k => [k, acct[k]])));
    for (const t of TABLES) {
      const rows = stmt(`SELECT * FROM ${t} WHERE user_id = ?`).all(userId);
      const park = keep ? rows.filter(r => !keep(t, r)) : rows;
      putStash(userId, from, t, park);
      if (keep && park.length < rows.length) {
        const kept = new Set(rows.filter(r => keep(t, r)));
        stmt(`DELETE FROM ${t} WHERE user_id = ?`).run(userId);
        for (const r of kept) insertRow(t, r);
      } else stmt(`DELETE FROM ${t} WHERE user_id = ?`).run(userId);
    }
    const flags = { ...FRESH, ...(takeStash(userId, to, 'flags') || {}) };
    stmt(`UPDATE broker_accounts SET ${FLAGS.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...FLAGS.map(k => flags[k]), acct.id);
    for (const t of TABLES) for (const r of takeStash(userId, to, t) || []) insertRow(t, r, { fresh: true });
  })();
}

function insertRow(table, row, { fresh = false } = {}) {
  const cols = Object.keys(row).filter(c => !(fresh && NEW_ID[table] === c));
  stmt(`INSERT OR IGNORE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map(c => row[c]));
}
