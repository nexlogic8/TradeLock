// Admin dashboard: access control, overview shape, alert open/resolve lifecycle.
process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
process.env.ADMIN_EMAILS = 'boss@example.com';
process.env.SMTP_HOST = '';
const { test, before, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { createServer } = await import('node:http');
const { createHandler } = await import('../src/lib/app.js');
const { buildRouter } = await import('../src/modules/index.js');
const { stmt } = await import('../src/db/index.js');
const { conditions, checkAlerts, listAlerts } = await import('../src/modules/admin/alerts.js');

let server, base;
const jar = {};
// Cookie jar like a browser: every Set-Cookie is kept by name; an emptied cookie is removed.
const mergeCookies = (prev, list) => {
  const jar = new Map((prev || '').split('; ').filter(Boolean).map(c => [c.split('=')[0], c]));
  for (const s of list) { const kv = s.split(';')[0]; const k = kv.split('=')[0]; if (kv.endsWith('=')) jar.delete(k); else jar.set(k, kv); }
  return [...jar.values()].join('; ');
};
async function call(who, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body && { 'Content-Type': 'application/json' }), ...(jar[who] && { Cookie: jar[who] }) },
    body: body && JSON.stringify(body),
  });
  jar[who] = mergeCookies(jar[who], res.headers.getSetCookie());
  return { status: res.status, body: await res.json().catch(() => null) };
}

before(async () => {
  server = createServer(createHandler(buildRouter()));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await call('boss', 'POST', '/api/auth/signup', { email: 'boss@example.com', password: 'longpassword' });
  await call('user', 'POST', '/api/auth/signup', { email: 'user@example.com', password: 'longpassword' });
});
after(() => server.close());

const healthy = {
  disk: { usedPct: 20, freeBytes: 20e9 }, memory: { usedPct: 40 }, load: [0.1, 0.1, 0.1], cpus: 2,
  runtime: { errorsLast10m: 0, uptimeMs: 1e6, monitor: { lastTickAt: Date.now() } },
  marketOpen: false, certDaysLeft: 80, backup: { available: true, latestAt: Date.now() },
};
const calm = { trading: { unhealthy: 0 }, wallet: { oldestPendingAt: null, pendingWithdrawals: 0 } };

test('only admins can use the admin API', async () => {
  for (const path of ['/api/admin/me', '/api/admin/overview', '/api/admin/users', '/api/admin/payments', '/api/admin/withdrawals',
    '/api/admin/affiliates', '/api/admin/brokers', '/api/admin/system', '/api/admin/audit', '/api/admin/alerts', '/api/admin/services']) {
    assert.equal((await call('user', 'GET', path)).status, 403, path);
    assert.equal((await call('boss', 'GET', path)).status, 200, path);
  }
  assert.equal((await call('anon', 'GET', '/api/admin/overview')).status, 401);
  const me = (await call('user', 'GET', '/api/auth/me')).body.user;
  assert.equal('isAdmin' in me, false, 'the trader app is not told who the admins are');
});

test('admin console data', async () => {
  const o = (await call('boss', 'GET', '/api/admin/overview')).body;
  assert.equal(o.stats.users.total, 2);
  assert.ok(o.system.memory.totalBytes > 0);
  assert.equal((await call('boss', 'GET', '/api/admin/alerts')).body.email.enabled, false);
  assert.ok((await call('boss', 'GET', '/api/admin/audit?q=signup')).body.items.length >= 2, 'sign-ups are audited');
  assert.deepEqual((await call('boss', 'GET', '/api/admin/users?q=user@')).body.items.map(u => u.email), ['user@example.com']);
  assert.equal((await call('boss', 'POST', '/api/admin/alerts/test')).body.code, 'EMAIL_NOT_CONFIGURED');
});

test('the admin console page is served at /admin and its menus', async () => {
  for (const path of ['/admin', '/admin/users', '/admin/server']) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200, path);
    assert.match(await res.text(), /TradeLock Admin/);
    assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
  }
});

test('alert thresholds', () => {
  assert.deepEqual(conditions(healthy, calm), []);
  const keys = h => conditions({ ...healthy, ...h }, calm).map(c => `${c.key}:${c.level}`);
  assert.deepEqual(keys({ disk: { usedPct: 88, freeBytes: 3e9 } }), ['disk:warn']);
  assert.deepEqual(keys({ disk: { usedPct: 96, freeBytes: 1e9 } }), ['disk:critical']);
  assert.deepEqual(keys({ load: [4, 3.5, 3] }), ['cpu:warn']);
  assert.deepEqual(keys({ certDaysLeft: 3 }), ['cert:critical']);
  assert.deepEqual(keys({ marketOpen: true, runtime: { ...healthy.runtime, monitor: { lastTickAt: Date.now() - 120e3 } } }), ['monitor:critical']);
  assert.deepEqual(keys({ marketOpen: false, runtime: { ...healthy.runtime, monitor: { lastTickAt: null } } }), [], 'stall only matters in market hours');
  assert.deepEqual(keys({ backup: { available: true, latestAt: Date.now() - 40 * 3600e3 } }), ['backup:warn']);
  assert.deepEqual(keys({ backup: { available: false } }), [], 'no backup folder mounted (dev)');
  const late = { ...calm, wallet: { oldestPendingAt: Date.now() - 50 * 3600e3, pendingWithdrawals: 1 } };
  assert.deepEqual(conditions(healthy, late).map(c => c.key), ['withdrawals']);
});

test('an alert opens once, notifies admins, and resolves itself', async () => {
  const boss = stmt('SELECT id FROM users WHERE email = ?').get('boss@example.com').id;
  const notes = () => stmt('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?').get(boss).n;
  const n0 = notes();
  const full = { ...healthy, disk: { usedPct: 90, freeBytes: 3e9 } };
  await checkAlerts(full, calm);
  await checkAlerts(full, calm);
  assert.equal(listAlerts().open.length, 1, 'not duplicated while still active');
  assert.equal(notes(), n0 + 1);
  await checkAlerts(healthy, calm);
  assert.equal(listAlerts().open.length, 0);
  assert.equal(listAlerts().recent[0].key, 'disk');
  assert.equal(notes(), n0 + 2, 'resolution is announced too');
});

test('microservices: status list, token keeper heartbeat, run on demand', async () => {
  const { report, getStatus } = await import('../src/lib/servicestatus.js');
  let svc = (await call('boss', 'GET', '/api/admin/services')).body;
  assert.deepEqual(svc.services.map(s => s.id), ['api', 'monitor', 'alerts', 'httpworker', 'tokenkeeper']);
  assert.equal(svc.services.find(s => s.id === 'tokenkeeper').status, 'down', 'never reported');
  report('tokenkeeper', { started_at: Date.now(), heartbeat_at: Date.now(), last_run_at: Date.now(), last_result: { checked: 2, renewed: 1, expired: 0, failed: 0, skipped: 1 } });
  svc = (await call('boss', 'GET', '/api/admin/services')).body;
  const tk = svc.services.find(s => s.id === 'tokenkeeper');
  assert.equal(tk.status, 'running');
  assert.equal(tk.lastResult.renewed, 1);
  assert.equal((await call('user', 'POST', '/api/admin/services/tokenkeeper/run')).status, 403);
  assert.equal((await call('boss', 'POST', '/api/admin/services/tokenkeeper/run')).status, 200);
  assert.equal(getStatus('tokenkeeper').run_requested, 1, 'the service picks this up on its next heartbeat');
  assert.equal((await call('boss', 'POST', '/api/admin/services/api/run')).status, 400);
});

test('alert when the token keeper stops (production only)', () => {
  const keys = h => conditions({ ...healthy, ...h }, calm).map(c => c.key);
  assert.deepEqual(keys({ expectTokenKeeper: true, tokenKeeper: { heartbeat_at: Date.now() } }), []);
  assert.deepEqual(keys({ expectTokenKeeper: true, tokenKeeper: { heartbeat_at: Date.now() - 10 * 60e3 } }), ['tokenkeeper']);
  assert.deepEqual(keys({ expectTokenKeeper: true, tokenKeeper: null }), ['tokenkeeper']);
  assert.deepEqual(keys({ expectTokenKeeper: false, tokenKeeper: null }), [], 'dev: no token keeper expected');
});
