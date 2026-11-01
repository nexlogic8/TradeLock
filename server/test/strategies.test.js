// Saved strategies: create, list, update, delete; private to each user; capped per user.
process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
const { test, before, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { createServer } = await import('node:http');
const { createHandler } = await import('../src/lib/app.js');
const { buildRouter } = await import('../src/modules/index.js');

let server, base;
const jar = {};
async function call(who, method, path, body) {
  const res = await fetch(base + path, { method, headers: { ...(body && { 'Content-Type': 'application/json' }), ...(jar[who] && { Cookie: jar[who] }) }, body: body && JSON.stringify(body) });
  const set = res.headers.getSetCookie().map(c => c.split(';')[0]).filter(c => !c.endsWith('='));
  if (set.length) jar[who] = set.join('; ');
  return { status: res.status, body: await res.json().catch(() => null) };
}
before(async () => {
  server = createServer(createHandler(buildRouter()));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await call('a', 'POST', '/api/auth/signup', { email: 'strat-a@example.com', password: 'longpassword' });
  await call('b', 'POST', '/api/auth/signup', { email: 'strat-b@example.com', password: 'longpassword' });
});
after(() => server.close());

test('create, list, edit and delete a strategy', async () => {
  const { body: { template } } = await call('a', 'GET', '/api/strategies');
  const made = await call('a', 'POST', '/api/strategies', { strategy: { ...template, name: 'VWAP pullback' } });
  assert.equal(made.status, 201);
  const id = made.body.strategy.id;
  const second = await call('a', 'POST', '/api/strategies', { strategy: { ...template, name: 'Gap and go', timeframe: '1m' } });
  assert.equal(second.status, 201);
  let list = (await call('a', 'GET', '/api/strategies')).body.items;
  assert.deepEqual(list.map(s => s.name), ['Gap and go', 'VWAP pullback'], 'newest first');
  const edited = await call('a', 'PUT', `/api/strategies/${id}`, { strategy: { ...template, name: 'VWAP pullback v2', exits: { ...template.exits, stopValue: 0.5 } } });
  assert.equal(edited.body.strategy.name, 'VWAP pullback v2');
  assert.equal(edited.body.strategy.exits.stopValue, 0.5);
  const bad = await call('a', 'PUT', `/api/strategies/${id}`, { strategy: { ...template, entries: { ...template.entries, emaFast: 30, emaSlow: 10 } } });
  assert.equal(bad.status, 400, 'validation still applies');
  assert.equal((await call('a', 'DELETE', `/api/strategies/${id}`)).status, 200);
  list = (await call('a', 'GET', '/api/strategies')).body.items;
  assert.deepEqual(list.map(s => s.name), ['Gap and go']);
});

test("another user's strategies are invisible and untouchable", async () => {
  const { body: { items: [mine] } } = await call('a', 'GET', '/api/strategies');
  assert.deepEqual((await call('b', 'GET', '/api/strategies')).body.items, []);
  assert.equal((await call('b', 'PUT', `/api/strategies/${mine.id}`, { strategy: { ...mine, name: 'Hijack' } })).status, 400);
  assert.equal((await call('b', 'DELETE', `/api/strategies/${mine.id}`)).status, 400);
  assert.equal((await call('a', 'GET', '/api/strategies')).body.items[0].name, 'Gap and go');
});

test('at most 20 strategies per user', async () => {
  const { body: { template } } = await call('b', 'GET', '/api/strategies');
  for (let i = 0; i < 20; i++) assert.equal((await call('b', 'POST', '/api/strategies', { strategy: { ...template, name: `Plan ${i + 1}` } })).status, 201);
  const over = await call('b', 'POST', '/api/strategies', { strategy: { ...template, name: 'One too many' } });
  assert.equal(over.status, 400);
  assert.equal(over.body.code, 'STRATEGY_LIMIT');
});
