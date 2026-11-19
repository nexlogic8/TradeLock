import { stmt } from '../../db/index.js';
import { v } from '../../lib/validate.js';
import { bad } from '../../lib/errors.js';
import { emit } from '../../lib/bus.js';
import { marketOpen, toMinutes } from '../../lib/time.js';
import { config } from '../../config.js';
import { audit } from '../audit/service.js';
import { limitAmount } from './limits.js';
import { markDirty } from '../broker/book.js';

// Loss limit and profit lock default to a share of the day's starting capital.
export const DEFAULT_RULES = Object.freeze({
  maxLoss:    { on: true, mode: 'percent', value: 5,  action: 'exit' },
  maxTrades:  { on: true, value: 3,       action: 'pause' },
  profitLock: { on: true, mode: 'percent', value: 10, action: 'pause' },
  cutoff:     { on: true, value: '15:00', action: 'pause' },
  // Kill rules (from GROWCONTROL): exit everything and lock when hit.
  lossStreak: { on: true, value: 2 },                    // losing closed trades in a row
  giveback:   { on: true, value: 20 },   // % of today's booked-profit peak; arms at the stop-loss amount
  // Lock the whole broker account for the day when any rule is breached (Dhan kill switch).
  killSwitch: { on: true },
  // Power Scalper option sizing: the stop is this % below the premium, and lots are sized so that
  // stop loses at most the per-trade budget (daily stop-loss ÷ trades per day).
  optionSl:   { on: true, value: 20 },
  // Most one trade may use (premium × quantity): a share of the day's starting capital or a fixed amount. Automatic
  // entries and Power Scalper lots are sized within it; a bigger order is refused.
  capitalUse: { on: false, mode: 'percent', value: 80 },
});

export const MONEY_MODES = ['percent', 'amount'];

export const RULE_ACTIONS = {
  maxLoss: ['exit', 'pause', 'alert'],
  maxTrades: ['pause', 'alert'],
  profitLock: ['pause', 'exit', 'alert'],
  cutoff: ['pause', 'exit'],
};

export const RULE_NAMES = {
  maxLoss: 'daily loss limit', maxTrades: 'trade cap', profitLock: 'profit lock', cutoff: 'trading cutoff',
  lossStreak: 'losing-streak rule', giveback: 'profit give-back rule', optionSl: 'option SL room', capitalUse: 'capital per trade limit',
};

const STRENGTH = { alert: 0, pause: 1, exit: 2 };

function capitalUse(r) {
  const mode = v.oneOf(r.mode ?? DEFAULT_RULES.capitalUse.mode, 'capitalUse.mode', MONEY_MODES);
  const value = mode === 'percent'
    ? v.num(r.value ?? DEFAULT_RULES.capitalUse.value, 'Capital per trade (% of starting capital)', { min: 1, max: 100 })
    : v.num(r.value, 'Capital per trade', { min: 1000, max: 100_000_000 });
  return { on: v.bool(r.on ?? false, 'capitalUse.on'), mode, value: Math.round(value * 100) / 100 };
}

export function normalizeRules(input = {}) {
  const g = k => input[k] || {};
  const rule = (k, value) => ({ on: v.bool(g(k).on, `${k}.on`), value, action: v.oneOf(g(k).action, `${k}.action`, RULE_ACTIONS[k]) });
  const money = (k, label, { maxPct, maxAmount }) => {
    const mode = v.oneOf(g(k).mode ?? 'amount', `${k}.mode`, MONEY_MODES);
    const value = mode === 'percent'
      ? v.num(g(k).value, `${label} (% of starting capital)`, { min: 0.1, max: maxPct })
      : v.num(g(k).value, label, { min: 100, max: maxAmount });
    return { ...rule(k, Math.round(value * 100) / 100), mode };
  };
  const cutoff = v.time(g('cutoff').value, 'Trading cutoff');
  const m = toMinutes(cutoff);
  if (m <= config.market.open || m > config.market.close) throw bad('VALIDATION', 'Trading cutoff must be between 09:15 and 15:30 IST', { field: 'cutoff.value' });
  return {
    maxLoss: money('maxLoss', 'Daily maximum loss', { maxPct: 100, maxAmount: 10_000_000 }),
    maxTrades: rule('maxTrades', v.num(g('maxTrades').value, 'Maximum trades', { min: 1, max: 100, int: true })),
    profitLock: money('profitLock', 'Profit lock', { maxPct: 1000, maxAmount: 100_000_000 }),
    cutoff: rule('cutoff', cutoff),
    lossStreak: {
      on: v.bool(g('lossStreak').on ?? false, 'lossStreak.on'),
      value: v.num(g('lossStreak').value ?? 2, 'Losing trades in a row', { min: 1, max: 20, int: true }),
    },
    giveback: {
      on: v.bool(g('giveback').on ?? false, 'giveback.on'),
      value: v.num(g('giveback').value ?? 20, 'Profit give-back', { min: 1, max: 100 }),
    },
    killSwitch: { on: v.bool(g('killSwitch').on ?? false, 'killSwitch.on') },
    optionSl: {
      on: v.bool(g('optionSl').on ?? DEFAULT_RULES.optionSl.on, 'optionSl.on'),
      value: v.num(g('optionSl').value ?? DEFAULT_RULES.optionSl.value, 'Option SL room', { min: 1, max: 90 }),
    },
    capitalUse: capitalUse(g('capitalUse')),
  };
}

/**
 * True when `next` gives the trader more room than `cur` in any way. Loss limits are compared in
 * rupees using today's capital; if capital is unknown, any mode switch counts as loosening.
 */
export function loosens(cur, next, capital = null) {
  if (cur.killSwitch?.on && !next.killSwitch?.on) return true;
  // A bigger (or no) capital limit per trade allows bigger orders.
  if (cur.capitalUse?.on) {
    if (!next.capitalUse?.on) return true;
    const a = limitAmount(cur.capitalUse, capital), b = limitAmount(next.capitalUse, capital);
    if (a == null || b == null ? cur.capitalUse.mode !== next.capitalUse.mode || next.capitalUse.value > cur.capitalUse.value : b > a) return true;
  }
  // A tighter option SL means more lots for the same rupee budget, and turning sizing on allows orders.
  const curSl = cur.optionSl ?? DEFAULT_RULES.optionSl, nextSl = next.optionSl ?? DEFAULT_RULES.optionSl;
  if (!curSl.on && nextSl.on) return true;
  if (curSl.on && nextSl.on && nextSl.value < curSl.value) return true;
  for (const k of ['lossStreak', 'giveback']) {
    if (cur[k]?.on && !next[k]?.on) return true;
    if (cur[k]?.on && next[k].value > cur[k].value) return true;
  }
  // Give-back arms at the stop-loss amount, so a bigger stop-loss also loosens give-back.
  if (cur.giveback?.on) {
    const a = limitAmount(cur.maxLoss, capital), b = limitAmount(next.maxLoss, capital);
    const bigger = a == null || b == null
      ? (cur.maxLoss.mode ?? 'amount') !== next.maxLoss.mode || next.maxLoss.value > cur.maxLoss.value
      : b > a;
    if (bigger) return true;
  }
  for (const k of Object.keys(RULE_ACTIONS)) {
    if (cur[k].on && !next[k].on) return true;
    if (next[k].on && STRENGTH[next[k].action] < STRENGTH[cur[k].action]) return true;
  }
  if (next.maxLoss.on) {
    const a = limitAmount(cur.maxLoss, capital), b = limitAmount(next.maxLoss, capital);
    if (a == null || b == null) {
      if ((cur.maxLoss.mode ?? 'amount') !== next.maxLoss.mode || next.maxLoss.value > cur.maxLoss.value) return true;
    } else if (b > a) return true;
  }
  return (
    (next.maxTrades.on && next.maxTrades.value > cur.maxTrades.value) ||
    (next.cutoff.on && toMinutes(next.cutoff.value) > toMinutes(cur.cutoff.value))
  );
}

export const ensureRules = userId => {
  const rules = JSON.stringify(DEFAULT_RULES);
  stmt('INSERT OR IGNORE INTO risk_rules (user_id, config, algo_config, updated_at) VALUES (?, ?, ?, ?)').run(userId, rules, rules, Date.now());
};

/**
 * Two rule sets per account: 'manual' (Manual trading) and 'algo' (Algo Trading). The one in force follows the
 * Algo Trading switch: on (with protection on) → the Algo rules, off → the Manual rules. Day state (P&L, entries,
 * rules already hit, kill switch) stays one per account.
 */
export const RULE_SETS = ['manual', 'algo'];
// P&L rules and the broker kill switch cover the whole account (Manual + Algo trades), always: set once on the Risk
// rules page (the Manual set);
// the Algo set takes them from there whatever its own copy says.
export const ACCOUNT_RULES = ['maxLoss', 'profitLock', 'giveback', 'killSwitch'];
const withAccountRules = (set, manual) => ({ ...set, ...Object.fromEntries(ACCOUNT_RULES.filter(k => manual[k]).map(k => [k, manual[k]])) });
const COLUMN = { manual: 'config', algo: 'algo_config' };
export const ruleMode = userId =>
  stmt('SELECT 1 FROM broker_accounts WHERE user_id = ? AND algo_on = 1 AND agent_on = 1 LIMIT 1').get(userId) ? 'algo' : 'manual';

// Rules are read on every broker sync, so both sets are cached (the mode is read each time: the Algo switch can
// change in several places); every write below goes through forget().
const cache = new Map();
const forget = userId => { cache.delete(userId); markDirty(userId); };

function ruleSets(userId) {
  const hit = cache.get(userId);
  if (hit) return hit;
  ensureRules(userId);
  let row = stmt('SELECT * FROM risk_rules WHERE user_id = ?').get(userId);
  // Changes now apply as soon as they are saved; a change scheduled under the old next-session rule applies now.
  if (row.pending) {
    stmt('UPDATE risk_rules SET config = pending, pending = NULL, pending_from = NULL, updated_at = ? WHERE user_id = ?').run(Date.now(), userId);
    markDirty(userId);
    row = { ...row, config: row.pending };
  }
  const manual = JSON.parse(row.config);
  const sets = deepFreeze({ manual, algo: withAccountRules(JSON.parse(row.algo_config || row.config), manual) });
  cache.set(userId, sets);
  return sets;
}

/**
 * { active, mode, manual, algo }. One master set since 16 Nov 2026 (the owner's choice): the Risk rules page's rules
 * apply to Manual and Algo trades alike, whatever the Algo Trading switch; the old Algo set (algo_config) is not used.
 * `algo` and `mode` stay in the answer for older app / web builds, both pointing at the master set.
 */
export function getRules(userId) {
  const sets = ruleSets(userId);
  return { active: sets.manual, mode: 'manual', manual: sets.manual, algo: sets.manual, pending: null, pendingFrom: null };
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); }
  return o;
}

/**
 * Every change applies immediately, during market hours too. A limit already hit today stays hit
 * (its trigger, the pause and any broker kill switch are kept until the next trading day).
 * Loosening mid-session is still recorded in the audit log.
 */
export function saveRules(userId, input, ip, capital = null, set = 'manual') {
  set = v.oneOf(set, 'set', RULE_SETS);
  // One master set: an older AI Algo Trading page still sending its own set would overwrite the master with a partial
  // copy, so it is refused with a pointer to the Risk rules page.
  if (set !== 'manual') throw bad('RULES_MASTER', 'Algo Trading now follows your Risk rules. Change them on the Risk rules page.');
  const next = normalizeRules(input);
  const was = getRules(userId), before = was[set];
  stmt(`UPDATE risk_rules SET ${COLUMN[set]} = ?, pending = NULL, pending_from = NULL, updated_at = ? WHERE user_id = ?`).run(JSON.stringify(next), Date.now(), userId);
  forget(userId);
  const now = getRules(userId);
  // Loosening counts only for the rules in force (the P&L rules from the Manual set are in force in both modes).
  const loosened = marketOpen() && loosens(was.active, now.active, capital);
  audit(userId, 'rules.updated', { set, before, after: next, loosenedInSession: loosened || undefined }, ip);
  emit(userId, 'rules', now.active);
  return { ...now, deferred: false };
}
