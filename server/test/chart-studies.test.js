import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STUDIES, computeStudy, newStudy, defaultStudies, sanitizeStudies, emaOf, smaOf } from '../../web/js/pages/chart-studies.js';

const t0 = Date.parse('2026-10-19T09:15:00+05:30') / 1000;
const bars = closes => closes.map((c, i) => ({ time: t0 + i * 300, open: c, high: c + 1, low: c - 1, close: c, volume: 100 }));
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('EMA is seeded with the first value (as the chart was); SMA starts after its length', () => {
  assert.deepEqual(emaOf([10, 20], 3), [10, 15]);
  assert.deepEqual(smaOf([1, 2, 3, 4], 3), [null, null, 2, 3]);
  const s = computeStudy(newStudy('sma', { length: 3 }), bars([1, 2, 3, 4]));
  assert.deepEqual(s.value.map(p => p.value), [2, 3]);
  assert.equal(s.value[0].time, t0 + 600);
});

test('RSI: all gains → 100, mirror image → 100 − RSI; Bollinger bands are symmetric', () => {
  const up = computeStudy(newStudy('rsi', { length: 3 }), bars([1, 2, 3, 4, 5, 6]));
  assert.equal(up.value.at(-1).value, 100);
  // A series and its mirror image give RSIs that add up to 100.
  const path = [10, 11, 10.5, 12, 11, 13, 12.5, 12, 14], mirror = path.map(x => 24 - x);
  const r1 = computeStudy(newStudy('rsi', { length: 3 }), bars(path)).value.at(-1).value;
  const r2 = computeStudy(newStudy('rsi', { length: 3 }), bars(mirror)).value.at(-1).value;
  near(r1 + r2, 100); assert.ok(r1 > 50 && r1 < 100);
  const bb = computeStudy(newStudy('bb', { length: 3, mult: 2 }), bars([1, 2, 3]));
  near(bb.middle[0].value, 2); near(bb.upper[0].value - 2, 2 - bb.lower[0].value);
});

test('VWAP restarts each session; MACD has macd/signal/hist; Supertrend flips with the trend', () => {
  const day2 = bars([200, 200]).map((b, i) => ({ ...b, time: t0 + 86400 + i * 300 }));
  const v = computeStudy(newStudy('vwap', { source: 'close' }), [...bars([100, 110]), ...day2]);
  near(v.value[1].value, 105); near(v.value[2].value, 200, 1e-9);
  const m = computeStudy(newStudy('macd', { fast: 3, slow: 6, signal: 3 }), bars(Array.from({ length: 30 }, (_, i) => 100 + i)));
  assert.ok(m.macd.at(-1).value > 0 && m.hist.length === 30 && m.signal.length === 30);
  const rising = Array.from({ length: 30 }, (_, i) => 100 + i * 2), falling = Array.from({ length: 30 }, (_, i) => 160 - i * 3);
  const st = computeStudy(newStudy('supertrend', { length: 5, factor: 1 }), bars([...rising, ...falling]));
  const lastTime = t0 + 59 * 300;
  assert.ok(st.down.some(p => p.time === lastTime), 'down trend at the end');
  assert.ok(st.up.some(p => p.time === t0 + 29 * 300), 'up trend while rising');
});

test('defaults are EMA 9 + EMA 21; saved lists are cleaned', () => {
  assert.deepEqual(defaultStudies().map(s => [s.type, s.params.length]), [['ema', 9], ['ema', 21]]);
  const cleaned = sanitizeStudies([{ type: 'ema', params: { length: 9999, source: 'nope' }, colors: { value: '#ff0000', x: 'red' }, width: 9 }, { type: 'evil' }]);
  assert.equal(cleaned.length, 1);
  assert.deepEqual([cleaned[0].params.length, cleaned[0].params.source, cleaned[0].colors, cleaned[0].width], [500, 'close', { value: '#ff0000' }, 2]);
  assert.equal(sanitizeStudies('x'), null);
  assert.ok(Object.values(STUDIES).every(d => d.lines.length && typeof d.title(Object.fromEntries(d.params.map(([k, , v]) => [k, v]))) === 'string'));
});
