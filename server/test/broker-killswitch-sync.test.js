process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { stmt } = await import('../src/db/index.js');
const { createUser } = await import('../src/modules/auth/service.js');
const { adapterFor, accountFor } = await import('../src/modules/broker/registry.js');
const { syncAccount } = await import('../src/modules/risk/monitor.js');
const { dayState, patchDay } = await import('../src/modules/risk/service.js');

function account(name, now) {
  const uid = createUser({ email: `${name}@ks-sync.test`, password: null, name: 'KS sync test' });
  stmt("INSERT INTO broker_accounts (user_id, broker, client_id, status, created_at) VALUES (?, 'mock', ?, 'connected', ?)").run(uid, `ks-${uid}`, now);
  const acct = accountFor(uid), adapter = adapterFor(acct);
  adapter.snapshot = async () => ({ positions: [], orders: [], trades: [], funds: { available: 100000, used: 0 } });
  return { uid, acct, adapter };
}

test('an overnight reading of yesterday\'s Dhan lock is not recorded as today\'s lock', async t => {
  const now = Date.parse('2026-10-15T00:00:31+05:30');
  t.mock.method(Date, 'now', () => now);
  const { uid, acct, adapter } = account('overnight', now);
  adapter.getKillSwitch = async () => true;
  await syncAccount(acct, { force: true });
  const s = dayState(uid, '2026-10-15');
  assert.equal(s.ks_active_at, null);
  assert.equal(s.ks_armed, null);
});

test('every lock follows the broker: switched off there (or never really on), off here, a rule lock too', async t => {
  let now = Date.parse('2026-10-15T09:40:00+05:30');
  t.mock.method(Date, 'now', () => now);
  const copied = account('copied', now);
  patchDay(copied.uid, '2026-10-15', { ks_armed: 'broker', ks_active_at: now - 3600e3 });
  copied.adapter.getKillSwitch = async () => false;
  await syncAccount(copied.acct, { force: true });
  assert.equal(dayState(copied.uid, '2026-10-15').ks_active_at, null, 'Dhan says off, so TradeLock shows off');

  const own = account('own', now);
  patchDay(own.uid, '2026-10-15', { ks_armed: 'rule:maxLoss', ks_active_at: now - 600e3 });
  own.adapter.getKillSwitch = async () => false;
  await syncAccount(own.acct, { force: true });
  // Since 13 Nov 2026 every kill switch can be switched off the same day, so a rule lock follows the broker as well.
  assert.equal(dayState(own.uid, '2026-10-15').ks_active_at, null, 'Dhan says off, so the rule lock is off too');

  // Switched on in the Dhan app during the session: recorded.
  now += 120e3;
  copied.adapter.getKillSwitch = async () => true;
  await syncAccount(copied.acct, { force: true });
  assert.equal(dayState(copied.uid, '2026-10-15').ks_armed, 'broker');
});
