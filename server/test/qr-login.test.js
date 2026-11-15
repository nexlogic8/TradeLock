// QR sign-in: the browser shows a code, the signed-in phone scans and approves it, the browser gets a session.
process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
const { test, before, after, beforeEach } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { createServer } = await import('node:http');
const { createHandler } = await import('../src/lib/app.js');
const { buildRouter } = await import('../src/modules/index.js');
const { createUser } = await import('../src/modules/auth/service.js');
const { resetQr, describeBrowser, codeFrom } = await import('../src/modules/auth/qr.js');

let server, base, phone;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const cookieOf = (res, name) => (res.headers.getSetCookie?.() || [res.headers.get('set-cookie') || '']).map(c => c.split(';')[0]).find(c => c.startsWith(`${name}=`));

before(async () => {
  server = createServer(createHandler(buildRouter()));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  createUser({ email: 'qr@test.dev', password: 'secret-pass-1', name: 'Qr User' });
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'qr@test.dev', password: 'secret-pass-1' }) });
  phone = cookieOf(res, 'tl_sid');
  assert.ok(phone, 'the phone is signed in');
});
after(() => server.close());
beforeEach(() => resetQr());

const browserStart = async () => {
  const res = await fetch(`${base}/api/auth/qr/start`, { method: 'POST', headers: { 'User-Agent': UA } });
  const body = await res.json();
  return { ...body, key: cookieOf(res, 'tl_qrb') };
};
const status = (code, key) => fetch(`${base}/api/auth/qr/status?code=${encodeURIComponent(code)}`, { headers: key ? { Cookie: key } : {} });
const asPhone = (path, body) => fetch(`${base}/api/auth/qr/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: phone }, body: JSON.stringify(body) });

test('scan, approve, and the browser that started it is signed in', async () => {
  const b = await browserStart();
  assert.ok(b.code && b.key && b.url.endsWith(`/qr/${b.code}`));
  assert.equal((await (await status(b.code, b.key)).json()).status, 'pending');

  const scan = await (await asPhone('scan', { code: b.url })).json();   // the phone sends what it scanned: the full link
  assert.equal(scan.browser, 'Chrome on Windows');
  assert.equal((await (await status(b.code, b.key)).json()).status, 'scanned');

  assert.equal((await (await asPhone('approve', { code: b.code, approve: true })).json()).status, 'approved');
  const done = await status(b.code, b.key);
  const body = await done.json();
  assert.equal(body.status, 'approved');
  assert.equal(body.user.email, 'qr@test.dev');
  const sid = cookieOf(done, 'tl_sid');
  assert.ok(sid && sid !== 'tl_sid=', 'the browser received its own session');
  const me = await (await fetch(`${base}/api/auth/me`, { headers: { Cookie: sid } })).json();
  assert.equal(me.user.email, 'qr@test.dev');

  // Single use: the code is gone afterwards.
  assert.equal((await (await status(b.code, b.key)).json()).status, 'expired');
});

test('the code alone (without the browser cookie) never gets the session', async () => {
  const b = await browserStart();
  await asPhone('scan', { code: b.code });
  await asPhone('approve', { code: b.code, approve: true });
  const stranger = await status(b.code, 'tl_qrb=someone-else');
  assert.equal(stranger.status, 403);
  assert.equal(cookieOf(stranger, 'tl_sid'), undefined);
  assert.equal((await status(b.code, null)).status, 403);
  // The real browser still gets it.
  assert.equal((await (await status(b.code, b.key)).json()).status, 'approved');
});

test('scanning and approving need a signed-in phone', async () => {
  const b = await browserStart();
  const anon = await fetch(`${base}/api/auth/qr/scan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: b.code }) });
  assert.equal(anon.status, 401);
  const approveFirst = await asPhone('approve', { code: b.code, approve: true });
  assert.equal(approveFirst.status, 400, 'approve only after a scan');
  assert.equal((await (await status(b.code, b.key)).json()).status, 'pending');
});

test('a declined code reports rejected and signs nobody in', async () => {
  const b = await browserStart();
  await asPhone('scan', { code: b.code });
  await asPhone('approve', { code: b.code, approve: false });
  const res = await status(b.code, b.key);
  assert.equal((await res.json()).status, 'rejected');
  assert.equal(cookieOf(res, 'tl_sid'), undefined);
});

test('unknown codes are expired; helpers read links and user agents', async () => {
  assert.equal((await (await status('nope', 'tl_qrb=x')).json()).status, 'expired');
  assert.equal((await asPhone('scan', { code: 'nope' })).status, 400);
  assert.equal(codeFrom('https://tradelock.in/qr/AbC_12-x?x=1'), 'AbC_12-x');
  assert.equal(codeFrom(' AbC '), 'AbC');
  assert.equal(describeBrowser('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'), 'Safari on Mac');
});

test('a QR link opened by a phone camera explains where to scan it', async () => {
  const res = await fetch(`${base}/qr/anything`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Scan this in the TradeLock app/);
});
