import { stmt } from '../../db/index.js';
import { v } from '../../lib/validate.js';
import { bad } from '../../lib/errors.js';
import { audit } from '../audit/service.js';

export const DEFAULT_STRATEGY = Object.freeze({
  name: 'Momentum intraday',
  market: 'equity',
  timeframe: '5m',
  direction: 'both',
  entries: { vwap: true, ema: true, emaFast: 9, emaSlow: 21, rsi: false, rsiMin: 55, breakout: false, breakoutBars: 20, volume: false, volumeMultiple: 1.5 },
  exits: { stopMode: 'percent', stopValue: 1, targetMode: 'rr', targetValue: 2, trailing: false, trailValue: 0.5, squareOff: '15:15' },
});

const bool = (o, k) => v.bool(o[k], `entries.${k}`);

export function normalizeStrategy(input = {}) {
  const e = input.entries || {}, x = input.exits || {};
  const stopMode = v.oneOf(x.stopMode ?? 'percent', 'stopMode', ['percent', 'amount']);
  const targetMode = v.oneOf(x.targetMode ?? 'rr', 'targetMode', ['rr', 'percent']);
  const squareOff = v.time(x.squareOff, 'Square-off time');
  const [squareHour, squareMinute] = squareOff.split(':').map(Number);
  if (squareHour * 60 + squareMinute < 9 * 60 + 15 || squareHour * 60 + squareMinute > 15 * 60 + 30) {
    throw bad('VALIDATION', 'Square-off time must be between 09:15 and 15:30 IST.', { field: 'squareOff' });
  }
  const emaFast = v.num(e.emaFast ?? 9, 'Fast EMA period', { min: 2, max: 200, int: true });
  const emaSlow = v.num(e.emaSlow ?? 21, 'Slow EMA period', { min: 3, max: 500, int: true });
  if (emaFast >= emaSlow) throw bad('VALIDATION', 'Fast EMA must be shorter than slow EMA.', { field: 'emaFast' });
  return {
    name: v.str(input.name ?? DEFAULT_STRATEGY.name, 'Strategy name', { min: 2, max: 48 }),
    market: v.oneOf(input.market ?? 'equity', 'market', ['equity', 'fo']),
    timeframe: v.oneOf(input.timeframe ?? '5m', 'timeframe', ['1m', '3m', '5m', '15m', 'day']),
    direction: v.oneOf(input.direction ?? 'both', 'direction', ['long', 'short', 'both']),
    entries: {
      vwap: bool(e, 'vwap'), ema: bool(e, 'ema'), rsi: bool(e, 'rsi'),
      breakout: bool(e, 'breakout'), volume: bool(e, 'volume'),
      emaFast,
      emaSlow,
      rsiMin: v.num(e.rsiMin ?? 55, 'Minimum RSI', { min: 1, max: 99 }),
      breakoutBars: v.num(e.breakoutBars ?? 20, 'Breakout lookback', { min: 2, max: 500, int: true }),
      volumeMultiple: v.num(e.volumeMultiple ?? 1.5, 'Volume multiplier', { min: 0.1, max: 20 }),
    },
    exits: {
      stopMode,
      stopValue: v.num(x.stopValue, 'Stop loss', { min: stopMode === 'percent' ? 0.1 : 1, max: stopMode === 'percent' ? 50 : 1_000_000 }),
      targetMode,
      targetValue: v.num(x.targetValue, 'Target', { min: targetMode === 'rr' ? 0.1 : 0.1, max: targetMode === 'rr' ? 100 : 1000 }),
      trailing: v.bool(x.trailing, 'Trailing stop'),
      trailValue: v.num(x.trailValue, 'Trailing distance', { min: 0.1, max: 100 }),
      squareOff,
    },
  };
}

// Saved strategies (playbooks): many per user. They describe how the user trades; TradeLock does not
// trade them automatically (the live Algo Trading strategies are built in: ORB 5m and EMA 9/21).
export const MAX_STRATEGIES = 20;
const toItem = row => ({ id: row.id, ...JSON.parse(row.config), createdAt: row.created_at, updatedAt: row.updated_at });

export function listStrategies(userId) {
  return stmt('SELECT * FROM user_strategies WHERE user_id = ? ORDER BY updated_at DESC, id DESC').all(userId).map(toItem);
}

/** The most recently updated strategy (the AI analysis prompt uses it), or the default playbook. */
export function getStrategy(userId) {
  const row = stmt('SELECT * FROM user_strategies WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1').get(userId);
  return row ? toItem(row) : { ...structuredClone(DEFAULT_STRATEGY), updatedAt: null };
}

export function createStrategy(userId, input, ip) {
  const count = stmt('SELECT COUNT(*) AS n FROM user_strategies WHERE user_id = ?').get(userId).n;
  if (count >= MAX_STRATEGIES) throw bad('STRATEGY_LIMIT', `You can save up to ${MAX_STRATEGIES} strategies. Delete one first.`);
  const config = normalizeStrategy(input), now = Date.now();
  const { lastInsertRowid } = stmt('INSERT INTO user_strategies (user_id, config, created_at, updated_at) VALUES (?, ?, ?, ?)').run(userId, JSON.stringify(config), now, now);
  audit(userId, 'strategy.created', { name: config.name }, ip);
  return toItem(stmt('SELECT * FROM user_strategies WHERE id = ?').get(Number(lastInsertRowid)));
}

function own(userId, id) {
  const row = stmt('SELECT * FROM user_strategies WHERE id = ? AND user_id = ?').get(Number(id), userId);
  if (!row) throw bad('STRATEGY_NOT_FOUND', 'Strategy not found.');
  return row;
}

export function updateStrategy(userId, id, input, ip) {
  own(userId, id);
  const config = normalizeStrategy(input), now = Date.now();
  stmt('UPDATE user_strategies SET config = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(JSON.stringify(config), now, Number(id), userId);
  audit(userId, 'strategy.updated', { id: Number(id), name: config.name }, ip);
  return toItem(stmt('SELECT * FROM user_strategies WHERE id = ?').get(Number(id)));
}

export function deleteStrategy(userId, id, ip) {
  const row = own(userId, id);
  stmt('DELETE FROM user_strategies WHERE id = ? AND user_id = ?').run(Number(id), userId);
  audit(userId, 'strategy.deleted', { id: Number(id), name: JSON.parse(row.config).name }, ip);
  return { ok: true };
}

/** Older single-playbook API: saves into the most recent strategy (or creates the first one). */
export function saveStrategy(userId, input, ip) {
  const latest = stmt('SELECT id FROM user_strategies WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1').get(userId);
  return latest ? updateStrategy(userId, latest.id, input, ip) : createStrategy(userId, input, ip);
}
