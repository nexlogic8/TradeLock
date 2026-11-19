// Risk rules: one master set (the Risk rules page) for Manual and Algo trades alike, whatever the Algo Trading switch.
// Until 16 Nov 2026 there were two sets (Manual / Algo) picked by the switch; the old Algo copy (algo_config) is ignored.
process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { stmt } = await import('../src/db/index.js');
const { createUser } = await import('../src/modules/auth/service.js');
const { getRules, saveRules } = await import('../src/modules/rules/service.js');
const { upsertAccount } = await import('../src/modules/broker/registry.js');

const algo = (uid, on) => stmt('UPDATE broker_accounts SET algo_on = ?, agent_on = 1 WHERE user_id = ?').run(on ? 1 : 0, uid);

test('one master set is in force with Algo Trading on or off', t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-11-02T18:00:00+05:30'));
  const uid = createUser({ email: 'sets@rules.test', password: null, name: 'Sets' });
  upsertAccount(uid, { broker: 'dhan', clientId: 'C900', accessToken: 'test-token-not-real-0123456789' });
  for (const on of [false, true]) {
    algo(uid, on);
    const r = getRules(uid);
    assert.equal(r.mode, 'manual');
    assert.equal(r.active, r.manual, 'the master set is in force');
    assert.equal(r.algo, r.manual, 'older clients reading `algo` get the master set too');
  }
});

test('the losing streak switched off on Risk rules stays off with Algo Trading on, whatever the old Algo copy says', () => {
  const uid = createUser({ email: 'streak@rules.test', password: null, name: 'Streak' });
  upsertAccount(uid, { broker: 'dhan', clientId: 'C905', accessToken: 'test-token-not-real-0123456789' });
  const base = getRules(uid).manual;
  saveRules(uid, { ...base, lossStreak: { on: false, value: 2 } }, '127.0.0.1');
  // The old Algo copy still has the default streak rule on (16 Nov: it paused a user whose master rule was off).
  stmt('UPDATE risk_rules SET algo_config = ? WHERE user_id = ?').run(JSON.stringify({ ...base, lossStreak: { on: true, value: 2 } }), uid);
  algo(uid, true);
  saveRules(uid, getRules(uid).manual, '127.0.0.1');   // any save drops the cached sets, as a fresh read would
  assert.equal(getRules(uid).active.lossStreak.on, false);
});

test('saves go to the master set; the old Algo set is refused with a pointer to Risk rules', t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-11-02T18:00:00+05:30'));
  const uid = createUser({ email: 'sets2@rules.test', password: null, name: 'Sets' });
  upsertAccount(uid, { broker: 'dhan', clientId: 'C901', accessToken: 'test-token-not-real-0123456789' });
  algo(uid, true);
  const base = getRules(uid).active;
  saveRules(uid, { ...base, maxTrades: { ...base.maxTrades, on: true, value: 5 } }, '127.0.0.1');
  assert.equal(getRules(uid).active.maxTrades.value, 5, 'no set given: the master set');
  assert.throws(() => saveRules(uid, base, '127.0.0.1', null, 'algo'), e => e.code === 'RULES_MASTER');
  assert.throws(() => saveRules(uid, base, '127.0.0.1', null, 'other'), /set/);
  assert.equal(getRules(uid).active.maxTrades.value, 5, 'a refused save changes nothing');
  const log = stmt("SELECT detail FROM audit_log WHERE user_id = ? AND action = 'rules.updated' ORDER BY id").all(uid).map(x => JSON.parse(x.detail).set);
  assert.deepEqual(log, ['manual'], 'the audit log names the set');
});

test('Overview chart: a second stop-loss line only when the other set\'s stop-loss is on and differs', async () => {
  const { otherSl } = await import('../../web/js/pages/overview-sl.js');
  const d = (manual, algo, mode = 'algo') => ({ limits: { maxLoss: (mode === 'algo' ? algo : manual).amount }, stopLosses: { mode, manual, algo } });
  assert.deepEqual(otherSl(d({ on: true, amount: 41298 }, { on: true, amount: 57817 })), { key: 'manual', amount: 41298 });
  assert.equal(otherSl(d({ on: true, amount: 57817 }, { on: true, amount: 57817 })), null, 'same amount: one line');
  assert.equal(otherSl(d({ on: false, amount: null }, { on: true, amount: 57817 })), null, 'other set off: one line');
  assert.deepEqual(otherSl(d({ on: true, amount: 41298 }, { on: true, amount: 57817 }, 'manual')), { key: 'algo', amount: 57817 });
});

test('the dashboard reports one stop-loss and one profit target (the master set), with Algo Trading on', async () => {
  const { getDashboard } = await import('../src/modules/risk/service.js');
  const uid = createUser({ email: 'pt-sets@rules.test', password: null, name: 'PT' });
  upsertAccount(uid, { broker: 'dhan', clientId: 'C903', accessToken: 'test-token-not-real-0123456789' });
  const r = getRules(uid);
  saveRules(uid, { ...r.manual, maxLoss: { on: true, mode: 'amount', value: 3000, action: 'exit' }, profitLock: { on: true, mode: 'amount', value: 23193, action: 'pause' } });
  algo(uid, true);
  const dash = getDashboard(uid, null);
  assert.deepEqual([dash.stopLosses.manual.amount, dash.stopLosses.algo.amount], [3000, 3000]);
  assert.deepEqual([dash.profitTargets.manual.amount, dash.profitTargets.algo.amount], [23193, 23193]);
});

test('Power Scalper sizes manual orders from the master set\'s Option SL room, also with Algo Trading on', async () => {
  const { scalperSignalRisk } = await import('../src/modules/scalper/signals.js');
  const uid = createUser({ email: 'optsl@rules.test', password: null, name: 'O' });
  upsertAccount(uid, { broker: 'dhan', clientId: 'C31', accessToken: 'test-token-not-real-0123456789' });
  algo(uid, true);
  const r = getRules(uid);
  saveRules(uid, { ...r.manual, optionSl: { on: true, value: 25 } });
  assert.equal(scalperSignalRisk(uid).optionSlPct, 25);
});

test('the kill switch follows the master set with Algo Trading on', () => {
  const uid = createUser({ email: 'ks-sets@rules.test', password: null, name: 'KS' });
  upsertAccount(uid, { broker: 'dhan', clientId: 'C904', accessToken: 'test-token-not-real-0123456789' });
  algo(uid, true);
  saveRules(uid, { ...getRules(uid).manual, killSwitch: { on: true } });
  assert.equal(getRules(uid).active.killSwitch.on, true);
  saveRules(uid, { ...getRules(uid).manual, killSwitch: { on: false } });
  assert.equal(getRules(uid).active.killSwitch.on, false, 'switched off on Risk rules: off for Algo Trading too');
});
