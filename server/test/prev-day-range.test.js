import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previousDayRange } from '../../web/js/pages/scalper.js';

const at = (day, hhmm) => Date.parse(`${day}T${hhmm}:00+05:30`);
const bar = (day, hhmm, high, low) => ({ time: at(day, hhmm), open: low, high, low, close: high });
const rows = [
  bar('2026-10-16', '09:15', 23400, 23300), bar('2026-10-16', '15:25', 23500, 23350),   // older session: higher high
  bar('2026-10-19', '09:15', 23175.25, 23000), bar('2026-10-19', '14:00', 23100, 22845),
  bar('2026-10-20', '09:15', 22950, 22880),                                              // today: ignored
];
const now = at('2026-10-20', '11:00');

test('previous day = the last session before today, not the whole history', () => {
  assert.deepEqual(previousDayRange(rows, now), { day: '2026-10-19', high: 23175.25, low: 22845 });
});

test('chart rows in seconds give the same range as API rows in ms', () => {
  const seconds = rows.map(r => ({ ...r, time: Math.floor(r.time / 1000) }));
  assert.deepEqual(previousDayRange(seconds, now), previousDayRange(rows, now));
});

test('market closed (weekend): the last session counts; no earlier session → null', () => {
  assert.equal(previousDayRange(rows, at('2026-10-24', '10:00')).day, '2026-10-20');
  assert.equal(previousDayRange([bar('2026-10-20', '09:15', 1, 0)], now), null);
});
