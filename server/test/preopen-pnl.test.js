// Before 09:15 the broker still reports the previous session's closed positions and their P&L (5 Nov 00:01: Dhan
// showed 4 Nov's −₹1,70,128). It must not become today's P&L, low, high or intraday curve.
process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { stmt, flushWrites } = await import('../src/db/index.js');
const { createUser } = await import('../src/modules/auth/service.js');
const { applySnapshot } = await import('../src/modules/risk/monitor.js');
const { dayState, patchDay, intradayPoints } = await import('../src/modules/risk/service.js');

const closedYesterday = { symbol: 'NIFTY-Nov2026-23800-PE', securityId: '39952', qty: 0, realized: -170127.75, unrealized: 0 };
const snap = positions => ({ positions, orders: [], funds: { available: 654754.94, opening: 654754.94 } });

test('before the open: yesterday\'s closed P&L is not today\'s, and an earlier reading is cleared', () => {
  const uid = createUser({ email: 'preopen@pnl.test', password: null, name: 'P' });
  const day = '2026-11-05', m = {};
  // A reading taken before this fix: the day already holds yesterday's loss and a midnight chart point.
  patchDay(uid, day, { realized: -170127.75, worst: -170127.75 });
  stmt('INSERT INTO pnl_points (user_id, day, minute, pnl) VALUES (?, ?, ?, ?)').run(uid, day, 1, -170127.75);
  applySnapshot(uid, { day, minutes: 30 }, snap([closedYesterday]), m);
  flushWrites();
  const s = dayState(uid, day);
  assert.deepEqual([s.realized, s.unrealized, s.worst, s.peak], [0, 0, 0, 0]);
  assert.equal(intradayPoints(uid, day).filter(p => p.minute < 555).length, 0, 'no chart points before 09:15');
});

test('after the open the broker\'s P&L counts as before', () => {
  const uid = createUser({ email: 'open@pnl.test', password: null, name: 'P' });
  const day = '2026-11-06', m = {};
  applySnapshot(uid, { day, minutes: 556 }, snap([{ ...closedYesterday, realized: -5000 }]), m);
  flushWrites();
  const s = dayState(uid, day);
  assert.deepEqual([s.realized, s.worst], [-5000, -5000]);
});
