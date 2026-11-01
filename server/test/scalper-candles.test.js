process.env.DB_PATH = ':memory:';
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { normalizeScalperCandles } = await import('../src/modules/scalper/routes.js');

test('Dhan candle timestamps normalize from seconds, milliseconds and exchange-local strings', () => {
  const expected = Date.parse('2026-10-12T09:15:00+05:30');
  const rows = normalizeScalperCandles({
    timestamp: [String(expected / 1000), '2026-10-12 09:15:00', String(expected)],
    open: [100, 100, 100], high: [102, 102, 102], low: [99, 99, 99], close: [101, 101, 101], volume: [1, 1, 1],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].time, expected);
  assert.equal(rows[0].close, 101);
});

test('Dhan candle history is sorted and invalid bars are discarded', () => {
  const rows = normalizeScalperCandles({
    timestamp: [1800000000, 1799999700, 'bad'],
    open: [102, 100, 1], high: [103, 102, 2], low: [101, 99, 0], close: [102.5, 101, 1], volume: [3, 2, 1],
  });
  assert.equal(rows.length, 2);
  assert.ok(rows[0].time < rows[1].time);
  assert.equal(rows[0].close, 101);
});

test('Dhan option candles carry open interest; index candles default it to zero', () => {
  const rows = normalizeScalperCandles({
    timestamp: [1800000000, 1800000300], open: [10, 11], high: [12, 13], low: [9, 10], close: [11, 12], volume: [50, 60],
    open_interest: [125000, 131250],
  });
  assert.deepEqual(rows.map(r => r.oi), [125000, 131250]);
  const index = normalizeScalperCandles({ timestamp: [1800000000], open: [1], high: [2], low: [0.5], close: [1.5], volume: [0] });
  assert.equal(index[0].oi, 0);
});
