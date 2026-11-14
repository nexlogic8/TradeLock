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
  saveRules(uid, { ...base, lossStreak: { ...base.lossStreak, on: true, value: 7 } }, '127.0.0.1', null, 'algo');   // not a whole-account rule
  saveRules(uid, { ...base, maxTrades: { ...base.maxTrades, on: true, value: 5 } }, '127.0.0.1', null, 'manual');
  let r = getRules(uid);
  assert.equal(r.mode, 'algo');
  assert.deepEqual([r.active.lossStreak.value, r.active.maxTrades.value], [7, base.maxTrades.value], 'Algo rules in force');
  assert.deepEqual([r.manual.lossStreak.value, r.manual.maxTrades.value], [base.lossStreak.value, 5], 'Manual rules kept apart');
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

test('the daily stop-loss covers the whole account: the Algo set takes the Risk rules page\'s, whatever its own copy says', async () => {
  const { getDashboard } = await import('../src/modules/risk/service.js');
  const uid = createUser({ email: 'sl-sets@rules.test', password: null, name: 'Sets' });
  upsertAccount(uid, { broker: 'dhan', clientId: 'C903', accessToken: 'test-token-not-real-0123456789' });
  const r = getRules(uid);
  saveRules(uid, { ...r.manual, maxLoss: { on: true, mode: 'amount', value: 3000, action: 'exit' } }, undefined, null, 'manual');
  saveRules(uid, { ...r.algo, maxLoss: { on: true, mode: 'amount', value: 9000, action: 'exit' } }, undefined, null, 'algo');
  const sl = getDashboard(uid, null).stopLosses;
  assert.equal(sl.mode, 'manual', 'no Algo Trading on: the Manual set is in force');
  assert.deepEqual([sl.manual.on, sl.manual.amount, sl.algo.on, sl.algo.amount], [true, 3000, true, 3000]);
  algo(uid, true);
  assert.equal(ruleMode(uid), 'algo');
  const r2 = getRules(uid);
  assert.equal(r2.active.maxLoss.value, 3000, 'Algo Trading on: the daily stop-loss from the Risk rules page is in force');
  assert.equal(r2.active.maxTrades, r2.algo.maxTrades, 'the other rules stay the Algo set own');
});

test('Overview chart: a second stop-loss line only when the other set\'s stop-loss is on and differs', async () => {
  const { otherSl } = await import('../../web/js/pages/overview-sl.js');
  const d = (manual, algo, mode = 'algo') => ({ limits: { maxLoss: (mode === 'algo' ? algo : manual).amount }, stopLosses: { mode, manual, algo } });
  assert.deepEqual(otherSl(d({ on: true, amount: 41298 }, { on: true, amount: 57817 })), { key: 'manual', amount: 41298 });
  assert.equal(otherSl(d({ on: true, amount: 57817 }, { on: true, amount: 57817 })), null, 'same amount: one line');
  assert.equal(otherSl(d({ on: false, amount: null }, { on: true, amount: 57817 })), null, 'other set off: one line');
  assert.deepEqual(otherSl(d({ on: true, amount: 41298 }, { on: true, amount: 57817 }, 'manual')), { key: 'algo', amount: 57817 });
});

test('Overview chart: both profit targets, each set its own line; the other set\'s target shows even when the active one is off', async () => {
  const { getDashboard } = await import('../src/modules/risk/service.js');
  const { otherTarget } = await import('../../web/js/pages/overview-sl.js');
  const uid = createUser({ email: 'pt-sets@rules.test', password: null, name: 'PT' });
  const r = getRules(uid);
  saveRules(uid, { ...r.manual, profitLock: { on: true, mode: 'amount', value: 23193, action: 'pause' } }, undefined, null, 'manual');
  saveRules(uid, { ...r.algo, profitLock: { on: false, mode: 'percent', value: 10, action: 'pause' } }, undefined, null, 'algo');
  const pt = getDashboard(uid, null).profitTargets;
  assert.deepEqual([pt.manual.on, pt.manual.amount, pt.algo.on, pt.algo.amount], [true, 23193, true, 23193], 'one profit target for the whole account');
  const d = (manual, algo, mode = 'algo') => ({ limits: { profitLock: (mode === 'algo' ? algo : manual).amount }, profitTargets: { mode, manual, algo } });
  assert.deepEqual(otherTarget(d({ on: true, amount: 23193 }, { on: false, amount: null })), { key: 'manual', amount: 23193 }, 'Algo in force, its target off: Manual line still drawn');
  assert.deepEqual(otherTarget(d({ on: true, amount: 23193 }, { on: true, amount: 15000 })), { key: 'manual', amount: 23193 });
  assert.equal(otherTarget(d({ on: true, amount: 15000 }, { on: true, amount: 15000 })), null, 'same amount: one line');
  assert.equal(otherTarget(d({ on: false, amount: null }, { on: true, amount: 15000 })), null);
});

test('Power Scalper sizes manual orders from the Manual set\'s Option SL room, also while the Algo set is in force', async () => {
  const { scalperSignalRisk } = await import('../src/modules/scalper/signals.js');
  const uid = createUser({ email: 'optsl@rules.test', password: null, name: 'O' });
  upsertAccount(uid, { broker: 'dhan', clientId: 'C31', accessToken: 'test-token-not-real-0123456789' });
  stmt('UPDATE broker_accounts SET algo_on = 1, agent_on = 1 WHERE user_id = ?').run(uid);
  const r = getRules(uid);
  saveRules(uid, { ...r.manual, optionSl: { on: true, value: 25 } }, undefined, null, 'manual');
  saveRules(uid, { ...r.algo, optionSl: { on: false, value: 20 } }, undefined, null, 'algo');
  assert.equal(ruleMode(uid), 'algo');
  assert.equal(scalperSignalRisk(uid).optionSlPct, 25, 'the Manual set\'s 25%, not the Algo set (off)');
});

test('the kill switch covers the whole account: with Algo Trading on, the Risk rules page setting is in force', () => {
  const uid = createUser({ email: 'ks-sets@rules.test', password: null, name: 'KS' });
  upsertAccount(uid, { broker: 'dhan', clientId: 'C904', accessToken: 'test-token-not-real-0123456789' });
  const r = getRules(uid);
  saveRules(uid, { ...r.manual, killSwitch: { on: true } }, undefined, null, 'manual');
  saveRules(uid, { ...r.algo, killSwitch: { on: false } }, undefined, null, 'algo');   // an old Algo copy: ignored
  algo(uid, true);
  assert.equal(ruleMode(uid), 'algo');
  assert.equal(getRules(uid).active.killSwitch.on, true);
  saveRules(uid, { ...getRules(uid).manual, killSwitch: { on: false } }, undefined, null, 'manual');
  assert.equal(getRules(uid).active.killSwitch.on, false, 'switched off on Risk rules: off for Algo Trading too');
});
