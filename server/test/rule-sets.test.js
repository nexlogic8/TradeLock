// Risk rules in two sets: Manual trading and Algo Trading. The one in force follows the Algo Trading switch.
process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { stmt } = await import('../src/db/index.js');
const { createUser } = await import('../src/modules/auth/service.js');
const { getRules, saveRules, ruleMode } = await import('../src/modules/rules/service.js');
const { upsertAccount } = await import('../src/modules/broker/registry.js');

const algo = (uid, on) => stmt('UPDATE broker_accounts SET algo_on = ?, agent_on = 1 WHERE user_id = ?').run(on ? 1 : 0, uid);

test('both sets start as the same rules; the Algo switch picks the set in force', t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-11-02T18:00:00+05:30'));
  const uid = createUser({ email: 'sets@rules.test', password: null, name: 'Sets' });
  upsertAccount(uid, { broker: 'dhan', clientId: 'C900', accessToken: 'test-token-not-real-0123456789' });
  const r = getRules(uid);
  assert.deepEqual(r.manual, r.algo, 'a copy of the same rules');
  algo(uid, false);
  assert.equal(ruleMode(uid), 'manual');
  algo(uid, true);
  assert.equal(ruleMode(uid), 'algo');
  stmt('UPDATE broker_accounts SET agent_on = 0 WHERE user_id = ?').run(uid);
  assert.equal(ruleMode(uid), 'manual', 'Algo Trading needs protection on');
});

test('each set saves on its own; `active` follows the switch without a save', t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-11-02T18:00:00+05:30'));
  const uid = createUser({ email: 'sets2@rules.test', password: null, name: 'Sets' });
  upsertAccount(uid, { broker: 'dhan', clientId: 'C901', accessToken: 'test-token-not-real-0123456789' });
  algo(uid, true);
  const base = getRules(uid).active;
  saveRules(uid, { ...base, maxLoss: { ...base.maxLoss, mode: 'percent', value: 8 } }, '127.0.0.1', null, 'algo');
  saveRules(uid, { ...base, maxTrades: { ...base.maxTrades, on: true, value: 5 } }, '127.0.0.1', null, 'manual');
  let r = getRules(uid);
  assert.equal(r.mode, 'algo');
  assert.deepEqual([r.active.maxLoss.value, r.active.maxTrades.value], [8, base.maxTrades.value], 'Algo rules in force');
  assert.deepEqual([r.manual.maxLoss.value, r.manual.maxTrades.value], [base.maxLoss.value, 5], 'Manual rules kept apart');
  algo(uid, false);
  r = getRules(uid);
  assert.equal(r.mode, 'manual');
  assert.equal(r.active.maxTrades.value, 5, 'switching Algo off puts the Manual rules in force');
  // No set given: the set in force now.
  saveRules(uid, { ...r.active, maxTrades: { ...r.active.maxTrades, value: 4 } }, '127.0.0.1');
  assert.equal(getRules(uid).manual.maxTrades.value, 4);
  assert.equal(getRules(uid).algo.maxTrades.value, base.maxTrades.value);
  assert.throws(() => saveRules(uid, r.active, '127.0.0.1', null, 'other'), /set/);
  const log = stmt("SELECT detail FROM audit_log WHERE user_id = ? AND action = 'rules.updated' ORDER BY id").all(uid).map(x => JSON.parse(x.detail).set);
  assert.deepEqual(log, ['algo', 'manual', 'manual'], 'the audit log names the set');
});

test('loosening the set not in force mid-session is not a loosening', t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-11-02T10:00:00+05:30'));
  const uid = createUser({ email: 'sets3@rules.test', password: null, name: 'Sets' });
  upsertAccount(uid, { broker: 'dhan', clientId: 'C902', accessToken: 'test-token-not-real-0123456789' });
  algo(uid, true);
  const base = getRules(uid).manual;
  saveRules(uid, { ...base, maxTrades: { ...base.maxTrades, on: true, value: 50 } }, '127.0.0.1', null, 'manual');
  const d = JSON.parse(stmt("SELECT detail FROM audit_log WHERE user_id = ? AND action = 'rules.updated' ORDER BY id DESC").get(uid).detail);
  assert.equal(d.loosenedInSession, undefined);
});
