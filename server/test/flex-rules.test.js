// Flexible-discipline accounts: raising the daily loss limit above today's loss lifts today's max-loss pause;
// a strict account keeps the pause, and a raised limit that is still below the loss keeps it too.
process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
process.env.FLEX_USER_IDS = '1';
const { test, before, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { createServer } = await import('node:http');
const { createHandler } = await import('../src/lib/app.js');
const { buildRouter } = await import('../src/modules/index.js');
const { stmt } = await import('../src/db/index.js');
const { dayState, patchDay, algoLocked } = await import('../src/modules/risk/service.js');
const { getRules } = await import('../src/modules/rules/service.js');

let server, base;
const users = {};
before(async () => {
  server = createServer(createHandler(buildRouter()));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const email of ['flex@example.com', 'strict@example.com']) {
    const res = await fetch(base + '/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'longpassword' }) });
    users[email] = { cookie: res.headers.getSetCookie().map(c => c.split(';')[0]).join('; '), id: stmt('SELECT id FROM users WHERE email = ?').get(email).id };
  }
});
after(() => server.close());

const lockAt = (uid, loss) => {
  const s = dayState(uid);
  patchDay(uid, s.day, { capital: 52_590, realized: -loss, paused: 1, pause_reason: 'rule:maxLoss', fired: ['maxLoss.breach'] });
};
const saveLimit = (u, pct) => {
  const rules = structuredClone(getRules(u.id).active);
  rules.maxLoss = { ...rules.maxLoss, on: true, mode: 'percent', value: pct };
  return fetch(base + '/api/rules', { method: 'PUT', headers: { 'Content-Type': 'application/json', cookie: u.cookie }, body: JSON.stringify({ rules }) });
};

test('flexible account: a limit raised above the loss unlocks today; still below it, the lock stays', async () => {
  const u = users['flex@example.com'];
  assert.equal(u.id, 1);
  lockAt(u.id, 3268);
  await saveLimit(u, 6);                     // 6% of 52,590 = 3,155 < 3,268 lost: still hit
  assert.equal(dayState(u.id).paused, 1);
  await saveLimit(u, 8);                     // 8% = 4,207: back inside
  const s = dayState(u.id);
  assert.deepEqual([s.paused, s.pause_reason, s.fired.includes('maxLoss.breach')], [0, null, false]);
  assert.equal(algoLocked({ user_id: u.id, algo_on: 1 }, Date.parse('2026-10-27T10:30:00+05:30')), false, 'Algo Trading can be switched off in market hours');
});

test('strict account: raising the limit does not lift a pause hit today', async () => {
  const u = users['strict@example.com'];
  lockAt(u.id, 3268);
  await saveLimit(u, 20);
  assert.equal(dayState(u.id).paused, 1);
  assert.equal(algoLocked({ user_id: u.id, algo_on: 1 }, Date.parse('2026-10-27T10:30:00+05:30')), true);
});
