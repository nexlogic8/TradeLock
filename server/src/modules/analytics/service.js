import { stmt } from '../../db/index.js';
import { ist } from '../../lib/time.js';
import { brokerDays, syncState } from './brokerpnl.js';
import { estimateCharges } from '../risk/charges.js';
import { fillsForDay } from '../trades/service.js';

export function analytics(userId, sessions = 20) {
  const own = stmt(`
    SELECT day, realized + unrealized AS pnl, wins, losses, breaches, blocked, sync_ok, sync_fail
    FROM day_state WHERE user_id = ? AND (sync_ok > 0 OR realized != 0) ORDER BY day DESC LIMIT ?`).all(userId, sessions);
  // Days from the broker's trade history count too (net of charges); TradeLock's figure stays for today.
  const byDay = new Map(own.map(r => [r.day, r]));
  const today = ist().day;
  for (const b of brokerDays(userId, '0000-01-01', '9999-12-31')) {
    const r = byDay.get(b.day);
    if (b.day === today && r) continue;
    byDay.set(b.day, { day: b.day, pnl: b.net, wins: b.wins, losses: b.losses, breaches: r?.breaches || 0, blocked: r?.blocked || 0, sync_ok: r?.sync_ok || 0, sync_fail: r?.sync_fail || 0 });
  }
  const rows = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)).slice(-sessions);

  const sum = k => rows.reduce((a, r) => a + r[k], 0);
  const wins = sum('wins'), losses = sum('losses');
  const syncTotal = sum('sync_ok') + sum('sync_fail');
  const lossDays = rows.filter(r => r.pnl < 0);
  const worst = rows.reduce((w, r) => (!w || r.pnl < w.pnl ? r : w), null);
  let cum = 0;

  return {
    sessions: rows.length,
    from: rows[0]?.day ?? null,
    to: rows.at(-1)?.day ?? null,
    netPnl: sum('pnl'),
    trades: wins + losses,
    wins,
    winRate: wins + losses ? wins / (wins + losses) : null,
    // Share of sessions that ended without a hard limit being crossed.
    adherence: rows.length ? rows.filter(r => r.breaches === 0).length / rows.length : null,
    limitsTriggered: sum('breaches'),
    overtradingDaysAvoided: rows.filter(r => r.blocked > 0).length,
    uptime: syncTotal ? sum('sync_ok') / syncTotal : null,
    worstDay: worst && worst.pnl < 0 ? { day: worst.day, pnl: worst.pnl } : null,
    avgLossDay: lossDays.length ? lossDays.reduce((a, r) => a + r.pnl, 0) / lossDays.length : null,
    series: rows.map(r => ({ day: r.day, pnl: r.pnl, cumulative: (cum += r.pnl) })),
  };
}

/** One calendar month (YYYY-MM) of trading days: day-by-day P&L and a summary. */
export function pnlCalendar(userId, month) {
  const live = stmt(`
    SELECT day, realized, unrealized, realized + unrealized AS pnl, entries, wins, losses, breaches, ks_active_at AS ksAt
    FROM day_state WHERE user_id = ? AND day >= ? AND day <= ? AND (sync_ok > 0 OR realized != 0 OR entries > 0)
    ORDER BY day`).all(userId, `${month}-01`, `${month}-31`)
    .map(r => {
      // After charges, like the header and the day chart (the broker's own history below is already net).
      const charges = Math.round(estimateCharges(fillsForDay(userId, r.day)).total * 100) / 100;
      return { ...r, gross: Math.round(r.pnl * 100) / 100, charges, pnl: Math.round((r.pnl - charges) * 100) / 100, locked: !!r.ksAt, ksAt: undefined, source: 'tradelock' };
    });
  // The broker's trade history is the record of what really happened; TradeLock's own numbers fill
  // the gaps, and stay for today while the session is live (they include open positions).
  const byDay = new Map(live.map(d => [d.day, d]));
  const today = ist().day;
  for (const b of brokerDays(userId, `${month}-01`, `${month}-31`)) {
    const own = byDay.get(b.day);
    if (b.day === today && own) continue;
    byDay.set(b.day, {
      day: b.day, realized: b.net, unrealized: 0, pnl: b.net, entries: b.trades, wins: b.wins, losses: b.losses,
      breaches: own?.breaches || 0, locked: own?.locked || false, gross: b.gross, charges: b.charges, source: 'broker',
    });
  }
  const days = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  const traded = days.filter(d => d.entries > 0 || d.pnl !== 0);
  const best = traded.reduce((b, d) => (!b || d.pnl > b.pnl ? d : b), null);
  const worst = traded.reduce((w, d) => (!w || d.pnl < w.pnl ? d : w), null);
  const mode = stmt(`SELECT paper_mode FROM broker_accounts WHERE user_id = ? AND status != 'disconnected' ORDER BY broker = 'paper', created_at DESC LIMIT 1`).get(userId);
  return {
    month,
    paper: mode?.paper_mode === 1,
    days,
    brokerSync: syncState(userId),
    summary: {
      net: Math.round(days.reduce((a, d) => a + d.pnl, 0) * 100) / 100,
      tradingDays: traded.length,
      greenDays: traded.filter(d => d.pnl > 0).length,
      redDays: traded.filter(d => d.pnl < 0).length,
      trades: days.reduce((a, d) => a + d.entries, 0),
      limitDays: days.filter(d => d.breaches > 0).length,
      best: best && best.pnl > 0 ? { day: best.day, pnl: best.pnl } : null,
      worst: worst && worst.pnl < 0 ? { day: worst.day, pnl: worst.pnl } : null,
    },
  };
}
