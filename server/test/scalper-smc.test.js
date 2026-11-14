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
