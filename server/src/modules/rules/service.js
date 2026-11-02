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
  lossStreak: 'losing-streak rule', giveback: 'profit give-back rule', optionSl: 'option SL room',
};

const STRENGTH = { alert: 0, pause: 1, exit: 2 };

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
  };
}

/**
 * True when `next` gives the trader more room than `cur` in any way. Loss limits are compared in
 * rupees using today's capital; if capital is unknown, any mode switch counts as loosening.
 */
export function loosens(cur, next, capital = null) {
  if (cur.killSwitch?.on && !next.killSwitch?.on) return true;
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
  const sets = deepFreeze({ manual: JSON.parse(row.config), algo: JSON.parse(row.algo_config || row.config) });
  cache.set(userId, sets);
  return sets;
}

/** { active, mode, manual, algo }: `active` is the set in force now (see RULE_SETS). */
export function getRules(userId) {
  const sets = ruleSets(userId), mode = ruleMode(userId);
  return { active: sets[mode], mode, manual: sets.manual, algo: sets.algo, pending: null, pendingFrom: null };
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
export function saveRules(userId, input, ip, capital = null, set = ruleMode(userId)) {
  set = v.oneOf(set, 'set', RULE_SETS);
  const next = normalizeRules(input);
  const before = getRules(userId)[set];
  // Loosening counts only for the set in force: the other one protects nothing today.
  const loosened = marketOpen() && set === ruleMode(userId) && loosens(before, next, capital);
  stmt(`UPDATE risk_rules SET ${COLUMN[set]} = ?, pending = NULL, pending_from = NULL, updated_at = ? WHERE user_id = ?`).run(JSON.stringify(next), Date.now(), userId);
  forget(userId);
  audit(userId, 'rules.updated', { set, before, after: next, loosenedInSession: loosened || undefined }, ip);
  const now = getRules(userId);
  emit(userId, 'rules', now.active);
  return { ...now, deferred: false };
}
