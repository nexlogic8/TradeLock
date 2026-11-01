process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { stmt } = await import('../src/db/index.js');
const { createUser } = await import('../src/modules/auth/service.js');
const { getRules, saveRules, ensureRules } = await import('../src/modules/rules/service.js');

test('rules can be loosened during market hours and apply at once', t => {
  const now = Date.parse('2026-10-15T09:44:00+05:30');
  t.mock.method(Date, 'now', () => now);
  const uid = createUser({ email: 'in-session@rules.test', password: null, name: 'Rules test' });
  const base = getRules(uid).active;
  saveRules(uid, { ...base, maxTrades: { ...base.maxTrades, on: true, value: 3 } }, '127.0.0.1');
  const res = saveRules(uid, { ...base, maxTrades: { ...base.maxTrades, on: true, value: 6 } }, '127.0.0.1');
  assert.equal(res.deferred, false);
  assert.equal(res.pending, null);
  assert.equal(getRules(uid).active.maxTrades.value, 6);
  const log = stmt("SELECT detail FROM audit_log WHERE user_id = ? AND action = 'rules.updated' ORDER BY id DESC").get(uid);
  assert.match(log.detail, /loosenedInSession/, 'the mid-session loosening is audited');
});

test('a change scheduled under the old next-session rule applies now', t => {
  const now = Date.parse('2026-10-15T09:50:00+05:30');
  t.mock.method(Date, 'now', () => now);
  const uid = createUser({ email: 'scheduled@rules.test', password: null, name: 'Rules test' });
  ensureRules(uid);
  const base = JSON.parse(stmt('SELECT config FROM risk_rules WHERE user_id = ?').get(uid).config);
  const next = { ...base, maxTrades: { ...base.maxTrades, on: true, value: 9 } };
  stmt('UPDATE risk_rules SET pending = ?, pending_from = ? WHERE user_id = ?').run(JSON.stringify(next), '2026-10-16', uid);
  const rules = getRules(uid);
  assert.equal(rules.active.maxTrades.value, 9);
  assert.equal(rules.pending, null);
});
