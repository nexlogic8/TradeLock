// One free trial per device and per broker account: newer accounts lose a duplicate trial, paid plans are untouched.
process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { stmt } = await import('../src/db/index.js');
const { createUser } = await import('../src/modules/auth/service.js');
const { getSubscription, extendSubscription } = await import('../src/modules/billing/service.js');
const { guardDevice, guardBroker } = await import('../src/modules/billing/trialguard.js');

/** A minimal request context: cookies in, Set-Cookie captured. */
function ctxFor({ cookie, appId } = {}) {
  const headers = {};
  return {
    req: { headers: appId ? { 'x-tl-device': appId } : {} },
    res: { getHeader: k => headers[k], setHeader: (k, v) => { headers[k] = v; } },
    cookies: cookie ? { tl_dev: cookie } : {},
    setCookie: () => String([].concat(headers['Set-Cookie'] || [])[0] || ''),
  };
}
let t = 0;
const user = name => {
  const id = createUser({ email: `${name}@x.test`, password: null, name });
  stmt('UPDATE users SET created_at = ? WHERE id = ?').run(1_000 + ++t, id);   // creation order = call order
  return id;
};

test('a new browser gets a device cookie', () => {
  const ctx = ctxFor();
  guardDevice(ctx, user('first'));
  assert.match(ctx.setCookie(), /^tl_dev=[A-Za-z0-9_-]{8,};.*Max-Age=\d+.*HttpOnly/);
});

test('second account on the same browser: no free trial; the first keeps it', () => {
  const a = user('a'), b = user('b');
  guardDevice(ctxFor({ cookie: 'browser-one-123' }), a);
  assert.equal(getSubscription(a).active, true);
  guardDevice(ctxFor({ cookie: 'browser-one-123' }), b);
  const sb = getSubscription(b);
  assert.equal(sb.active, false);
  assert.match(sb.trialBlocked, /this device/);
  assert.equal(getSubscription(a).active, true);
  assert.equal(stmt("SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND title = 'Free trial not available'").get(b).n, 1);
});

test('older account signing in later on a shared device still keeps its trial', () => {
  const old = user('old'), newer = user('newer');
  guardDevice(ctxFor({ cookie: 'browser-two-456' }), newer);
  assert.equal(getSubscription(newer).active, true);
  guardDevice(ctxFor({ cookie: 'browser-two-456' }), old);
  assert.equal(getSubscription(old).active, true);
  assert.equal(getSubscription(newer).active, false);
});

test('Android device ID header beats cookies (clearing app cookies does not reset the trial)', () => {
  const a = user('p1'), b = user('p2');
  guardDevice(ctxFor({ appId: 'android-id-abcdef', cookie: 'c1-aaaaaaaa' }), a);
  guardDevice(ctxFor({ appId: 'android-id-abcdef', cookie: 'c2-bbbbbbbb' }), b);
  assert.equal(getSubscription(b).active, false);
});

test('paid accounts are never affected', () => {
  const a = user('payer-old'), b = user('payer-new');
  extendSubscription(b, 30);
  guardDevice(ctxFor({ cookie: 'browser-three-789' }), a);
  guardDevice(ctxFor({ cookie: 'browser-three-789' }), b);
  assert.equal(getSubscription(b).active, true);
  assert.equal(getSubscription(b).status, 'active');
});

test('same Dhan client ID on a second account: no free trial', () => {
  const a = user('dh1'), b = user('dh2');
  for (const id of [a, b]) {
    stmt(`INSERT INTO broker_accounts (user_id, broker, client_id, status, created_at) VALUES (?, 'dhan', '1100223344', 'connected', ?)`).run(id, Date.now());
  }
  guardBroker(b, 'dhan', '1100223344');
  assert.equal(getSubscription(a).active, true);
  assert.equal(getSubscription(b).active, false);
  assert.match(getSubscription(b).trialBlocked, /broker account/);
  // Different devices and different client IDs stay independent.
  const c = user('dh3');
  guardBroker(c, 'dhan', '9999999999');
  assert.equal(getSubscription(c).active, true);
});
