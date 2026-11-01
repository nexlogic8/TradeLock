// Forgot / reset password: no email → clear message; a reset link works once, expires, and signs out everywhere.
process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
const { test, before, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { createServer } = await import('node:http');
const { createHandler } = await import('../src/lib/app.js');
const { buildRouter } = await import('../src/modules/index.js');
const { stmt } = await import('../src/db/index.js');
const { sha256 } = await import('../src/lib/crypto.js');

let server, base, cookie = '';
const mergeCookies = (prev, list) => {
  const jar = new Map((prev || '').split('; ').filter(Boolean).map(c => [c.split('=')[0], c]));
  for (const s of list) { const kv = s.split(';')[0]; const k = kv.split('=')[0]; if (kv.endsWith('=')) jar.delete(k); else jar.set(k, kv); }
  return [...jar.values()].join('; ');
};
async function call(method, path, body) {
  const res = await fetch(base + path, { method, headers: { ...(body && { 'Content-Type': 'application/json' }), ...(cookie && { Cookie: cookie }) }, body: body && JSON.stringify(body) });
  cookie = mergeCookies(cookie, res.headers.getSetCookie());
  return { status: res.status, body: await res.json().catch(() => null) };
}
before(async () => {
  server = createServer(createHandler(buildRouter()));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('without email set up, forgot password says so clearly', async () => {
  const r = await call('POST', '/api/auth/forgot', { email: 'someone@example.com' });
  assert.equal(r.status, 503);
  assert.equal(r.body.code, 'MAIL_DISABLED');
  assert.match(r.body.message, /Continue with Google/);
});

test('a reset link sets a new password once, and ends existing sessions', async () => {
  assert.equal((await call('POST', '/api/auth/signup', { email: 'reset-me@example.com', password: 'old-password-1' })).status, 201);
  const uid = stmt('SELECT id FROM users WHERE email = ?').get('reset-me@example.com').id;
  const session = cookie;
  const token = 'test-reset-token-abcdefghijklmnop';
  stmt('INSERT INTO password_resets (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(sha256(token), uid, Date.now() + 60e3, Date.now());

  cookie = '';
  assert.equal((await call('POST', '/api/auth/reset', { token, password: 'short' })).status, 400);
  const ok = await call('POST', '/api/auth/reset', { token, password: 'new-password-2' });
  assert.equal(ok.status, 200);
  const again = await call('POST', '/api/auth/reset', { token, password: 'new-password-3' });
  assert.equal(again.body.code, 'RESET_INVALID', 'a link works only once');

  cookie = session;
  assert.equal((await call('GET', '/api/dashboard')).status, 401, 'old sessions are signed out');
  cookie = '';
  assert.equal((await call('POST', '/api/auth/login', { email: 'reset-me@example.com', password: 'old-password-1' })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { email: 'reset-me@example.com', password: 'new-password-2' })).status, 200);
});

test('expired or unknown reset links are refused', async () => {
  const uid = stmt('SELECT id FROM users WHERE email = ?').get('reset-me@example.com').id;
  stmt('INSERT INTO password_resets (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(sha256('old-token-xyz-123456'), uid, Date.now() - 1, Date.now() - 60e3);
  assert.equal((await call('POST', '/api/auth/reset', { token: 'old-token-xyz-123456', password: 'whatever-123' })).body.code, 'RESET_INVALID');
  assert.equal((await call('POST', '/api/auth/reset', { token: 'never-issued', password: 'whatever-123' })).body.code, 'RESET_INVALID');
});
