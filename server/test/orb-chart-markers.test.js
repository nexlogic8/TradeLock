const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { openingRangeChartSignals, openingRangeMarkers, alignMarkersToBars } = await import('../../web/js/pages/scalper-chart-signals.js');

const at = (hhmm, day = '2026-10-15') => Date.parse(`${day}T${hhmm}:00+05:30`) / 1000;
const bar = (hhmm, open, high, low, close) => ({ time:at(hhmm), open, high, low, close, volume:1 });
const later = Date.parse('2026-10-15T15:30:00+05:30');

test('5-minute chart: 09:15 candle is the range; close above, then a green candle breaking its high', () => {
  const rows = [
    bar('09:15', 100, 110, 95, 105),   // range 95-110
    bar('09:20', 105, 109, 101, 108),  // inside
    bar('09:25', 108, 115, 107, 114),  // breakout close above 110
    bar('09:30', 114, 120, 113, 119),  // breaks 115, green, real body → entry
    bar('09:35', 119, 121, 117, 118),
  ];
  const [s] = openingRangeChartSignals(rows, { intervalMs:300_000, now:later });
  assert.deepEqual([s.direction, s.breakoutAt, s.time, s.entry], ['CE', at('09:25'), at('09:30'), 119]);
  const spot = openingRangeMarkers([s], 'spot'), ce = openingRangeMarkers([s], 'ce'), pe = openingRangeMarkers([s], 'pe');
  assert.deepEqual(spot.map(m => [m.time, m.shape]), [[at('09:25'), 'circle'], [at('09:30'), 'arrowUp']]);
  assert.deepEqual(ce.map(m => [m.time, m.shape]), [[at('09:25'), 'circle'], [at('09:30'), 'arrowUp']], 'premium chart: breakout dot + BUY arrow'); assert.match(ce[1].text, /BUY CE/);
  assert.equal(pe.length, 0, 'an upside breakout is not marked on the PE chart');
});

test('1-minute chart: range from 09:15-09:19 bars; downside breakout with a red confirmation', () => {
  const rows = [
    bar('09:15', 100, 104, 99, 102), bar('09:16', 102, 105, 100, 101), bar('09:17', 101, 103, 98, 99),
    bar('09:18', 99, 102, 97, 100), bar('09:19', 100, 103, 99, 101),          // range 97-105
    bar('09:20', 101, 102, 98, 99),                                            // inside
    bar('09:21', 99, 99, 94, 95),                                              // close below 97
    bar('09:22', 95, 95.5, 90, 91),                                            // breaks 94, red → entry
  ];
  const [s] = openingRangeChartSignals(rows, { intervalMs:60_000, now:later });
  assert.deepEqual([s.direction, s.time, s.entry], ['PE', at('09:22'), 91]);
  assert.equal(openingRangeMarkers([s], 'pe')[1].shape, 'arrowUp', 'buying the put is an up arrow on the PE chart');
});

test('no markers on other intervals, or before the range completes', () => {
  const rows = [bar('09:15', 100, 110, 95, 105), bar('09:30', 105, 120, 104, 119)];
  assert.deepEqual(openingRangeChartSignals(rows, { intervalMs:900_000, now:later }), []);
  assert.deepEqual(openingRangeChartSignals(rows, { intervalMs:300_000, now:Date.parse('2026-10-15T09:18:00+05:30') }), []);
});

test('stays armed: a failed confirmation outside the range does not wait for a return inside (14 Oct)', () => {
  const rows = [
    bar('09:15', 100, 105, 97, 101), bar('09:16', 101, 104, 99, 102), bar('09:17', 102, 103, 98, 100),
    bar('09:18', 100, 102, 99, 101), bar('09:19', 101, 103, 100, 102),        // range 97-105
    bar('09:20', 102, 103, 100, 101),
    bar('13:00', 99, 99.5, 95, 95.5),    // closes below 97: breakout candle
    bar('13:01', 95, 96, 94, 95.8),      // breaks 95 but closes GREEN: not confirmed; still below the range
    bar('13:02', 95.5, 95.6, 91, 91.5),  // breaks 13:01's low (94), red, real body → confirmed
  ];
  const [s] = openingRangeChartSignals(rows, { intervalMs:60_000, now:later });
  assert.deepEqual([s.direction, s.breakoutAt, s.time, s.entry], ['PE', at('13:01'), at('13:02'), 91.5]);
});

test('premium markers move to the option\'s next candle when that minute had no trade, same session only', () => {
  const markers = [{ time:at('09:25'), text:'dot' }, { time:at('09:30'), text:'arrow' }, { time:at('15:29'), text:'late' }];
  const option = [bar('09:24', 1, 1, 1, 1), bar('09:27', 1, 1, 1, 1), bar('09:30', 1, 1, 1, 1), bar('09:15', 1, 1, 1, 1)].map(r => ({ ...r }));
  option.push({ ...bar('09:15', 1, 1, 1, 1), time:at('09:15', '2026-10-16') });   // next day: never used for a 15 Oct marker
  assert.deepEqual(alignMarkersToBars(markers, option).map(m => [m.text, m.time]), [['dot', at('09:27')], ['arrow', at('09:30')]]);
});

test('several trades a session: opposite side any time, same side only after a close back inside', () => {
  const rows = [
    bar('09:15', 100, 105, 97, 101), bar('09:16', 101, 104, 99, 102), bar('09:17', 102, 103, 98, 100),
    bar('09:18', 100, 102, 99, 101), bar('09:19', 101, 103, 100, 102),        // range 97-105
    bar('09:21', 99, 99, 94, 95), bar('09:22', 95, 95.5, 90, 91),             // PE #1
    bar('09:23', 91, 92, 88, 89), bar('09:24', 89, 89.5, 85, 86),             // still below, red breaks: no repeat PE
    bar('09:30', 90, 101, 90, 100),                                            // back inside: re-arms
    bar('09:40', 100, 107, 100, 106), bar('09:41', 106, 110, 105.5, 109),     // CE #2
    bar('10:00', 104, 104, 100, 101),                                          // inside
    bar('10:05', 100, 100, 95, 96), bar('10:06', 96, 96, 92, 93),             // PE #3
  ];
  const signals = openingRangeChartSignals(rows, { intervalMs:60_000, now:later });
  assert.deepEqual(signals.map(s => [s.direction, s.time]), [['PE', at('09:22')], ['CE', at('09:41')], ['PE', at('10:06')]]);
  assert.equal(openingRangeMarkers(signals, 'spot').length, 6, 'a dot and an arrow per trade');
});
