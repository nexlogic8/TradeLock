// EMA 9/15 5m · 30° angle backtest on a small synthetic history: the steep crossover is bought on the next-expiry ATM
// at the next minute's open, the stop under the option's signal-candle low, out after the first red 5-minute candle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openHistory } from '../src/modules/backtest/history-store.js';
import { ema915Backtest } from '../src/modules/backtest/ema915.js';

const t = (day, hhmm) => Date.parse(`${day}T${hhmm}:00+05:30`) / 1000;
const D1 = '2026-03-02', D2 = '2026-03-03';
const clock = (h, m) => `${String(h + Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
// D1 10:00–10:59 flat at 22500; D2 09:15–09:59 slides a point a minute, 10:00–10:04 jumps 30 a minute (the steep
// crossover), 10:05–10:09 rises (green), 10:10–10:14 falls (red: the exit), then flat to 10:30.
function store() {
  const s = openHistory(':memory:'), idx = [];
  for (let m = 0; m < 60; m++) idx.push({ time: t(D1, clock(10, m)), open: 22500, high: 22501, low: 22499, close: 22500 });
  let px = 22500;
  const step = (time, d) => { const o = px; px += d; idx.push({ time, open: o, high: Math.max(o, px) + 1, low: Math.min(o, px) - 1, close: px }); };
  for (let m = 15; m < 60; m++) step(t(D2, clock(9, m)), -1);
  for (let m = 0; m < 30; m++) step(t(D2, clock(10, m)), m < 5 ? 30 : m < 10 ? 2 : m < 15 ? -2 : 0);
  s.saveIndex('NIFTY', D1, D2, idx);
  const ce = [];
  for (let m = 0; m < 30; m++) ce.push({ time: t(D2, clock(10, m)), strike: 22500, open: m < 5 ? 105 : m === 5 ? 120 : m === 15 ? 118 : 122, high: 125, low: m < 5 ? 100 : 115, close: 121 });
  s.saveOptions('NIFTY', 2, 'CE', 0, D2, D2, ce);
  return s;
}

test('the steep crossover: next-expiry ATM CE at the next open, stop under the signal candle, out after the first red candle', () => {
  const r = ema915Backtest({ startDate: D2, endDate: D2 }, store());
  // The 09:15 slide is itself a steep PE crossover (09:20 candle); no PE prices are stored, so it is skipped.
  assert.equal(r.signals, 2);
  assert.deepEqual(r.skipped.map(x => [x.side, x.signalAt, x.reason]), [['PE', t(D2, '09:20'), 'ATM option not in the stored history']]);
  const [x] = r.trades;
  assert.deepEqual([x.side, x.strike, x.signalAt, x.entryAt, x.entry, x.stop], ['CE', 22500, t(D2, '10:00'), t(D2, '10:05'), 121, 99.95]);
  assert.ok(x.angle >= 30, `angle ${x.angle}`);
  assert.deepEqual([x.exitAt, x.exit, x.exitReason], [t(D2, '10:15'), 118, 'First red 5-min candle 10:10']);
  assert.equal(x.qty, x.lotSize);
  assert.equal(x.net, Math.round(((118 - 121) * x.qty - x.charges) * 100) / 100);
  assert.deepEqual([r.summary.trades, r.summary.net, r.months.length], [1, x.net, 1]);
});

test('a higher angle than the move: no trade; after the last entry time: skipped with the reason', () => {
  assert.equal(ema915Backtest({ startDate: D2, endDate: D2, minAngle: 85 }, store()).trades.length, 0);
  const late = ema915Backtest({ startDate: D2, endDate: D2, lastEntry: '10:05' }, store());
  assert.deepEqual([late.trades.length, late.skipped.at(-1).side, late.skipped.at(-1).reason], [0, 'CE', 'after the last entry time 10:05']);
});
