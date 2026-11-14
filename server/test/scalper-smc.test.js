// Power Scalper chart overlays: Fair Value Gaps and Smart Money Concepts (web/js/pages/scalper-chart-smc.js).
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { fairValueGaps, marketStructure } = await import('../../web/js/pages/scalper-chart-smc.js');

const bar = (open, high, low, close) => ({ open, high, low, close });

test('FVG: a bullish 3-candle gap, filled later; a bearish one left open', () => {
  const bars = [
    bar(100, 101, 99, 100.5), bar(101, 106, 100.8, 105.5), bar(106, 108, 103, 107),   // 103 > 101: bull gap 101..103
    bar(107, 107.5, 102, 102.5),                                                        // trades down through 101? no (low 102)
    bar(102, 102.5, 100.5, 101),                                                         // low 100.5 <= 101: filled here (index 4)
    bar(101, 101.2, 94, 94.5), bar(94, 94.5, 90, 91),                                   // 91..? bear gap: candle 7 high < candle 5 low
    bar(91, 92, 88, 89),                                                                 // high 92 < 100.5 (bar 4 low): bear gap 92..100.5? no: needs bar 5
  ];
  const gaps = fairValueGaps(bars);
  const bull = gaps.find(g => g.kind === 'bull');
  assert.deepEqual([bull.bottom, bull.top, bull.start, bull.end], [101, 103, 1, 4]);
  const bear = gaps.find(g => g.kind === 'bear' && g.start === 6);
  assert.ok(bear, 'bear gap between bar 5 (low 94) and bar 7 (high 92)');
  assert.deepEqual([bear.top, bear.bottom, bear.end], [94, 92, null]);
});

test('SMC: a swing high broken upward is a BOS in an up move, a later low broken is a CHoCH; order block = last down candle', () => {
  // Rise, swing high at 10, pull back with a down candle, break above it (BOS up), then a swing low and a break below (CHoCH down).
  const highs = [100, 101, 102, 103, 104, 110, 105, 104, 103, 102, 101, 103, 106, 112, 114, 113, 112, 108, 107, 106, 105, 104, 100, 99, 98];
  const bars = highs.map((h, i) => {
    const down = [9, 10, 18, 19, 20, 21, 22, 23, 24].includes(i);
    return down ? bar(h - 0.5, h, h - 3, h - 2.5) : bar(h - 2.5, h, h - 3, h - 0.5);
  });
  const { events, blocks } = marketStructure(bars, 0, bars.length - 1, 2);
  const up = events.find(e => e.dir === 'up');
  assert.equal(up.kind, 'BOS', 'first break: no trend yet, so BOS');
  assert.equal(up.price, 110);
  const down = events.find(e => e.dir === 'down');
  assert.ok(down && down.kind === 'CHoCH', 'break against the up trend is a change of character');
  const ob = blocks.find(b => b.dir === 'up');
  assert.ok(ob, 'bullish order block found');
  assert.ok(bars[ob.start].close < bars[ob.start].open, 'the order block is a down candle');
  assert.ok(ob.start < up.at);
});

test('SMC: no look-ahead: a swing is used only once confirmed by the bars after it', () => {
  const bars = [bar(1, 2, 0.5, 1.5), bar(1.5, 3, 1, 2.5), bar(2.5, 5, 2, 4.5), bar(4.5, 4.8, 3, 3.5), bar(3.5, 4.5, 3.2, 4.4), bar(4.4, 6, 4.3, 5.9)];
  // len 2: the high 5 at bar 2 is confirmed at bar 4 (bars 3 and 4 are lower); bar 5 closes 5.9 > 5: the break.
  const { events } = marketStructure(bars, 0, 5, 2);
  assert.deepEqual(events.map(e => [e.kind, e.at, e.price]), [['BOS', 5, 5]]);
  // Before bar 4 the swing is not confirmed yet, so even a higher close would not count.
  assert.equal(marketStructure(bars, 0, 3, 2).events.length, 0);
});

test('ICT: resting BSL / SSL, an equal high, a sweep, the dealing range and the OTE zone', async () => {
  const { ictLevels } = await import('../../web/js/pages/scalper-chart-smc.js');
  // Highs: swing 110 at bar 3, an equal 110.05 at bar 9, then a wick to 111 closing back below (sweep) at bar 13.
  const hl = [[100, 96], [104, 99], [107, 102], [110, 105], [106, 101], [103, 97], [101, 95], [104, 98], [107, 101], [110.05, 104], [106, 100], [103, 98], [104, 99], [111, 103]];
  const bars = hl.map(([h, l], i) => ({ open:l + 1, high:h, low:l, close: i === 13 ? 108 : h - 1 }));
  const { liquidity, range, ote } = ictLevels(bars, 0, bars.length - 1, 2);
  const highs = liquidity.filter(l => l.side === 'high');
  assert.deepEqual(highs.map(l => l.price), [110, 110.05]);
  assert.equal(highs[1].equal, true, 'within 10% of the average range: an equal high');
  assert.deepEqual([highs[1].taken, highs[1].sweep], [13, true], 'wick above, close back below: a sweep');
  const low = liquidity.find(l => l.side === 'low' && l.price === 95);
  assert.ok(low && low.taken == null, 'the 95 low is still resting sell-side liquidity');
  assert.deepEqual([range.high, range.low, range.eq], [110.05, 98, 104.025]);
  // Last leg: low 98 (bar 11) is after the high 110.05 (bar 9): a down leg, so the OTE is 62–79% back up.
  assert.equal(ote.dir, 'down');
  assert.ok(Math.abs(ote.bottom - (98 + 0.62 * 12.05)) < 1e-9 && Math.abs(ote.top - (98 + 0.79 * 12.05)) < 1e-9);
});
