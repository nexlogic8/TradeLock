// Kill switch flow on the demo broker: breach arms it, going flat activates it, then all entries are blocked.
process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
const { test, before, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { createServer } = await import('node:http');
const { createHandler } = await import('../src/lib/app.js');
const { buildRouter } = await import('../src/modules/index.js');
const { syncAccount } = await import('../src/modules/risk/monitor.js');
const { accountFor } = await import('../src/modules/broker/registry.js');

let server, base, cookie = '', uid;
const wait = ms => new Promise(r => setTimeout(r, ms));
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
const sync = async () => { await syncAccount(accountFor(uid), { force: true }); await wait(150); };

before(async () => {
  server = createServer(createHandler(buildRouter()));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  uid = (await call('POST', '/api/auth/signup', { email: 'ks@example.com', password: 'longpassword' })).body.user.id;
  const conn = await call('POST', '/api/brokers/connect', { broker: 'mock' });
  // A new broker account starts on Paper (Paper first): the kill switch flow runs on the real (demo) broker.
  await call('POST', `/api/brokers/${conn.body.account.id}/paper`, { on: false });
  // Real starts fresh (Protection off until switched on): switch it on.
  await call('POST', `/api/brokers/${conn.body.account.id}/agent`, { on: true });
});
after(() => server.close());

test('kill switch is on by default for new accounts', async () => {
  const { body } = await call('GET', '/api/rules');
  assert.equal(body.active.killSwitch.on, true);
  const d = (await call('GET', '/api/dashboard')).body;
  assert.equal(d.killSwitch.enabled, true);
  assert.equal(d.killSwitch.supported, true);
});

/** Cancel pending orders and exit open positions (one trade at a time needs a flat book). */
async function flatten(sync) {
  const d = (await call('GET', '/api/dashboard')).body;
  for (const o of d.orders) await call('DELETE', `/api/orders/${o.id}`);
  for (const p of d.positions.filter(p => p.qty !== 0)) {
    const r = await call('POST', '/api/orders', { symbol: p.symbol, side: p.qty > 0 ? 'SELL' : 'BUY', qty: Math.abs(p.qty) });
    assert.equal(r.status, 201, `exit of ${p.symbol}`);
  }
  await sync();
}

test('trade cap arms the kill switch without touching the open trade', async () => {
  await flatten(sync);
  const third = await call('POST', '/api/orders', { symbol: 'NIFTY 25000 CE', side: 'BUY', qty: 75 });
  assert.equal(third.status, 201);
  await sync();
  const d = (await call('GET', '/api/dashboard')).body;
  assert.equal(d.killSwitch.armed, true);
  assert.equal(d.killSwitch.activeAt, null, 'not active while positions are open');
  assert.ok(d.positions.some(p => p.symbol === 'NIFTY 25000 CE'), 'the 3rd trade was not force-exited');
});

test('going flat activates it, then every new order is blocked', async () => {
  const d0 = (await call('GET', '/api/dashboard')).body;
  for (const p of d0.positions) {
    const r = await call('POST', '/api/orders', { symbol: p.symbol, side: p.qty > 0 ? 'SELL' : 'BUY', qty: Math.abs(p.qty) });
    assert.equal(r.status, 201, `exit of ${p.symbol} is allowed`);
  }
  await sync();
  await sync();
  const d = (await call('GET', '/api/dashboard')).body;
  assert.ok(d.killSwitch.activeAt, 'kill switch activated once flat');
  assert.equal(d.orders.length, 0, 'pending orders were cancelled first (broker requirement)');
  const blocked = await call('POST', '/api/orders', { symbol: 'NIFTY 24900 PE', side: 'BUY', qty: 75 });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.extra.rule, 'KILL_SWITCH');
  const notes = (await call('GET', '/api/notifications')).body.items;
  assert.ok(notes.some(n => /kill switch activated/i.test(n.title)));
});

test('turning the kill switch off counts as loosening', async () => {
  const { loosens, DEFAULT_RULES } = await import('../src/modules/rules/service.js');
  const off = structuredClone(DEFAULT_RULES); off.killSwitch.on = false;
  assert.equal(loosens(DEFAULT_RULES, off), true);
});

test('the agent cannot be stopped on a day a limit was hit', async () => {
  const acct = (await call('GET', '/api/brokers')).body.account;
  assert.equal(acct.agentOn, true);
  const r = await call('POST', `/api/brokers/${acct.id}/agent`, { on: false });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'AGENT_LOCKED');
});
