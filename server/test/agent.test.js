// Agent start/stop on a calm day: stopping turns monitoring and enforcement off; starting resumes.
process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
const { test, before, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { createServer } = await import('node:http');
const { createHandler } = await import('../src/lib/app.js');
const { buildRouter } = await import('../src/modules/index.js');

let server, base, cookie = '';
// Cookie jar like a browser: every Set-Cookie is kept by name; an emptied cookie is removed.
const mergeCookies = (prev, list) => {
  const jar = new Map((prev || '').split('; ').filter(Boolean).map(c => [c.split('=')[0], c]));
  for (const s of list) { const kv = s.split(';')[0]; const k = kv.split('=')[0]; if (kv.endsWith('=')) jar.delete(k); else jar.set(k, kv); }
  return [...jar.values()].join('; ');
};
async function call(method, path, body) {
  const res = await fetch(base + path, { method, headers: { ...(body && { 'Content-Type': 'application/json' }), ...(cookie && { Cookie: cookie }) }, body: body && JSON.stringify(body) });
  cookie = mergeCookies(cookie, res.headers.getSetCookie());
  return { status: res.status, body: await res.json().catch(() => null) };
}
before(async () => {
  server = createServer(createHandler(buildRouter()));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await call('POST', '/api/auth/signup', { email: 'agent@example.com', password: 'longpassword' });
  // Loosen the trade cap so the demo morning (2 entries) doesn't count as a limit hit.
  const { body } = await call('GET', '/api/rules');
  await call('PUT', '/api/rules', { rules: { ...body.active, maxTrades: { ...body.active.maxTrades, value: 10 } } });
});
after(() => server.close());

test('connect reports order access from the broker', async () => {
  const r = await call('POST', '/api/brokers/connect', { broker: 'mock' });
  assert.ok(r.body.checks.find(c => c.id === 'orders').ok);
  assert.equal(r.body.account.permissions.ordersAllowed, true);
});

test('stop and start the agent', async () => {
  const id = (await call('GET', '/api/brokers')).body.account.id;
  const stop = await call('POST', `/api/brokers/${id}/agent`, { on: false });
  assert.equal(stop.status, 200);
  assert.equal(stop.body.account.agentOn, false);
  assert.equal((await call('GET', '/api/dashboard')).body.broker.agentOn, false);
  const start = await call('POST', `/api/brokers/${id}/agent`, { on: true });
  assert.equal(start.body.account.agentOn, true);
  const notes = (await call('GET', '/api/notifications')).body.items.map(n => n.title);
  assert.ok(notes.includes('TradeLock agent stopped') && notes.includes('TradeLock agent started'));
});

test('meta exposes the server IP field for whitelisting', async () => {
  const meta = (await call('GET', '/api/meta')).body;
  assert.ok('serverIp' in meta);
});
