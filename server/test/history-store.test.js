import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openHistory } from '../src/modules/backtest/history-store.js';

test('history store: saves option and index candles, logs requests, reads a time range back', () => {
  const h = openHistory(':memory:');
  const t0 = Date.parse('2026-08-14T09:15:00+05:30') / 1000;
  const rows = [0, 1, 2].map(i => ({ time: t0 + i * 60, strike: 24350, open: 150 + i, high: 151 + i, low: 149 + i, close: 150.5 + i, volume: 1000, oi: 5e6, iv: 12.5, spot: 24360 }));
  assert.equal(h.fetched('option', 'NIFTY', 1, 'CE', 0, '2026-08-01', '2026-09-10'), false);
  h.saveOptions('NIFTY', 1, 'CE', 0, '2026-08-01', '2026-09-10', rows);
  h.saveOptions('NIFTY', 1, 'CE', 0, '2026-08-01', '2026-09-10', rows);   // re-saving the same request replaces, not duplicates
  assert.equal(h.fetched('option', 'NIFTY', 1, 'CE', 0, '2026-08-01', '2026-09-10'), true);
  const got = h.options('NIFTY', 1, t0, t0 + 120);
  assert.equal(got.length, 2, 'end of the range is exclusive');
  assert.deepEqual({ ...got[0] }, { side: 'CE', offset: 0, time: t0, strike: 24350, open: 150, high: 151, low: 149, close: 150.5, volume: 1000, oi: 5e6, iv: 12.5, spot: 24360 });
  h.saveIndex('NIFTY', '2026-08-01', '2026-08-20', [{ time: t0, open: 24360, high: 24370, low: 24350, close: 24365 }]);
  assert.equal(h.index('NIFTY', t0, t0 + 60)[0].close, 24365);
  const s = h.summary();
  assert.equal(s.options[0].rows, 3); assert.equal(s.index[0].rows, 1); assert.equal(s.requests, 2);
  h.close();
});

test('history store: missing volume / OI / IV are stored as null', () => {
  const h = openHistory(':memory:');
  h.saveOptions('NIFTY', 2, 'PE', -3, '2026-01-01', '2026-02-10', [{ time: 100, strike: 23000, open: 1, high: 2, low: 0.5, close: 1.5, volume: undefined, oi: 'x', iv: null, spot: 23100 }]);
  const [r] = h.options('NIFTY', 2, 0, 200);
  assert.equal(r.volume, null); assert.equal(r.oi, null); assert.equal(r.iv, null); assert.equal(r.offset, -3);
  h.close();
});
