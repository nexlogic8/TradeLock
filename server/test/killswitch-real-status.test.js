// 13 Nov 2026: the broker's own kill switch reading decides. A lock TradeLock only recorded while Dhan's switch is
// OFF is switched on for real; an ON switch is not switched again. (Switching off: releaseKillSwitch.)
process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { createUser } = await import('../src/modules/auth/service.js');
const { dayState, patchDay } = await import('../src/modules/risk/service.js');
const { ist } = await import('../src/lib/time.js');
const { getKillStatus } = await import('../src/modules/broker/book.js');
const { tryKillSwitch } = await import('../src/modules/emergency/service.js');

const fake = on => {
  const calls = [];
  return { calls, label: 'Dhan', async getKillSwitch() { return on; }, async snapshot() { return { positions: [], orders: [], funds: { available: 1e5 } }; },
    async activateKillSwitch() { calls.push('activate'); on = true; return { message: 'ON' }; }, async cancelOrder() { return {}; } };
};

test('recorded as on, but Dhan reads OFF: switched on for real', async () => {
  const uid = createUser({ email: 'ks1@test.in', password: null, name: 'KS' });
  patchDay(uid, ist().day, { ks_armed: 'manual', ks_active_at: Date.now() - 60e3 });
  const a = fake(false);
  const r = await tryKillSwitch(uid, null, 'manual', a);
  assert.equal(r.status, 'active');
  assert.deepEqual(a.calls, ['activate']);
  assert.equal(getKillStatus(uid).active, true);
});

test('Dhan already ON: not switched again, recorded', async () => {
  const uid = createUser({ email: 'ks2@test.in', password: null, name: 'KS' });
  const a = fake(true);
  const r = await tryKillSwitch(uid, null, 'manual', a);
  assert.equal(r.status, 'active');
  assert.deepEqual(a.calls, []);
  assert.ok(dayState(uid).ks_active_at > 0);
});

test('Dhan OFF and nothing recorded: switched on', async () => {
  const uid = createUser({ email: 'ks3@test.in', password: null, name: 'KS' });
  const a = fake(false);
  assert.equal((await tryKillSwitch(uid, null, 'rule:maxLoss', a)).status, 'active');
  assert.deepEqual(a.calls, ['activate']);
});
