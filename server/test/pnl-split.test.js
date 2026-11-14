// Overview intraday chart: the day's P&L split into Algo Trading (its contracts' positions) and manual trading.
process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { stmt, flushWrites } = await import('../src/db/index.js');
const { createUser } = await import('../src/modules/auth/service.js');
const { algoSecurityIds, algoPnlOf, recordPoint, intradayPoints } = await import('../src/modules/risk/service.js');
const { pnlSplit } = await import('../../web/js/pages/overview-sl.js');

const trade = (uid, key, day, status, securityId, closedAt = null) =>
  stmt(`INSERT INTO auto_trades (user_id, day, signal_key, direction, status, security_id, detail, created_at, closed_at)
        VALUES (?, ?, ?, 'CE', ?, ?, '{}', ?, ?)`).run(uid, day, key, status, securityId, Date.now(), closedAt);

test('Algo contracts today: today\'s trades, ones still open from before, and ones closed today', () => {
  const uid = createUser({ email: 'split@pnl.test', password: null, name: 'S' });
  trade(uid, 'a', '2026-11-16', 'open', '111');
  trade(uid, 'b', '2026-11-13', 'open', '222');                                                    // overnight, still held
  trade(uid, 'c', '2026-11-13', 'closed', '333', Date.parse('2026-11-16T09:20:00+05:30'));         // overnight, sold today
  trade(uid, 'd', '2026-11-13', 'closed', '444', Date.parse('2026-11-13T15:00:00+05:30'));         // an earlier day
  trade(uid, 'e', '2026-11-16', 'failed', null);
  assert.deepEqual([...algoSecurityIds(uid, '2026-11-16')].sort(), ['111', '222', '333']);
});

test('Algo P&L = its positions (realized + open); null when Algo Trading has no contract today', () => {
  const positions = [
    { securityId: '111', realized: 500, unrealized: -120 },
    { securityId: '999', realized: -300, unrealized: 50 },   // a manual trade
  ];
  assert.equal(algoPnlOf(positions, new Set(['111'])), 380);
  assert.equal(algoPnlOf(positions, new Set()), null);
});

test('points keep the Algo part; the chart splits them into Algo and Manual lines', () => {
  const uid = createUser({ email: 'points@pnl.test', password: null, name: 'P' });
  recordPoint(uid, '2026-11-16', 555, 0);
  recordPoint(uid, '2026-11-16', 560, 1000, 1500);
  recordPoint(uid, '2026-11-16', 561, -200, 300.456);
  flushWrites();
  const pts = intradayPoints(uid, '2026-11-16');
  assert.deepEqual(pts.map(p => [p.minute, p.pnl, p.algo]), [[555, 0, null], [560, 1000, 1500], [561, -200, 300.46]]);
  const s = pnlSplit(pts);
  assert.deepEqual(s.algo, [[555, 0], [560, 1500], [561, 300.46]]);
  assert.deepEqual(s.manual.map(p => [p[0], Math.round(p[1] * 100) / 100]), [[555, 0], [560, -500], [561, -500.46]]);
  assert.equal(s.both, true);
  assert.equal(pnlSplit([{ minute: 555, pnl: 0, algo: null }, { minute: 560, pnl: 400, algo: null }]), null, 'no Algo trade today: no split');
  assert.equal(pnlSplit([{ minute: 555, pnl: 0, algo: 0 }, { minute: 560, pnl: 400, algo: 400 }]).both, false, 'only Algo moved: the total line is enough');
});
