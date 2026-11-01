// Account deletion: confirmation, pending-withdrawal block, what is erased and what is kept (de-identified).
process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
const { test, before, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { createServer } = await import('node:http');
const { createHandler } = await import('../src/lib/app.js');
const { buildRouter } = await import('../src/modules/index.js');
const { stmt } = await import('../src/db/index.js');

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

test('delete my account: erases personal and trading data, keeps payment records anonymously', async () => {
  assert.equal((await call('POST', '/api/auth/signup', { email: 'leaving@example.com', password: 'longpassword', name: 'Leaving Trader' })).status, 201);
  const id = stmt('SELECT id FROM users WHERE email = ?').get('leaving@example.com').id;
  assert.equal((await call('POST', '/api/brokers/connect', { broker: 'mock' })).status, 200);
  stmt(`INSERT INTO wallet_ledger (user_id, bucket, amount, type, ref, created_at) VALUES (?, 'funds', 10000, 'topup', 'keep-me', 0)`).run(id);
  stmt(`INSERT INTO withdrawals (user_id, amount, method, destination, status, created_at) VALUES (?, 5000, 'upi', 'x@okhdfc', 'requested', 0)`).run(id);

  assert.equal((await call('POST', '/api/account/delete', { confirm: 'yes' })).body.code, 'CONFIRM_REQUIRED');
  assert.equal((await call('POST', '/api/account/delete', { confirm: 'DELETE' })).body.code, 'WITHDRAWAL_PENDING');
  stmt(`UPDATE withdrawals SET status = 'paid' WHERE user_id = ?`).run(id);

  const r = await call('POST', '/api/account/delete', { confirm: 'delete' });
  assert.equal(r.status, 200);
  assert.equal((await call('GET', '/api/dashboard')).status, 401, 'signed out');
  assert.equal((await call('POST', '/api/auth/login', { email: 'leaving@example.com', password: 'longpassword' })).status, 401, 'cannot sign in again');

  const u = stmt('SELECT * FROM users WHERE id = ?').get(id);
  assert.deepEqual([u.name, u.email, u.password_hash, u.google_sub, !!u.deleted_at], ['Deleted user', `deleted-${id}@deleted.tradelock.in`, '!', null, true]);
  for (const t of ['broker_accounts', 'sessions', 'risk_rules', 'notifications', 'affiliates']) {
    assert.equal(stmt(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`).get(id).n, 0, `${t} erased`);
  }
  assert.equal(stmt(`SELECT COUNT(*) AS n FROM wallet_ledger WHERE user_id = ?`).get(id).n, 1, 'ledger kept (de-identified)');

  // The same email can sign up again later as a brand-new account.
  assert.equal((await call('POST', '/api/auth/signup', { email: 'leaving@example.com', password: 'longpassword' })).status, 201);
});
