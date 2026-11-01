// Google sign-in without calling Google: redirect construction, CSRF state check, account linking.
process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
const { test, before, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { createServer } = await import('node:http');
const { createHandler } = await import('../src/lib/app.js');
const { buildRouter } = await import('../src/modules/index.js');
const { findOrCreateGoogleUser } = await import('../src/modules/auth/google.js');
const { createUser, findUserByEmail } = await import('../src/modules/auth/service.js');
const { stmt } = await import('../src/db/index.js');
const { verifyPassword } = await import('../src/lib/crypto.js');

let server, base;
before(async () => {
  server = createServer(createHandler(buildRouter()));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('meta advertises Google when configured', async () => {
  const meta = await (await fetch(`${base}/api/meta`)).json();
  assert.equal(meta.google, true);
});

test('start redirects to Google with PKCE and sets a state cookie', async () => {
  const res = await fetch(`${base}/api/auth/google`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get('location'));
  assert.equal(loc.origin, 'https://accounts.google.com');
  assert.equal(loc.searchParams.get('client_id'), process.env.GOOGLE_CLIENT_ID);
  assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
  assert.match(loc.searchParams.get('redirect_uri'), /\/api\/auth\/google\/callback$/);
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /^tl_oauth=/);
  assert.match(cookie, /HttpOnly/);
  assert.ok(cookie.includes(loc.searchParams.get('state')), 'cookie carries the state');
});

test('callback rejects a mismatched state', async () => {
  const res = await fetch(`${base}/api/auth/google/callback?code=abc&state=forged`, { redirect: 'manual', headers: { Cookie: 'tl_oauth=real.verifier' } });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login?auth_error=google_state');
});

test('admin console sign-in returns to /admin, including its errors', async () => {
  const start = await fetch(`${base}/api/auth/google?next=admin`, { redirect: 'manual' });
  assert.match(start.headers.get('set-cookie'), /^tl_oauth=[^.;]+\.[^.;]+\.admin;/);
  const res = await fetch(`${base}/api/auth/google/callback?code=abc&state=forged`, { redirect: 'manual', headers: { Cookie: 'tl_oauth=real.verifier.admin' } });
  assert.equal(res.headers.get('location'), '/admin?auth_error=google_state');
});

test('callback reports a cancelled consent screen', async () => {
  const res = await fetch(`${base}/api/auth/google/callback?error=access_denied`, { redirect: 'manual' });
  assert.equal(res.headers.get('location'), '/login?auth_error=google_cancelled');
});

test('new Google user is created without a usable password', () => {
  const { id, created } = findOrCreateGoogleUser({ sub: 'g-1', email: 'New@Example.com', name: 'New User' });
  assert.ok(created);
  const u = findUserByEmail('new@example.com');
  assert.equal(u.id, id);
  assert.equal(verifyPassword('anything', u.password_hash), false);
  assert.equal(findOrCreateGoogleUser({ sub: 'g-1', email: 'new@example.com' }).id, id, 'same sub returns same user');
});

test('linking to an existing email revokes the old password (pre-account takeover)', () => {
  createUser({ email: 'victim@example.com', password: 'attacker-chose-this', name: 'Squatter' });
  const { id, created } = findOrCreateGoogleUser({ sub: 'g-victim', email: 'victim@example.com' });
  assert.equal(created, false);
  const u = findUserByEmail('victim@example.com');
  assert.equal(u.id, id);
  assert.equal(u.google_sub, 'g-victim');
  assert.equal(verifyPassword('attacker-chose-this', u.password_hash), false);
});

test('MFA completion without a pending ticket is refused', async () => {
  const res = await fetch(`${base}/api/auth/mfa/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"code":"123456"}' });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, 'MFA_EXPIRED');
});

test('Google sign-up through a referral link credits the referrer when they pay', async () => {
  const { ensureAffiliate } = await import('../src/modules/affiliate/service.js');
  const { paySubscription } = await import('../src/modules/wallet/service.js');
  const affId = createUser({ email: 'creator@example.com', password: 'longpassword', name: 'Creator' });
  ensureAffiliate(affId);
  const code = stmt('SELECT code FROM affiliates WHERE user_id = ?').get(affId).code;
  const { id } = findOrCreateGoogleUser({ sub: 'g-referred', email: 'referred@example.com', name: 'Referred' }, code);
  assert.ok(stmt('SELECT 1 FROM referrals WHERE affiliate_user_id = ? AND referred_user_id = ?').get(affId, id), 'referral recorded');
  stmt(`INSERT INTO wallet_ledger (user_id, bucket, amount, type, ref, created_at) VALUES (?, 'funds', 58882, 'topup', 't', 0)`).run(id);
  paySubscription(id);
  const earned = stmt(`SELECT COALESCE(SUM(amount), 0) AS n FROM wallet_ledger WHERE user_id = ? AND type = 'commission'`).get(affId).n;
  assert.equal(earned, 9980);
});
