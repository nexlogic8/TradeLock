// Token keeper: renews Dhan tokens before they expire; expired ones ask the user to reconnect.
process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { stmt } = await import('../src/db/index.js');
const { encrypt, decrypt } = await import('../src/lib/crypto.js');
const { createUser } = await import('../src/modules/auth/service.js');
const { renewDueTokens, msUntilNextRun } = await import('../src/modules/broker/tokenkeeper.js');
const { renewDhanToken, tokenExpiry } = await import('../src/modules/broker/adapters/dhan.js');
const { adapterFor } = await import('../src/modules/broker/registry.js');

const jwt = expMs => `h.${Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000) })).toString('base64url')}.sig`;
const H = 3600e3, now = Date.parse('2026-10-12T00:30:00Z');   // 06:00 IST
function account(name, expMs) {
  const id = createUser({ email: `${name}@x.test`, password: null, name });
  stmt(`INSERT INTO broker_accounts (user_id, broker, client_id, token_enc, status, token_expires_at, created_at) VALUES (?, 'dhan', ?, ?, 'connected', ?, ?)`)
    .run(id, `C-${name}`, encrypt(jwt(expMs)), expMs, now);
  return id;
}
const row = id => stmt('SELECT * FROM broker_accounts WHERE user_id = ?').get(id);

test('runs at 06:00 and 18:00 IST', () => {
  assert.equal(msUntilNextRun(Date.parse('2026-10-12T00:00:00Z')), 30 * 60e3, '05:30 IST → 06:00');
  assert.equal(msUntilNextRun(Date.parse('2026-10-12T05:00:00Z')), 7.5 * H, '10:30 IST → 18:00');
  assert.equal(msUntilNextRun(Date.parse('2026-10-12T13:00:00Z')), 11.5 * H, '18:30 IST → 06:00 next day');
});

test('renews tokens expiring before the next run, leaves the rest, flags expired ones', async () => {
  const soon = account('soon', now + 5 * H);
  const later = account('later', now + 20 * H);
  const dead = account('dead', now - H);
  const calls = [];
  const renew = async ({ clientId, accessToken }) => { calls.push(clientId); return { accessToken: jwt(now + 29 * H), expiresAt: now + 29 * H }; };
  const r = await renewDueTokens({ now, renew, log: () => {} });
  assert.deepEqual(r, { checked: 3, renewed: 1, expired: 1, failed: 0, skipped: 1 });
  assert.deepEqual(calls, ['C-soon'], 'only the token about to expire is renewed');
  assert.equal(tokenExpiry(decrypt(row(soon).token_enc)), now + 29 * H, 'new token stored (encrypted)');
  assert.equal(row(soon).token_expires_at, now + 29 * H);
  assert.equal(row(later).token_expires_at, now + 20 * H, 'not due: untouched');
  assert.equal(row(dead).status, 'expired');
  assert.ok(stmt(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND title LIKE 'Reconnect Dhan%'`).get(dead).n === 1, 'user asked to reconnect');
});

test('the app switches to a renewed token without a restart', () => {
  const id = account('swap', now + 30 * H);
  const a1 = adapterFor(row(id));
  assert.equal(adapterFor(row(id)), a1, 'same token: same adapter');
  stmt('UPDATE broker_accounts SET token_enc = ? WHERE user_id = ?').run(encrypt(jwt(now + 50 * H)), id);
  assert.notEqual(adapterFor(row(id)), a1, 'new token: new adapter');
});

test('Dhan RenewToken: request headers, new token parsed, expired token detected', async () => {
  let seen;
  const fresh = jwt(now + 24 * H);
  const ok = await renewDhanToken({ clientId: 'C1', accessToken: 'old'.repeat(10), transport: async (m, url, o) => { seen = { m, url, h: o.headers }; return { status: 200, text: JSON.stringify({ token: fresh, expiryTime: '2026-10-13T06:00:00' }) }; } });
  assert.equal(seen.m, 'GET');
  assert.match(seen.url, /\/v2\/RenewToken$/);
  assert.equal(seen.h.dhanClientId, 'C1');
  assert.equal(ok.accessToken, fresh);
  assert.equal(ok.expiresAt, now + 24 * H);
  await assert.rejects(renewDhanToken({ clientId: 'C1', accessToken: 'x'.repeat(30), transport: async () => ({ status: 400, text: '{"errorMessage":"Invalid Token"}' }) }), e => e.code === 'TOKEN_EXPIRED');
});

test('Dhan RenewToken real response shape: { createTime, expiryTime (IST), token }', async () => {
  const r = await renewDhanToken({ clientId: 'C1', accessToken: 'x'.repeat(30), transport: async () => ({ status: 200,
    text: JSON.stringify({ createTime: '2026-10-11T11:30:45.447', expiryTime: '2026-10-12T11:30:45.444', token: 'not-a-jwt-but-a-long-enough-token' }) }) });
  assert.equal(r.accessToken, 'not-a-jwt-but-a-long-enough-token');
  assert.equal(r.expiresAt, Date.parse('2026-10-12T06:00:45.444Z'), 'expiryTime is IST');
});

test('the hourly safety pass renews only tokens about to expire', async () => {
  const t = now + 30 * H;   // a later point, after the tokens above were handled
  const edge = account('edge', t + 2 * H), fine = account('fine', t + 10 * H);
  const calls = [];
  const renew = async ({ clientId }) => { calls.push(clientId); return { accessToken: jwt(t + 26 * H), expiresAt: t + 26 * H }; };
  await renewDueTokens({ now: t, renew, log: () => {}, within: 3 * H });
  assert.ok(calls.includes('C-edge'), 'expiring in 2 h: renewed');
  assert.ok(!calls.includes('C-fine'), 'expiring in 10 h: left for the 06:00/18:00 run');
  assert.equal(row(edge).token_expires_at, t + 26 * H);
  assert.equal(row(fine).token_expires_at, t + 10 * H);
});
