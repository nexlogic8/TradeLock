// Paper trading without a broker: a Paper account for a normal user (prices from TradeLock's market data), Algo
// Trading ready on paper, the Gap retest paper strategy available to users, Real refused until a broker is connected.
process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
process.env.ADMIN_EMAILS = 'boss@example.com';
const { test, before, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { createServer } = await import('node:http');
const { createHandler } = await import('../src/lib/app.js');
const { buildRouter } = await import('../src/modules/index.js');
const { stmt } = await import('../src/db/index.js');
const { adapterFor } = await import('../src/modules/broker/registry.js');
const { algoReadiness } = await import('../src/modules/scalper/algo-live.js');

let server, base, cookie, uid;
before(async () => {
  server = createServer(createHandler(buildRouter()));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/auth/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'user@example.com', password: 'longpassword' }) });
  cookie = res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  uid = stmt('SELECT id FROM users WHERE email = ?').get('user@example.com').id;
});
after(() => server.close());
const call = async (method, path, body) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

test('a user with no broker sets up paper trading: a Paper account, ₹10 lakh, ready on paper', async () => {
  const r = await call('POST', '/paper/account');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.account.label, 'Paper');
  const acct = stmt('SELECT * FROM broker_accounts WHERE user_id = ?').get(uid);
  assert.deepEqual([acct.broker, acct.paper_mode, acct.gap_on, acct.agent_on, acct.token_enc], ['paper', 1, 1, 1, null]);
  assert.equal(adapterFor(acct).label, 'Paper', 'the paper broker, without a Dhan token');
  const ready = algoReadiness(uid, acct);
  assert.ok(ready.find(x => x.id === 'paper').ok);
  assert.ok(!ready.some(x => x.id === 'dhan' || x.id === 'connected' || x.id === 'orders'), 'no Dhan checks on paper');
  assert.equal((await call('GET', '/paper/wallet')).body.balance, 1_000_000);
  assert.equal((await call('GET', '/brokers')).body.account.broker, 'paper', 'Broker accounts shows it (the Paper tab)');
  assert.equal((await call('POST', '/paper/account')).status, 200, 'twice is fine');
});

test('normal users can switch on Gap retest (paper) and set it; Real needs a broker', async () => {
  const acct = stmt('SELECT * FROM broker_accounts WHERE user_id = ?').get(uid);
  assert.equal((await call('POST', `/brokers/${acct.id}/strategies`, { gapRetest: true })).status, 200);
  assert.equal((await call('POST', `/brokers/${acct.id}/strategies`, { retestCfg: { windowMin: 10, slPct: 4 } })).status, 200);
  const row = stmt('SELECT retest_paper_on, retest_cfg FROM broker_accounts WHERE id = ?').get(acct.id);
  assert.deepEqual([row.retest_paper_on, JSON.parse(row.retest_cfg)], [1, { windowMin: 10, slPct: 4 }]);
  assert.equal((await call('POST', `/brokers/${acct.id}/strategies`, { orb: true })).status, 400, 'admin-only strategies stay admin-only');
  const real = await call('POST', `/brokers/${acct.id}/paper`, { on: false });
  assert.equal(real.status, 400);
  assert.match(real.body.message, /Connect your Dhan account/);
  const live = await call('GET', '/algo/live');
  assert.equal(live.status, 200);
  assert.ok(Array.isArray(live.body.paper), 'paper trades for users too');
  assert.equal(live.body.account.paperMode, true);
});

test('sign-up opens a Paper account; a connected broker takes priority over it', async () => {
  const res = await fetch(`${base}/api/auth/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'fresh@example.com', password: 'longpassword' }) });
  assert.equal(res.status, 201);
  const id = stmt('SELECT id FROM users WHERE email = ?').get('fresh@example.com').id;
  const { accountFor, upsertAccount } = await import('../src/modules/broker/registry.js');
  const paper = accountFor(id);
  assert.deepEqual([paper.broker, paper.paper_mode, paper.gap_on, paper.algo_on], ['paper', 1, 1, 0], 'paper trading from the first login (Algo Trading off until started)');
  upsertAccount(id, { broker: 'dhan', clientId: 'C77', accessToken: 'test-token-not-real-0123456789' });
  assert.equal(accountFor(id).broker, 'dhan', 'the real broker comes first');
});

test('Overview data for a Paper account: the broker has capabilities (kill switch = the paper day lock)', async () => {
  const { getDashboard } = await import('../src/modules/risk/service.js');
  const d = getDashboard(uid);
  assert.equal(d.broker.label, 'Paper');
  assert.deepEqual(d.broker.capabilities, { positions: 'available', squareOff: 'available', accountLock: 'killswitch' });
  assert.equal(d.killSwitch.supported, true);
});

test('a pending paper buy stop (chart "+") can be moved up or down by dragging it, and cancelled', async () => {
  const order = { symbol: 'SENSEX 2026-11-19 82300 CE', securityId: '889900', exchangeSegment: 'BSE_FNO', side: 'BUY', qty: 20, productType: 'INTRADAY' };
  const placed = await call('POST', '/orders', { ...order, type: 'STOP_LOSS', triggerPrice: 246.45, ltp: 183.3 });
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  const pending = () => call('GET', '/dashboard').then(r => r.body.orders.find(o => o.securityId === '889900'));
  const o = await pending();
  assert.deepEqual([o.type, o.triggerPrice], ['STOP_LOSS', 246.45], JSON.stringify(o));
  const up = await call('PUT', `/orders/${encodeURIComponent(o.id)}`, { price: 260 });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal((await pending()).triggerPrice, 260, 'moved up');
  const down = await call('PUT', `/orders/${encodeURIComponent(o.id)}`, { price: 230.5 });
  assert.equal(down.status, 200, JSON.stringify(down.body));
  assert.equal((await pending()).triggerPrice, 230.5, 'moved down');
  assert.equal((await call('DELETE', `/orders/${encodeURIComponent(o.id)}`)).status, 200);
});
