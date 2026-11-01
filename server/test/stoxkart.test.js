// StoxKart stage 1: the Superr API login (password → TOTP → signed token), funds, and the encrypted link that never
// becomes the active broker.
process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
const { test, before, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { createHmac } = await import('node:crypto');
const { createServer } = await import('node:http');
const { createHandler } = await import('../src/lib/app.js');
const { buildRouter } = await import('../src/modules/index.js');
const { stmt } = await import('../src/db/index.js');
const { totp } = await import('../src/lib/crypto.js');
const { createStoxkartClient, saveStoxkartLink, testStoxkartLink, stoxkartLink, removeStoxkartLink } = await import('../src/modules/broker/stoxkart.js');

const CREDS = { clientId: 'SV54275', password: 'pass word!', apiKey: 'KEY12345678', apiSecret: 'SECRET987654321', totpSecret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' };
function fakeStoxkart({ fail } = {}) {
  const calls = [];
  const transport = async (method, url, { headers, body }) => {
    const path = url.replace('https://openapi.stoxkart.com', '');
    calls.push({ method, path, headers, body });
    const ok = data => ({ status: 200, text: JSON.stringify({ status: 'success', data }) });
    if (path.startsWith('/auth/login')) return fail === 'login' ? { status: 200, text: JSON.stringify({ status: 'error', message: 'Invalid credentials' }) } : ok({ token: 'REQ-1', is_2fa_enabled: true });
    if (path.startsWith('/auth/twofa/verify')) return ok({ request_token: 'AUTH-2' });
    if (path === '/auth/token') return ok({ access_token: 'ACCESS-3' });
    if (path === '/funds') return ok({ cash: '150000.00', net: '124020.87', available_limit: '124020.87', utilized_limit: '0.00', realised_profit: '-350.00', collateral: '0.00' });
    return { status: 404, text: '{}' };
  };
  return { calls, transport };
}

let server, uid;
before(async () => {
  server = createServer(createHandler(buildRouter()));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  await fetch(`http://127.0.0.1:${server.address().port}/api/auth/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'sk@example.com', password: 'longpassword' }) });
  uid = stmt('SELECT id FROM users WHERE email = ?').get('sk@example.com').id;
});
after(() => server.close());

test('login: password, then the TOTP code, then a token signed with HMAC-SHA256(api key + request token, api secret)', async () => {
  const f = fakeStoxkart(), now = Date.parse('2026-10-26T08:55:00+05:30');
  const c = createStoxkartClient({ ...CREDS, transport: f.transport });
  assert.equal(await c.login({ now }), 'ACCESS-3');
  const [a, b, t] = f.calls;
  assert.equal(a.path, '/auth/login?api-key=KEY12345678');
  assert.deepEqual(a.body, { platform: 'api', data: { client_id: 'SV54275', password: 'pass word!' } });
  assert.equal(b.path, '/auth/twofa/verify?api-key=KEY12345678');
  assert.deepEqual(b.body, { platform: 'api', data: { client_id: 'SV54275', token: 'REQ-1', action: 'api-key-validation', otp: totp(CREDS.totpSecret, now) } });
  assert.deepEqual(t.body, { api_key: 'KEY12345678', signature: createHmac('sha256', 'KEY12345678AUTH-2').update('SECRET987654321').digest('hex'), req_token: 'AUTH-2' });
  const funds = await c.funds('ACCESS-3');
  assert.deepEqual(funds, { available: 124020.87, cash: 150000, net: 124020.87, used: 0, realised: -350, collateral: 0 });
  assert.deepEqual((({ 'X-Access-Token': x, 'X-Client-Id': y, 'X-Platform': z, 'X-API-Key': k }) => [x, y, z, k])(f.calls[3].headers), ['ACCESS-3', 'SV54275', 'api', 'KEY12345678']);
  for (const c of f.calls.slice(0, 3)) assert.deepEqual([c.headers['X-API-Key'], c.headers['X-API-Secret']], ['KEY12345678', 'SECRET987654321'], `key pair in the headers of ${c.path}`);
});

test('link: saved encrypted, never returned; a test records the funds or the refusal; Dhan is not touched', async () => {
  const saved = saveStoxkartLink(uid, CREDS);
  assert.deepEqual([saved.linked, saved.clientId, saved.status], [true, '•••• 4275', 'linked']);
  const raw = stmt('SELECT * FROM broker_links WHERE user_id = ?').get(uid);
  for (const secret of [CREDS.password, CREDS.apiKey, CREDS.apiSecret, CREDS.totpSecret]) {
    assert.ok(!raw.creds_enc.includes(secret), 'stored encrypted');
    assert.ok(!JSON.stringify(stoxkartLink(uid)).includes(secret), 'never sent to the page');
  }
  assert.equal(stmt('SELECT COUNT(*) AS n FROM broker_accounts WHERE user_id = ?').get(uid).n, 0, 'not an active broker account');

  const ok = await testStoxkartLink(uid, null, { transport: fakeStoxkart().transport });
  assert.deepEqual([ok.status, ok.funds.available], ['verified', 124020.87]);
  // An update with blank fields keeps the stored secrets.
  assert.equal(saveStoxkartLink(uid, { clientId: '', password: '', apiKey: '', apiSecret: '', totpSecret: '' }).status, 'linked');
  const bad = await testStoxkartLink(uid, null, { transport: fakeStoxkart({ fail: 'login' }).transport });
  assert.equal(bad.status, 'failed');
  assert.match(bad.lastError, /\/auth\/login: Invalid credentials/);
  assert.deepEqual(removeStoxkartLink(uid), { linked: false });
  assert.equal(stoxkartLink(uid).linked, false);
});

test('a 6-digit code instead of the TOTP setup key is refused with a clear message', () => {
  assert.throws(() => saveStoxkartLink(uid, { ...CREDS, totpSecret: '123456' }), /6-digit code from your authenticator/);
  assert.throws(() => saveStoxkartLink(uid, { ...CREDS, totpSecret: 'ABC1' }), /TOTP secret: enter the setup key/);
  assert.equal(saveStoxkartLink(uid, { ...CREDS, totpSecret: 'JBSWY3DPEH' }).status, 'linked', 'a short (10-character) setup key is accepted');
  removeStoxkartLink(uid);
});

test('the registered redirect URL sends the user back to Broker accounts (no login needed)', async () => {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/brokers/stoxkart/callback?auth_token=x`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/brokers?stoxkart=back');
});
