// Wallet: top-up, subscription from wallet, referral commission, withdrawals, admin, Razorpay webhook.
process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
process.env.ADMIN_EMAILS = 'admin@example.com';
process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test';
const { test, before, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { createHmac } = await import('node:crypto');
const { createServer } = await import('node:http');
const { createHandler } = await import('../src/lib/app.js');
const { buildRouter } = await import('../src/modules/index.js');
const { stmt } = await import('../src/db/index.js');
const { completeTopup } = await import('../src/modules/wallet/service.js');

let server, base;
const jar = {};
// Cookie jar like a browser: every Set-Cookie is kept by name; an emptied cookie is removed.
const mergeCookies = (prev, list) => {
  const jar = new Map((prev || '').split('; ').filter(Boolean).map(c => [c.split('=')[0], c]));
  for (const s of list) { const kv = s.split(';')[0]; const k = kv.split('=')[0]; if (kv.endsWith('=')) jar.delete(k); else jar.set(k, kv); }
  return [...jar.values()].join('; ');
};
async function call(who, method, path, body, extra = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body && { 'Content-Type': 'application/json' }), ...(jar[who] && { Cookie: jar[who] }), ...extra },
    body: body && JSON.stringify(body),
  });
  jar[who] = mergeCookies(jar[who], res.headers.getSetCookie());
  return { status: res.status, body: await res.json().catch(() => null) };
}
const wallet = async who => (await call(who, 'GET', '/api/wallet')).body;

before(async () => {
  server = createServer(createHandler(buildRouter()));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await call('aff', 'POST', '/api/auth/signup', { email: 'affiliate@example.com', password: 'longpassword' });
  const code = (await call('aff', 'GET', '/api/affiliate')).body.code;
  jar.payer = `tl_ref=${code}`; // arrived through the affiliate's link
  await call('payer', 'POST', '/api/auth/signup', { email: 'payer@example.com', password: 'longpassword' });
  await call('admin', 'POST', '/api/auth/signup', { email: 'admin@example.com', password: 'longpassword' });
  await call('one', 'POST', '/api/auth/signup', { email: 'one-rupee@example.com', password: 'longpassword' });
  await call('withdraw-one', 'POST', '/api/auth/signup', { email: 'withdraw-one@example.com', password: 'longpassword' });
  await call('mixed-wallet', 'POST', '/api/auth/signup', { email: 'mixed-wallet@example.com', password: 'longpassword' });
});
after(() => server.close());

test('top-up (simulated in development) lands in added funds', async () => {
  const r = await call('payer', 'POST', '/api/wallet/topup', { amount: 1000 });
  assert.equal(r.body.provider, 'simulated');
  const w = await wallet('payer');
  assert.deepEqual([w.balances.funds, w.balances.earnings], [100000, 0]);
  assert.equal((await call('payer', 'POST', '/api/wallet/topup', { amount: 0.5 })).status, 400, 'minimum ₹1');
});

test('₹1 can be added to the wallet', async () => {
  const r = await call('one', 'POST', '/api/wallet/topup', { amount: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.body.amount, 100);
  assert.equal((await wallet('one')).balances.funds, 100);
});

test('withdrawals start at ₹100', async () => {
  const uid = stmt('SELECT id FROM users WHERE email = ?').get('withdraw-one@example.com').id;
  stmt(`INSERT INTO wallet_ledger (user_id, bucket, amount, type, ref, created_at)
        VALUES (?, 'earnings', 10000, 'adjustment', 'withdraw-one-test', 0)`).run(uid);
  const small = await call('withdraw-one', 'POST', '/api/wallet/withdraw', { amount: 99.99, method: 'upi', upi: 'test@okhdfc' });
  assert.equal(small.status, 400);
  assert.match(small.body.message, /minimum withdrawal is ₹100/i);
  const r = await call('withdraw-one', 'POST', '/api/wallet/withdraw', { amount: 100, method: 'upi', upi: 'test@okhdfc' });
  assert.equal(r.status, 201);
  assert.equal(r.body.balances.earnings, 0);
  assert.equal(r.body.withdrawals[0].amount, 10000);
  stmt('DELETE FROM withdrawals WHERE user_id = ?').run(uid);
  stmt('DELETE FROM wallet_ledger WHERE user_id = ?').run(uid);
});

test('paying from the wallet renews the plan and credits the referrer 20%', async () => {
  const r = await call('payer', 'POST', '/api/wallet/subscribe');
  assert.equal(r.status, 200);
  assert.equal(r.body.subscription.status, 'active');
  const w = await wallet('payer');
  assert.equal(w.plan.total, 58882, '₹499 + 18% GST = ₹588.82');
  assert.equal(w.balances.funds, 100000 - 58882);
  const a = await wallet('aff');
  assert.equal(a.balances.earnings, 9980, '20% of ₹499 (GST excluded) = ₹99.80');
  assert.equal((await call('aff', 'GET', '/api/affiliate')).body.walletCredited, 9980);
});

test('not enough balance is refused with the shortfall', async () => {
  const r = await call('payer', 'POST', '/api/wallet/subscribe');
  assert.equal(r.body.code, 'INSUFFICIENT_BALANCE');
  assert.equal(r.body.extra.shortfall, 58882 - (100000 - 58882));
});

test('added funds and earnings are both withdrawable', async () => {
  const oneId = stmt('SELECT id FROM users WHERE email = ?').get('one-rupee@example.com').id;
  stmt(`INSERT INTO wallet_ledger (user_id, bucket, amount, type, ref, created_at) VALUES (?, 'funds', 9900, 'adjustment', 'one-topup-more', 0)`).run(oneId);
  const funds = await call('one', 'POST', '/api/wallet/withdraw', { amount: 100, method: 'upi', upi: 'payer@okhdfc' });
  assert.equal(funds.status, 201);
  assert.equal(funds.body.balances.total, 0);
  stmt('DELETE FROM withdrawals WHERE user_id = ?').run(oneId);
  const tooSmall = await call('aff', 'POST', '/api/wallet/withdraw', { amount: 99, method: 'upi', upi: 'aff@okhdfc' });
  assert.equal(tooSmall.status, 400);
  const badUpi = await call('aff', 'POST', '/api/wallet/withdraw', { amount: 100, method: 'upi', upi: 'not-an-upi' });
  assert.match(badUpi.body.message, /UPI ID/);
});

test('a rejected mixed-balance withdrawal restores both buckets', async () => {
  const uid = stmt('SELECT id FROM users WHERE email = ?').get('mixed-wallet@example.com').id;
  stmt(`INSERT INTO wallet_ledger (user_id, bucket, amount, type, ref, created_at) VALUES
        (?, 'funds', 10000, 'adjustment', 'mixed-funds', 0),
        (?, 'earnings', 10000, 'adjustment', 'mixed-earnings', 0)`).run(uid, uid);
  const req = await call('mixed-wallet', 'POST', '/api/wallet/withdraw', { amount: 150, method: 'upi', upi: 'mixed@okhdfc' });
  assert.deepEqual(
    { funds: req.body.balances.funds, earnings: req.body.balances.earnings, total: req.body.balances.total },
    { funds: 5000, earnings: 0, total: 5000 }
  );
  const rejected = await call('admin', 'POST', `/api/admin/withdrawals/${req.body.id}`, { action: 'rejected', note: 'Test return' });
  assert.equal(rejected.status, 200);
  const restored = (await wallet('mixed-wallet')).balances;
  assert.deepEqual({ funds: restored.funds, earnings: restored.earnings, total: restored.total }, { funds: 10000, earnings: 10000, total: 20000 });
});

test('withdrawal holds the money; admin rejection returns it, payment completes it', async () => {
  stmt(`INSERT INTO wallet_ledger (user_id, bucket, amount, type, ref, created_at)
        SELECT id, 'earnings', 50000, 'adjustment', 'test', 0 FROM users WHERE email = 'affiliate@example.com'`).run();
  const req = await call('aff', 'POST', '/api/wallet/withdraw', { amount: 300, method: 'bank', account: '123456789012', ifsc: 'HDFC0001234', name: 'Aff Iliate' });
  assert.equal(req.status, 201);
  assert.equal(req.body.balances.earnings, 9980 + 50000 - 30000, 'held immediately');

  assert.equal((await call('aff', 'GET', '/api/admin/withdrawals')).status, 403, 'non-admins cannot approve');
  const list = (await call('admin', 'GET', '/api/admin/withdrawals')).body.pending;
  assert.equal(list.length, 1);
  assert.equal((await call('admin', 'POST', `/api/admin/withdrawals/${list[0].id}`, { action: 'paid' })).status, 400, 'reference required');
  await call('admin', 'POST', `/api/admin/withdrawals/${list[0].id}`, { action: 'rejected', note: 'Name mismatch' });
  assert.equal((await wallet('aff')).balances.earnings, 9980 + 50000, 'returned on rejection');

  const again = (await call('aff', 'POST', '/api/wallet/withdraw', { amount: 100, method: 'upi', upi: 'aff@okicici' })).body;
  const done = await call('admin', 'POST', `/api/admin/withdrawals/${again.id}`, { action: 'paid', note: 'UPI ref 4321' });
  assert.equal(done.status, 200);
  assert.equal(done.body.processed[0].note, 'UPI ref 4321');
  const w = await wallet('aff');
  assert.equal(w.balances.earnings, 9980 + 50000 - 10000);
  assert.equal(w.withdrawals[0].status, 'paid');
  assert.equal((await call('admin', 'POST', `/api/admin/withdrawals/${again.id}`, { action: 'rejected' })).body.code, 'ALREADY_PROCESSED');
});

test('Razorpay webhook credits once, verified by signature', async () => {
  const uid = stmt(`SELECT id FROM users WHERE email = 'payer@example.com'`).get().id;
  stmt(`INSERT INTO payments (user_id, provider, provider_order_id, amount, status, created_at) VALUES (?, 'razorpay', 'order_T1', 25000, 'created', 0)`).run(uid);
  const startFunds = (await wallet('payer')).balances.funds;
  const raw = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_1', order_id: 'order_T1' } } } });
  const sig = createHmac('sha256', 'whsec_test').update(raw).digest('hex');
  const send = s => fetch(`${base}/api/webhooks/razorpay`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': s }, body: raw });
  assert.equal((await send('forged')).status, 400);
  assert.equal((await send(sig)).status, 200);
  assert.equal((await send(sig)).status, 200, 'redelivery is fine');
  completeTopup('order_T1', 'pay_1'); // the browser's verify call arriving too
  assert.equal((await wallet('payer')).balances.funds, startFunds + 25000, 'credited exactly once');
});

test('mobile number is validated and normalised to +91', async () => {
  assert.equal((await call('payer', 'PATCH', '/api/settings', { phone: '12345' })).status, 400);
  const ok = await call('payer', 'PATCH', '/api/settings', { phone: '098765 43210' });
  assert.equal(ok.body.user.phone, '+919876543210');
  assert.equal((await call('payer', 'PATCH', '/api/settings', { phone: '' })).body.user.phone, null, 'empty clears it');
});

test('subscription checkout: wallet covers it fully, no gateway step', async () => {
  await call('buyer', 'POST', '/api/auth/signup', { email: 'buyer@example.com', password: 'longpassword' });
  await call('buyer', 'POST', '/api/wallet/topup', { amount: 1000 });
  const r = await call('buyer', 'POST', '/api/billing/checkout', { useWallet: true });
  assert.equal(r.body.paid, true);
  assert.equal(r.body.provider, undefined, 'no Razorpay needed');
  assert.equal((await wallet('buyer')).balances.total, 100000 - 58882);
});

test('subscription checkout: wallet part + gateway for the rest (simulated in dev)', async () => {
  const before = (await wallet('buyer')).balances.total;            // ₹411.18
  const end0 = (await call('buyer', 'GET', '/api/billing')).body.subscription.currentPeriodEnd;
  const r = await call('buyer', 'POST', '/api/billing/checkout', { useWallet: true });
  assert.equal(r.body.provider, 'simulated');
  assert.equal(r.body.fromWallet, before);
  assert.equal(r.body.amount, 58882 - before, 'gateway charges only the remainder');
  const after = (await call('buyer', 'GET', '/api/billing')).body;
  assert.equal(after.wallet.total, 0, 'wallet used up');
  assert.equal(Math.round((after.subscription.currentPeriodEnd - end0) / 864e5), 30, 'another month added');
});

test('subscription checkout without the wallet charges the full amount', async () => {
  await call('buyer', 'POST', '/api/wallet/topup', { amount: 200 });
  const r = await call('buyer', 'POST', '/api/billing/checkout', { useWallet: false });
  assert.equal(r.body.amount, 58882);
  assert.equal((await wallet('buyer')).balances.total, 20000, 'wallet untouched');
});

test('a Razorpay subscription payment is applied exactly once (verify + webhook)', async () => {
  const uid = stmt(`SELECT id FROM users WHERE email = 'buyer@example.com'`).get().id;
  const end0 = (await call('buyer', 'GET', '/api/billing')).body.subscription.currentPeriodEnd;
  stmt(`INSERT INTO payments (user_id, provider, provider_order_id, amount, status, purpose, created_at) VALUES (?, 'razorpay', 'order_S1', 38882, 'created', 'subscription', 0)`).run(uid);
  completeTopup('order_S1', 'pay_s1');
  completeTopup('order_S1', 'pay_s1');
  const b = (await call('buyer', 'GET', '/api/billing')).body;
  assert.equal(b.wallet.total, 0, '₹200 wallet + ₹388.82 payment = one plan');
  assert.equal(Math.round((b.subscription.currentPeriodEnd - end0) / 864e5), 30, 'exactly one month added');
});

test('referral code: link fills the box, typed codes are checked, signup attributes it', async () => {
  const code = (await call('aff', 'GET', '/api/affiliate')).body.code;
  // The invite link sends people to /signup with the code in the URL (and remembers it).
  const res = await fetch(`${base}/r/${code.toLowerCase()}`, { redirect: 'manual' });
  assert.equal(res.headers.get('location'), `/signup?ref=${code}`);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  assert.equal((await (await fetch(`${base}/api/referral`, { headers: { Cookie: cookie } })).json()).code, code, 'remembered for a later visit');
  // A typed code is checked.
  assert.equal((await call('anon1', 'POST', '/api/referral', { code: 'NOPE1234' })).body.code, 'INVALID_REFERRAL');
  assert.equal((await call('anon1', 'POST', '/api/auth/signup', { email: 'typo@example.com', password: 'longpassword', ref: 'NOPE1234' })).body.code, 'INVALID_REFERRAL');
  // Typing the code by hand (no link) attributes the referral.
  assert.equal((await call('typed', 'POST', '/api/auth/signup', { email: 'typed@example.com', password: 'longpassword', ref: code.toLowerCase() })).status, 201);
  const affId = stmt('SELECT id FROM users WHERE email = ?').get('affiliate@example.com').id;
  const typedId = stmt('SELECT id FROM users WHERE email = ?').get('typed@example.com').id;
  assert.ok(stmt('SELECT 1 FROM referrals WHERE affiliate_user_id = ? AND referred_user_id = ?').get(affId, typedId));
});
