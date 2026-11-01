// P&L calendar from the broker's own records. Dhan has no "daily P&L" API, but its trade history
// lists every fill with charges, so each day's realised P&L is rebuilt here: fills are matched
// first-in-first-out per instrument (long and short), charges are summed per day, and option lots
// still open after expiry are closed at zero on the expiry day (they expired worthless).
import { stmt, tx } from '../../db/index.js';
import { ist } from '../../lib/time.js';
import { accountFor, adapterFor } from '../broker/registry.js';

export const BACKFILL_DAYS = 180;   // first sync goes this far back
const CHUNK_DAYS = 30;              // ask Dhan for at most a month at a time
const OVERLAP_DAYS = 5;             // later syncs re-read the last few days (late fills, corrections)
const MIN_GAP_MS = 60e3;            // manual syncs: at most one a minute

const istDay = ts => new Date(ts + 330 * 60e3).toISOString().slice(0, 10);
export function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const round = v => Math.round(v * 100) / 100;

/**
 * Per-day results from fills (any order). Pure, so it is easy to test.
 * @returns Map day → { gross, charges, trades, wins, losses }
 */
export function dailyPnl(fills, today = ist().day) {
  const days = new Map();
  const dayOf = d => {
    if (!days.has(d)) days.set(d, { gross: 0, charges: 0, orders: new Set(), inst: new Map() });
    return days.get(d);
  };
  const book = (d, inst, v) => { const x = dayOf(d); x.inst.set(inst, (x.inst.get(inst) || 0) + v); };
  const lots = new Map();   // inst → [{ qty (signed: + long, − short), price }], oldest first
  const meta = new Map();   // inst → { option, expiry }

  for (const f of [...fills].sort((a, b) => a.ts - b.ts)) {
    const day = f.day || istDay(f.ts);
    const x = dayOf(day);
    x.charges += f.charges || 0;
    x.orders.add(f.orderId || f.id || f.ext_id);
    meta.set(f.inst, { option: !!f.option, expiry: f.expiry || null });
    const open = lots.get(f.inst) || [];
    let q = f.side === 'BUY' ? f.qty : -f.qty;
    let realized = 0;
    while (q !== 0 && open.length && Math.sign(open[0].qty) !== Math.sign(q)) {
      const lot = open[0];
      const m = Math.min(Math.abs(q), Math.abs(lot.qty));
      realized += lot.qty > 0 ? m * (f.price - lot.price) : m * (lot.price - f.price);
      lot.qty -= Math.sign(lot.qty) * m;
      q -= Math.sign(q) * m;
      if (lot.qty === 0) open.shift();
    }
    if (q !== 0) open.push({ qty: q, price: f.price });
    lots.set(f.inst, open);
    if (realized) book(day, f.inst, realized);
  }

  // Options held past expiry with no closing trade: expired worthless.
  for (const [inst, open] of lots) {
    const m = meta.get(inst);
    if (!m?.option || !m.expiry || m.expiry >= today || !open.length) continue;
    // Long: the premium paid is lost (−qty × price). Short: the premium received is kept (same formula, qty < 0).
    book(m.expiry, inst, open.reduce((a, l) => a - l.qty * l.price, 0));
  }

  const out = new Map();
  for (const [day, x] of days) {
    const per = [...x.inst.values()];
    const gross = per.reduce((a, v) => a + v, 0);
    out.set(day, {
      gross: round(gross),
      charges: round(x.charges),
      trades: x.orders.size,
      wins: per.filter(v => v > 0.005).length,
      losses: per.filter(v => v < -0.005).length,
    });
  }
  return out;
}

const running = new Map();

/** Fetch new fills from the broker and rebuild this user's daily P&L. Safe to call often. */
export function syncBrokerPnl(userId, { manual = false, now = Date.now() } = {}) {
  if (running.has(userId)) return running.get(userId);
  const job = (async () => {
    const acct = accountFor(userId);
    if (!acct || acct.status === 'disconnected' || !acct.token_enc) return { skipped: 'no broker' };
    const adapter = adapterFor(acct);
    if (typeof adapter.tradeHistory !== 'function') return { skipped: 'broker has no trade history' };
    const state = stmt('SELECT * FROM broker_sync WHERE user_id = ?').get(userId);
    if (manual && state?.last_at && now - state.last_at < MIN_GAP_MS && state.status === 'ok') return { skipped: 'recent', state };

    const today = ist(now).day;
    const broker = acct.trade_via === 'stoxkart' ? 'stoxkart' : acct.broker;
    const first = !state || state.broker !== broker;
    const from = first ? addDays(today, -BACKFILL_DAYS) : addDays(state.last_day || today, -OVERLAP_DAYS);
    stmt(`INSERT INTO broker_sync (user_id, broker, from_day, status) VALUES (?, ?, ?, 'running')
          ON CONFLICT(user_id) DO UPDATE SET status = 'running', error = NULL,
            broker = excluded.broker, from_day = CASE WHEN broker_sync.broker = excluded.broker THEN broker_sync.from_day ELSE excluded.from_day END`)
      .run(userId, broker, from);
    if (first) {   // a different broker account: its history replaces the old one
      stmt('DELETE FROM broker_fills WHERE user_id = ?').run(userId);
      stmt('DELETE FROM broker_pnl_days WHERE user_id = ?').run(userId);
    }

    let fetched = 0;
    try {
      const insert = stmt(`INSERT OR IGNORE INTO broker_fills (user_id, ext_id, ts, day, inst, symbol, side, qty, price, charges, order_id, option, expiry)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (let a = from; a <= today; a = addDays(a, CHUNK_DAYS)) {
        const b = addDays(a, CHUNK_DAYS - 1) < today ? addDays(a, CHUNK_DAYS - 1) : today;
        const fills = await adapter.tradeHistory(a, b);
        tx(() => {
          for (const f of fills) {
            insert.run(userId, f.id, f.ts, istDay(f.ts), f.inst, f.symbol || f.inst, f.side, f.qty, f.price, f.charges || 0, f.orderId || '', f.option ? 1 : 0, f.expiry || null);
          }
        })();
        fetched += fills.length;
      }
    } catch (e) {
      stmt(`UPDATE broker_sync SET status = 'error', error = ? WHERE user_id = ?`).run(String(e.message).slice(0, 200), userId);
      throw e;
    }

    const fills = stmt('SELECT ext_id AS id, ts, day, inst, side, qty, price, charges, order_id AS orderId, option, expiry FROM broker_fills WHERE user_id = ?').all(userId);
    const days = dailyPnl(fills, today);
    tx(() => {
      stmt('DELETE FROM broker_pnl_days WHERE user_id = ?').run(userId);
      const put = stmt('INSERT INTO broker_pnl_days (user_id, day, gross, charges, net, trades, wins, losses) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      for (const [day, d] of days) put.run(userId, day, d.gross, d.charges, round(d.gross - d.charges), d.trades, d.wins, d.losses);
      stmt(`UPDATE broker_sync SET status = 'ok', error = NULL, last_day = ?, last_at = ? WHERE user_id = ?`).run(today, now, userId);
    })();
    return { fetched, fills: fills.length, days: days.size };
  })().finally(() => running.delete(userId));
  running.set(userId, job);
  return job;
}

/** What the calendar shows about the broker sync. */
export function syncState(userId) {
  const s = stmt('SELECT broker, from_day, last_at, status, error FROM broker_sync WHERE user_id = ?').get(userId);
  if (!s) return null;
  return { broker: s.broker, fromDay: s.from_day, lastAt: s.last_at, status: running.has(userId) ? 'running' : s.status, error: s.error };
}

export const brokerDays = (userId, fromDay, toDay) =>
  stmt('SELECT day, gross, charges, net, trades, wins, losses FROM broker_pnl_days WHERE user_id = ? AND day >= ? AND day <= ? ORDER BY day').all(userId, fromDay, toDay);

/**
 * After the close (16:00 IST, weekdays), sync every connected account once, one at a time.
 * Checked every 10 minutes; returns a stop function.
 */
export function startBrokerPnlSync({ log = console.log } = {}) {
  let busy = false;
  const tick = async () => {
    const t = ist();
    if (busy || ['Sat', 'Sun'].includes(t.weekday) || t.minutes < 16 * 60) return;
    busy = true;
    try {
      const todayStart = Date.parse(`${t.day}T16:00:00+05:30`);
      const due = stmt(`SELECT DISTINCT a.user_id FROM broker_accounts a LEFT JOIN broker_sync s ON s.user_id = a.user_id
                        WHERE a.status != 'disconnected' AND a.token_enc IS NOT NULL AND a.broker = 'dhan'
                          AND (s.last_at IS NULL OR s.last_at < ?)`).all(todayStart);
      for (const { user_id: id } of due) {
        try { await syncBrokerPnl(id); } catch (e) { log(`[brokerpnl] user ${id}: ${e.message}`); }
      }
    } finally { busy = false; }
  };
  const timer = setInterval(tick, 10 * 60e3);
  timer.unref();
  setTimeout(tick, 30e3).unref();
  return () => clearInterval(timer);
}

