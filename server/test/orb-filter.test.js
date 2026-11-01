const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { orbEntryFilter, ORB_FILTER } = await import('../../web/js/pages/scalper-chart-signals.js');
const withRsi = { ...ORB_FILTER, rsiOn: true };

const series = closes => closes.map((c, i) => ({ time: 1000 + i * 300, open: c, high: c + 1, low: c - 1, close: c }));
const last = rows => ({ time: rows.at(-1).time });

test('RSI must be inside 25–75: a straight rally (RSI 100) is overbought for CE', () => {
  const up = series(Array.from({ length: 40 }, (_, i) => 23000 + i * 10));
  assert.equal(orbEntryFilter(up, { direction: 'CE', ...last(up) }, { ...ORB_FILTER, rsiOn: false }).ok, true, 'RSI switched off: the EMA gap alone decides');
  assert.match(orbEntryFilter(up, { direction: 'CE', ...last(up) }).reason, /overbought \(needs 25–75\)/, 'on by default at 25–75');
  const f = orbEntryFilter(up, { direction: 'CE', ...last(up) }, withRsi);
  assert.equal(f.ok, false); assert.match(f.reason, /overbought/);
  const down = series(Array.from({ length: 40 }, (_, i) => 23000 - i * 10));
  assert.match(orbEntryFilter(down, { direction: 'PE', ...last(down) }, withRsi).reason, /oversold/);
});

test('EMA 9 must lead EMA 21 in the trade direction by ≥ 0.02% of the price', () => {
  // A gentle up-and-down drift keeps RSI mid-range; then a steady move opens the EMA gap.
  const base = Array.from({ length: 30 }, (_, i) => 23000 + (i % 2 ? 6 : -6));
  const trendDown = series([...base, 22995, 22999, 22990, 22994, 22985, 22989, 22980, 22984]);
  const ok = orbEntryFilter(trendDown, { direction: 'PE', ...last(trendDown) });
  assert.ok(ok.rsi > 30 && ok.rsi < 70, JSON.stringify(ok));
  assert.equal(orbEntryFilter(trendDown, { direction: 'CE', ...last(trendDown) }).ok, false, 'CE against falling EMAs');
  const flat = series(base);
  const f = orbEntryFilter(flat, { direction: 'PE', ...last(flat) });
  assert.equal(f.ok, false); assert.match(f.reason, /EMA/);
});
