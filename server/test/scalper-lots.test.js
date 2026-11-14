// Power Scalper: lots set by hand are remembered per user, instrument and side (GET / PUT /api/scalper/lots).
process.env.DB_PATH = ':memory:';
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { readFileSync } = await import('node:fs');
const { stmt } = await import('../src/db/index.js');

async function routes() {
  globalThis.__lotsRouteTest = { accountFor: () => null, adapterFor: () => null };
  const file = new URL('../src/modules/scalper/routes.js', import.meta.url);
  let source = readFileSync(file, 'utf8').replace("import { accountFor, adapterFor } from '../broker/registry.js';", 'const {accountFor,adapterFor}=globalThis.__lotsRouteTest;');
  source = `// lots route test ${Math.random()}\n${source.replace(/from '([^']+)'/g, (_, path) => `from '${new URL(path, file).href}'`)}`;
  const { scalperRoutes } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const map = new Map();
  scalperRoutes({ get: (p, fn) => map.set(`GET ${p}`, fn), post: () => {}, put: (p, fn) => map.set(`PUT ${p}`, fn) });
  return map;
}
const newUser = email => Number(stmt('INSERT INTO users (email,password_hash,name,created_at) VALUES (?,?,?,?)').run(email, 'x', 'L', 1).lastInsertRowid);

test('lots are saved per instrument and side, kept per user, and 0 goes back to auto', async () => {
  const r = await routes(), a = newUser('lots-a@test'), b = newUser('lots-b@test');
  const put = (id, body) => r.get('PUT /api/scalper/lots')({ user: { id }, body });
  put(a, { underlying: 'NIFTY', side: 'ce', lots: 3 });
  put(a, { underlying: 'NIFTY', side: 'pe', lots: 2 });
  put(a, { underlying: 'CRUDEOILM', side: 'ce', lots: 1 });
  put(a, { underlying: 'NIFTY', side: 'ce', lots: 4 });   // changed again: the last one counts
  put(b, { underlying: 'NIFTY', side: 'ce', lots: 9 });
  assert.deepEqual(r.get('GET /api/scalper/lots')({ user: { id: a } }).lots, { NIFTY: { ce: 4, pe: 2 }, CRUDEOILM: { ce: 1 } });
  assert.deepEqual(r.get('GET /api/scalper/lots')({ user: { id: b } }).lots, { NIFTY: { ce: 9 } }, 'another user keeps their own');
  put(a, { underlying: 'NIFTY', side: 'pe', lots: 0 });
  assert.deepEqual(r.get('GET /api/scalper/lots')({ user: { id: a } }).lots.NIFTY, { ce: 4 }, '0 = back to auto');
});

test('bad input is refused', async () => {
  const r = await routes(), a = newUser('lots-c@test');
  const put = body => () => r.get('PUT /api/scalper/lots')({ user: { id: a }, body });
  assert.throws(put({ underlying: 'XYZ', side: 'ce', lots: 1 }), /instrument/);
  assert.throws(put({ underlying: 'NIFTY', side: 'fut', lots: 1 }), /side/);
  assert.throws(put({ underlying: 'NIFTY', side: 'ce', lots: 501 }), /lots/);
  assert.throws(put({ underlying: 'NIFTY', side: 'ce', lots: 1.5 }), /lots/);
});

test('the Manual lots switch is saved per user and kept apart from the lots', async () => {
  const r = await routes(), a = newUser('lots-mode-a@test'), b = newUser('lots-mode-b@test');
  const get = id => r.get('GET /api/scalper/lots')({ user: { id } });
  assert.equal(get(a).manual, false, 'auto by default');
  r.get('PUT /api/scalper/lots')({ user: { id: a }, body: { underlying: 'NIFTY', side: 'ce', lots: 3 } });
  assert.deepEqual(r.get('PUT /api/scalper/lots/mode')({ user: { id: a }, body: { manual: true } }), { manual: true });
  assert.deepEqual(get(a), { lots: { NIFTY: { ce: 3 } }, manual: true }, 'the switch is not listed as an instrument');
  assert.equal(get(b).manual, false, 'another user keeps their own');
  r.get('PUT /api/scalper/lots/mode')({ user: { id: a }, body: { manual: false } });
  assert.deepEqual(get(a), { lots: { NIFTY: { ce: 3 } }, manual: false }, 'switching off keeps the saved lots for next time');
  assert.throws(() => r.get('PUT /api/scalper/lots/mode')({ user: { id: a }, body: { manual: 'yes' } }), /manual/);
});
