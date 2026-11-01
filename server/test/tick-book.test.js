// Tick book (live feed → latest price and 1-minute candles for Algo Trading): a minute is trusted only when the
// feed was up for all of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTickBook } from '../src/modules/scalper/tick-book.js';

const T0 = Date.parse('2026-10-26T09:15:00+05:30');

test('builds 1-minute candles from ticks and reports the minute that closed', () => {
  const b = createTickBook();
  b.connected(T0 - 30_000);
  assert.equal(b.add('IDX_I:13', { ltp: 100, at: T0 + 100 }), null);
  b.add('IDX_I:13', { ltp: 104, at: T0 + 20_000 });
  b.add('IDX_I:13', { ltp: 99, at: T0 + 40_000 });
  b.add('IDX_I:13', { ltp: 101, at: T0 + 59_900 });
  assert.equal(b.add('IDX_I:13', { ltp: 102, at: T0 + 60_200 }), T0, 'first tick of 09:16 closes 09:15');
  assert.deepEqual((({ open, high, low, close, ticks }) => ({ open, high, low, close, ticks }))(b.minute('IDX_I:13', T0, T0 + 60_300)),
    { open: 100, high: 104, low: 99, close: 101, ticks: 4 });
  assert.equal(b.minute('IDX_I:13', T0 + 60_000, T0 + 60_300), null, '09:16 still forming');
  assert.equal(b.tick('IDX_I:13', { since: T0 + 60_000 }).ltp, 102);
  assert.equal(b.tick('IDX_I:13', { since: T0 + 61_000 }), null, 'stale for a later `since`');
});

test('a minute is not trusted if the feed connected during it or dropped since', () => {
  const b = createTickBook();
  b.connected(T0 + 5_000);   // joined 5 s into 09:15
  b.add('IDX_I:13', { ltp: 100, at: T0 + 6_000 });
  b.add('IDX_I:13', { ltp: 101, at: T0 + 61_000 });
  assert.equal(b.minute('IDX_I:13', T0, T0 + 61_000), null, 'partial 09:15');
  b.connected(null);
  assert.equal(b.minute('IDX_I:13', T0 + 60_000, T0 + 125_000), null, 'feed down');
});
