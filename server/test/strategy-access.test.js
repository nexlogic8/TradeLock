// Users (not administrators) get the default strategy only, Gap open 09:15, without its rules: the private
// strategies count as off and can't be switched on, the Gap backtest is refused, and notices stay plain.
process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
process.env.ADMIN_EMAILS = 'boss@example.com';
const { test, before, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { createServer } = await import('node:http');
const { createHandler } = await import('../src/lib/app.js');
const { buildRouter } = await import('../src/modules/index.js');
const { stmt } = await import('../src/db/index.js');
const { upsertAccount } = await import('../src/modules/broker/registry.js');
const { isAdminUser, withAllowedStrategies } = await import('../src/lib/access.js');

let server, base;
const signup = async email => {
  const res = await fetch(`${base}/api/auth/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'longpassword' }) });
  return { cookie: res.headers.getSetCookie().map(c => c.split(';')[0]).join('; '), id: stmt('SELECT id FROM users WHERE email = ?').get(email).id };
};
before(async () => {
  server = createServer(createHandler(buildRouter()));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('admins keep every strategy; users only Gap (the private switches count as off)', async () => {
  const boss = await signup('boss@example.com'), user = await signup('user@example.com');
  assert.equal(isAdminUser(boss.id), true);
  assert.equal(isAdminUser(user.id), false);
  const row = { user_id: user.id, gap_on: 1, orb_on: 1, cross_on: 1, ema915_on: 1 };
  assert.deepEqual([withAllowedStrategies(row).gap_on, withAllowedStrategies(row).orb_on, withAllowedStrategies(row).cross_on, withAllowedStrategies(row).ema915_on], [1, 0, 0, 0]);
  assert.equal(withAllowedStrategies({ ...row, user_id: boss.id }).orb_on, 1);
  const me = await (await fetch(`${base}/api/auth/me`, { headers: { Cookie: user.cookie } })).json().catch(() => ({}));
  if (me.user) assert.equal(me.user.admin, false, 'the web app is told who is an admin');
});

test('users can switch Gap but not the private strategies; the Gap backtest is admin-only', async () => {
  const user = await signup('user2@example.com');
  const acct = upsertAccount(user.id, { broker: 'dhan', clientId: 'C555', accessToken: 'test-token-not-real-0123456789' });
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: user.cookie }, body: JSON.stringify(body) });
  const orb = await post(`/api/brokers/${acct.id}/strategies`, { orb: true });
  assert.equal(orb.status, 400);
  assert.match((await orb.json()).message, /not available/);
  const gap = await post(`/api/brokers/${acct.id}/strategies`, { gap: true });
  assert.equal(gap.status, 200);
  const off = await post(`/api/brokers/${acct.id}/strategies`, { orb: false });
  assert.equal(off.status, 200, 'switching a private strategy off is always allowed');
  const bt = await post('/api/scalper/backtest-runs', { strategy: 'gap', startDate: '2026-10-01', endDate: '2026-10-30' });
  assert.equal(bt.status, 400);
  const caps = await (await fetch(`${base}/api/scalper/backtest-capabilities`, { headers: { Cookie: user.cookie } })).json();
  assert.equal(caps.gap, null, 'no Gap backtest settings for users');
});
