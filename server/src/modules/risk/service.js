import { stmt, deferWrite } from '../../db/index.js';
import { config } from '../../config.js';
import { ist, marketOpen, toMinutes } from '../../lib/time.js';
import { getRules } from '../rules/service.js';
import { accountFor, accountSummary } from '../broker/registry.js';
import { getBook, getKillStatus, markDirty } from '../broker/book.js';
import { fillsForDay } from '../trades/service.js';
import { closedTrades, closedPeak, consecutiveLosses } from './engine.js';
import { limitsFor, givebackArmAt } from '../rules/limits.js';

const DAY_COLUMNS = new Set(['ks_armed', 'ks_active_at', 'capital', 'realized', 'unrealized', 'worst', 'peak', 'entries', 'wins', 'losses', 'paused', 'pause_reason', 'fired', 'breaches', 'blocked', 'sync_ok', 'sync_fail']);
const clamp01 = x => Math.min(1, Math.max(0, x));

// Today's row per user is read several times per broker sync, so it is cached in memory. Every write
// goes through patchDay(), which updates the cache. Cached objects are frozen: callers build new
// objects instead of mutating.
const days = new Map();   // `${userId}|${day}` -> state (current trading day only)
let cacheDay = '';

export function dayState(userId, day = ist().day) {
  if (day > cacheDay) { days.clear(); cacheDay = day; }
  const key = `${userId}|${day}`;
  const hit = days.get(key);
  if (hit) return hit;
  stmt('INSERT OR IGNORE INTO day_state (user_id, day) VALUES (?, ?)').run(userId, day);
  const s = stmt('SELECT * FROM day_state WHERE user_id = ? AND day = ?').get(userId, day);
  s.fired = Object.freeze(JSON.parse(s.fired));
  Object.freeze(s);
  if (day === cacheDay) days.set(key, s);
  return s;
}

/** Forget a user's cached day (its rows were swapped for another trading broker's). */
export function forgetDays(userId) {
  for (const k of days.keys()) if (k.startsWith(`${userId}|`)) days.delete(k);
}

/** Update today's row. { defer: true } batches the DB write (live P&L); the cache updates at once. */
export function patchDay(userId, day, patch, { defer = false } = {}) {
  const keys = Object.keys(patch).filter(k => DAY_COLUMNS.has(k));
  if (!keys.length) return;
  const cur = dayState(userId, day);   // makes sure the row exists
  const vals = keys.map(k => (k === 'fired' ? JSON.stringify(patch[k]) : patch[k]));
  const update = stmt(`UPDATE day_state SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE user_id = ? AND day = ?`);
  if (defer) deferWrite(() => update.run(...vals, userId, day));
  else update.run(...vals, userId, day);
  const key = `${userId}|${day}`;
  if (days.has(key)) {
    const next = { ...cur };
    for (const k of keys) next[k] = k === 'fired' ? Object.freeze([...patch[k]]) : patch[k];
    days.set(key, Object.freeze(next));
  }
  // sync_ok alone is bookkeeping; anything else changes what the user's dashboard shows.
  if (keys.some(k => k !== 'sync_ok')) markDirty(userId);
}

export const recordPoint = (userId, day, minute, pnl) => deferWrite(() =>
  stmt('INSERT INTO pnl_points (user_id, day, minute, pnl) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET pnl = excluded.pnl')
    .run(userId, day, minute, Math.round(pnl * 100) / 100));

export const intradayPoints = (userId, day = ist().day) =>
  stmt('SELECT minute, pnl FROM pnl_points WHERE user_id = ? AND day = ? ORDER BY minute').all(userId, day);

/**
 * Capital from broker funds (GROWCONTROL): money in the account = free + in use, minus today's realized
 * P&L, so trading results never move it. Falls back to the opening balance.
 */
export function capitalFromFunds(funds, realized = 0) {
  if (!funds) return null;
  if (typeof funds.available === 'number') {
    const v = Math.round((funds.available + (funds.used || 0) - realized) * 100) / 100;
    if (v > 0) return v;
  }
  return funds.opening > 0 ? funds.opening : null;
}

/** Today's capital: the day's frozen value, else what the broker's funds say right now. */
export function capitalFor(userId, s = dayState(userId)) {
  return s.capital ?? capitalFromFunds(getBook(userId).funds, s.realized);
}

/** Algo Trading cannot be switched off while the market is open (09:15–15:30 IST): it stays on until the close. */
export const ALGO_LOCK_MESSAGE = 'Algo Trading stays on during market hours (09:15–15:30 IST). You can switch it off after 15:30. Exits are always allowed.';
export const algoLocked = (acct, at = Date.now()) => !!acct?.algo_on && marketOpen(at) && !config.flexUserIds.has(acct?.user_id);

const LOCK_RULES = { maxLoss: 'your daily stop-loss was hit', profitLock: 'your profit target was reached', maxTrades: 'your trades-per-day limit was reached',
  cutoff: 'your cutoff time passed', lossStreak: 'your losing-streak limit was hit', giveback: 'your profit give-back limit was hit' };
/**
 * Why protection can't be stopped today (null = it can): once a limit fired or the kill switch is involved,
 * stopping would be a way around your own rules, so it stays on until the next trading day.
 */
export function agentLockReason(userId, s = dayState(userId)) {
  if (s.ks_active_at || getKillStatus(userId)?.active) return 'the kill switch is on';
  if (s.ks_armed) return 'the kill switch is armed';
  if (s.paused && s.pause_reason?.startsWith('rule:')) return LOCK_RULES[s.pause_reason.slice(5)] || 'a risk rule paused trading';
  if ((s.fired || []).some(f => f.endsWith('.breach'))) return 'a risk limit was hit';
  return null;
}

const slOf = (r, capital) => ({ on: !!r?.maxLoss?.on, mode: r?.maxLoss?.mode, value: r?.maxLoss?.value, amount: r?.maxLoss?.on ? limitsFor(r, capital).maxLoss : null });

/** Everything the dashboard needs in one object; also pushed over SSE after each sync. */
export function getDashboard(userId, acct = accountFor(userId)) {
  const t = ist();
  const s = dayState(userId, t.day);
  const { active: rules, pending, pendingFrom, mode, manual, algo } = getRules(userId);
  const book = getBook(userId);
  const broker = accountSummary(acct);
  const pnl = s.realized + s.unrealized;
  const cutoff = toMinutes(rules.cutoff.value);
  const capital = capitalFor(userId, s);
  // Rupee levels for the rules that are switched on (null = off, or capital not known yet).
  const amounts = limitsFor(rules, capital);
  const limits = { maxLoss: rules.maxLoss.on ? amounts.maxLoss : null, profitLock: rules.profitLock.on ? amounts.profitLock : null };
  return {
    day: t.day,
    time: t.hhmm,
    marketOpen: marketOpen(),
    pnl, realized: s.realized, unrealized: s.unrealized, worst: s.worst, peak: s.peak,
    entries: s.entries,
    paused: !!s.paused,
    pauseReason: s.pause_reason,
    agentLock: agentLockReason(userId, s),
    algoLocked: algoLocked(acct),
    tradeCount: stmt('SELECT COUNT(*) AS n FROM trades WHERE user_id = ? AND day = ?').get(userId, t.day).n,
    rules,
    rulesPendingFrom: pending ? pendingFrom : null,
    capital,
    limits,
    // Both rule sets' daily stop-loss (Manual trading / Algo Trading), and which one is in force now.
    stopLosses: { mode, manual: slOf(manual, capital), algo: slOf(algo, capital) },
    killSwitch: {
      enabled: !!rules.killSwitch?.on,
      supported: broker?.capabilities?.accountLock === 'killswitch',
      armed: !!s.ks_armed,
      reason: s.ks_armed,
      activeAt: s.ks_active_at,
      broker: getKillStatus(userId),
    },
    killRules: (() => {
      const closed = closedTrades(fillsForDay(userId, t.day));
      const peak = closedPeak(closed);
      const gb = rules.giveback;
      const armAt = givebackArmAt(rules, capital);
      return {
        closedTrades: closed.length,
        streak: consecutiveLosses(closed),
        streakLimit: rules.lossStreak?.on ? rules.lossStreak.value : null,
        bookedPeak: peak,
        givebackArmAt: armAt,
        givebackArmed: !!(gb?.on && peak > 0 && armAt != null && peak >= armAt),
        givebackLevel: gb?.on && peak > 0 ? Math.round(peak * (1 - gb.value / 100) * 100) / 100 : null,
      };
    })(),
    usage: {
      loss: limits.maxLoss ? clamp01(-s.worst / limits.maxLoss) : 0,
      trades: rules.maxTrades.on ? clamp01(s.entries / rules.maxTrades.value) : 0,
      profit: limits.profitLock ? clamp01(pnl / limits.profitLock) : 0,
      session: clamp01((t.minutes - config.market.open) / (cutoff - config.market.open)),
      cutoffLeftMin: Math.max(0, cutoff - t.minutes),
    },
    broker,
    positions: book.positions.filter(p => p.qty !== 0),
    orders: book.orders,
    funds: book.funds,
    syncedAt: book.at,
    uptime: s.sync_ok + s.sync_fail ? s.sync_ok / (s.sync_ok + s.sync_fail) : null,
  };
}
