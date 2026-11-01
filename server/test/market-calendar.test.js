// NSE calendar for the Android app's sleep schedule: weekends and holidays closed, next open skips both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closedReason, isMarketDay, sessionInfo } from '../src/lib/market-calendar.js';

const ist = s => Date.parse(`${s}+05:30`);
const hhmm = ms => new Date(ms + 19_800_000).toISOString().slice(0, 16).replace('T', ' ');

test('weekends and NSE holidays are closed, ordinary weekdays trade', () => {
  assert.equal(closedReason('2026-10-24'), 'Saturday');
  assert.equal(closedReason('2026-10-20'), 'Dussehra');
  assert.equal(isMarketDay('2026-10-26'), true);
  assert.equal(isMarketDay('2026-11-10'), false);
});

test('session: today before the open, in it, after it; the next open skips weekends and holidays', () => {
  assert.deepEqual([sessionInfo(ist('2026-10-26T08:00:00')).open, hhmm(sessionInfo(ist('2026-10-26T08:00:00')).nextOpenAt)], [false, '2026-10-26 09:15']);
  const mid = sessionInfo(ist('2026-10-26T10:00:00'));
  assert.deepEqual([mid.tradingDay, mid.open, hhmm(mid.closeAt), mid.nextDay], [true, true, '2026-10-26 15:30', '2026-10-27']);
  assert.equal(hhmm(sessionInfo(ist('2026-10-24T10:00:00')).nextOpenAt), '2026-10-26 09:15', 'Saturday → Monday');
  assert.equal(sessionInfo(ist('2026-11-09T16:00:00')).nextDay, '2026-11-11', 'skips the 10 Nov holiday');
  assert.equal(sessionInfo(ist('2026-12-24T16:00:00')).nextDay, '2026-12-28', 'Christmas and the weekend');
  const hol = sessionInfo(ist('2026-11-10T09:00:00'));
  assert.deepEqual([hol.tradingDay, hol.closed, hol.openAt], [false, 'Diwali Balipratipada', null]);
});
