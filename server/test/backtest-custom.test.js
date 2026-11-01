// "My strategies" backtest on a small synthetic history: a saved strategy's rules on NIFTY 1-minute bars, the ATM
// option bought at the next minute's open, premium stop / target, reversal on the opposite signal, square-off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openHistory } from '../src/modules/backtest/history-store.js';
import { customBacktest, groupBars, ruleStates } from '../src/modules/backtest/custom.js';
import { normalizeStrategy } from '../src/modules/strategy/service.js';

const t = (day, hhmm) => Date.parse(`${day}T${hhmm}:00+05:30`) / 1000;
const D1 = '2026-03-02', D2 = '2026-03-03';
const hhmm = m => `${String(9 + Math.floor((15 + m) / 60)).padStart(2, '0')}:${String((15 + m) % 60).padStart(2, '0')}`;
const strategy = (over = {}) => normalizeStrategy({ name: 'Test', market: 'fo', timeframe: '1m', direction: 'both',
  entries: { vwap: false, ema: false, rsi: false, breakout: true, volume: false, emaFast: 2, emaSlow: 5, breakoutBars: 2, ...over.entries },
  exits: { stopMode: 'percent', stopValue: 20, targetMode: 'rr', targetValue: 2, trailing: false, trailValue: 0.5, squareOff: '09:30', ...over.exits } });

// NIFTY: a break above the last two highs at 09:17 (→ CE at 09:18), a break below the last two lows at 09:21 (→ PE at 09:22).
const IDX = [[22500, 22510, 22490, 22500], [22500, 22512, 22495, 22505], [22505, 22532, 22504, 22530],
  [22530, 22531, 22520, 22525], [22525, 22531, 22520, 22525], [22525, 22531, 22520, 22525], [22525, 22526, 22468, 22470]];
function store() {
  const s = openHistory(':memory:');
  const idx = [{ time: t(D1, '15:29'), open: 22500, high: 22505, low: 22495, close: 22500 }];
  for (let m = 0; m < 17; m++) { const [o, h, l, c] = IDX[m] || [22470, 22480, 22460, 22470]; idx.push({ time: t(D2, hhmm(m)), open: o, high: h, low: l, close: c }); }
  s.saveIndex('NIFTY', D1, D2, idx);
  const ce = [], pe = [];
  for (let m = 0; m < 17; m++) {
    const time = t(D2, hhmm(m));
    ce.push({ time, strike: 22500, open: m === 7 ? 104 : m >= 3 ? 100 : 98, high: 106, low: 97, close: 101 });
    // PE: entry 90 at 09:22, then 09:25 dips to 70 (stop 72.40)
    pe.push({ time, strike: 22500, open: m === 10 ? 85 : 90, high: 93, low: m === 10 ? 70 : 88, close: 90 });
  }
  s.saveOptions('NIFTY', 1, 'CE', 0, D2, D2, ce); s.saveOptions('NIFTY', 1, 'PE', 0, D2, D2, pe);
  return s;
}

test('breakout CE, reversed into a PE on the opposite signal, then the PE is stopped', () => {
  const r = customBacktest({ startDate: D2, endDate: D2, strategy: strategy(), lots: 1, slippage: 0.5, brokeragePerOrder: 15 }, store());
  assert.equal(r.signals, 2);
  const [ce, pe] = r.trades;
  assert.deepEqual([ce.side, ce.strike, ce.entryAt, ce.entry, ce.stop, ce.target], ['CE', 22500, t(D2, '09:18'), 100.5, 80.4, 140.7]);
  assert.deepEqual([ce.exitAt, ce.exit, ce.exitReason], [t(D2, '09:22'), 104, 'Opposite signal']);
  assert.deepEqual([pe.side, pe.entryAt, pe.entry, pe.stop, pe.exitAt, pe.exit, pe.exitReason], ['PE', t(D2, '09:22'), 90.5, 72.4, t(D2, '09:25'), 72.4, 'Stop-loss']);
  assert.equal(ce.gross, Math.round((104 - 100.5) * ce.qty * 100) / 100);
  assert.ok(ce.charges > 30 && ce.net === Math.round((ce.gross - ce.charges) * 100) / 100, 'brokerage ₹15 × 2 plus statutory charges');
  assert.equal(r.summary.trades, 2);
  assert.equal(r.summary.net, Math.round((ce.net + pe.net) * 100) / 100);
});

test('long only: the PE signal is ignored and the CE runs to the square-off; no opposite exit when switched off', () => {
  const r = customBacktest({ startDate: D2, endDate: D2, strategy: { ...strategy(), direction: 'long' }, oppositeExit: false }, store());
  assert.equal(r.trades.length, 1);
  assert.deepEqual([r.trades[0].side, r.trades[0].exitAt, r.trades[0].exitReason], ['CE', t(D2, '09:30'), 'Square-off 09:30']);
});

test('EMA rule: a signal only on the bar where the fast EMA crosses the slow one, not on every bar after', () => {
  const closes = [100, 99, 98, 97, 96, 100, 104, 108, 112, 116];
  const bars = groupBars(closes.map((c, i) => ({ time: t(D2, hhmm(i)), open: c, high: c, low: c, close: c })), 1);
  const st = ruleStates(bars, strategy({ entries: { ema: true, breakout: false } }));
  const fresh = st.map((x, i) => i && x.long && !st[i - 1].long).map((x, i) => x ? i : -1).filter(i => i >= 0);
  assert.deepEqual(fresh, [5], 'EMA 2 crosses above EMA 5 at the first up bar');
  assert.ok(st.slice(6).every(x => x.long));
});

test('3-minute bars start at 09:15 and close on their last minute', () => {
  const rows = [0, 1, 2, 3].map(m => ({ time: t(D2, hhmm(m)), open: m, high: m + 1, low: m - 1, close: m + 0.5 }));
  const b = groupBars(rows, 3);
  assert.deepEqual(b.map(x => [x.time, x.last, x.open, x.high, x.low, x.close]), [[t(D2, '09:15'), t(D2, '09:17'), 0, 3, -1, 2.5], [t(D2, '09:18'), t(D2, '09:18'), 3, 4, 2, 3.5]]);
});

test('built-in EMA 3/5: no stop and no target, so the PE dip does not stop it; only the opposite signal or square-off ends a trade', async () => {
  const { CUSTOM_BUILT_IN } = await import('../src/modules/backtest/custom.js');
  const st = { ...structuredClone(CUSTOM_BUILT_IN.ema35), entries: { ...CUSTOM_BUILT_IN.ema35.entries, ema: false, breakout: true, breakoutBars: 2 }, exits: { ...CUSTOM_BUILT_IN.ema35.exits, squareOff: '09:30' } };
  const r = customBacktest({ startDate: D2, endDate: D2, strategy: st }, store());
  assert.deepEqual(r.trades.map(t => [t.side, t.exitReason, t.stop, t.target]), [['CE', 'Opposite signal', null, null], ['PE', 'Square-off 09:30', null, null]]);
});
