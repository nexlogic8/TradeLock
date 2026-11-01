// Coupons: pricing (percent / flat / free, N months), every usage rule, payment paths and commission.
process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { stmt } = await import('../src/db/index.js');
const { createUser } = await import('../src/modules/auth/service.js');
const { getSubscription } = await import('../src/modules/billing/service.js');
const { quote, createCoupon, listCoupons, setCouponActive, deleteCoupon } = await import('../src/modules/billing/coupons.js');
const { startSubscriptionCheckout, balances } = await import('../src/modules/wallet/service.js');

const DAY = 864e5;
const PRICE = 49900;   // ₹499 in paise
let n = 0;
const user = (extra = {}) => {
  const email = `c${++n}@x.test`;
  const id = createUser({ email, password: null, name: `C${n}`, ...extra });
  return { id, email, name: `C${n}` };
};
const coupon = b => createCoupon(1, { discountType: 'percent', discountValue: 10, ...b });
const reason = fn => { try { fn(); return null; } catch (e) { return e.message; } };
const today = () => new Date(Date.now() + 330 * 60e3).toISOString().slice(0, 10);
const plusDays = d => new Date(Date.now() + 330 * 60e3 + d * DAY).toISOString().slice(0, 10);

test('no coupon: one month at full price + GST', () => {
  const q = quote(user().id);
  assert.deepEqual([q.months, q.base, q.discount, q.gst, q.total, q.coupon], [1, PRICE, 0, 8982, 58882, null]);
});

test('percent, flat and free coupons; codes are case-insensitive', () => {
  const u = user();
  coupon({ code: 'Half3', discountType: 'percent', discountValue: 50, months: 3 });
  const q = quote(u.id, ' half3 ');
  assert.deepEqual([q.months, q.base, q.discount, q.net, q.gst, q.total], [3, 149700, 74850, 74850, 13473, 88323]);
  assert.equal(q.coupon.label, '50% off · 3 months');
  coupon({ code: 'FLAT100', discountType: 'flat', discountValue: 100 });
  assert.equal(quote(u.id, 'flat100').net, PRICE - 10000);
  coupon({ code: 'FREE1', discountValue: 100 });
  assert.equal(quote(u.id, 'FREE1').total, 0);
  assert.equal(quote(u.id, 'FREE1').coupon.label, 'Free · 1 month');
});

test('rules: unknown, off, not started, expired, used up, per user, new users only', () => {
  const u = user();
  assert.match(reason(() => quote(u.id, 'NOPE')), /not valid/);
  const off = coupon({ code: 'OFFX' }); setCouponActive(off.id, false);
  assert.match(reason(() => quote(u.id, 'OFFX')), /not valid/);
  coupon({ code: 'SOON', validFrom: plusDays(3) });
  assert.match(reason(() => quote(u.id, 'SOON')), /starts on/);
  coupon({ code: 'OLD', validFrom: plusDays(-10), validUntil: plusDays(-1) });
  assert.match(reason(() => quote(u.id, 'OLD')), /expired/);
  coupon({ code: 'TODAY', validFrom: today(), validUntil: today() });
  assert.equal(reason(() => quote(u.id, 'TODAY')), null, 'valid all day on its start/end date');
  assert.match(reason(() => createCoupon(1, { code: 'BAD', discountValue: 150 })), /between 1 and 100/);
  assert.match(reason(() => createCoupon(1, { code: 'TODAY', discountValue: 5 })), /already exists/);
});

test('free coupon activates the plan with no payment, once per user', async () => {
  const u = user();
  coupon({ code: 'GIFT2', discountValue: 100, months: 2, perUserLimit: 1 });
  const before = getSubscription(u.id).trialEndsAt;
  const r = await startSubscriptionCheckout(u, true, 'gift2');
  assert.equal(r.paid, true);
  const s = getSubscription(u.id);
  assert.equal(s.status, 'active');
  assert.ok(Math.abs(s.currentPeriodEnd - (before + 60 * DAY)) < 5000, 'trial days kept, then 2 months');
  assert.equal(balances(u.id).total, 0);
  await assert.rejects(startSubscriptionCheckout(u, true, 'GIFT2'), /already used/);
  assert.equal(listCoupons().find(c => c.code === 'GIFT2').uses, 1);
});

test('paid with a coupon: discount applied, GST on the discounted price, commission on what was paid', async () => {
  const aff = user();
  const code = stmt('SELECT code FROM affiliates WHERE user_id = ?').get(aff.id).code;
  const u = user({ refCode: code });
  coupon({ code: 'NEW25', discountValue: 25, newUsersOnly: true, maxRedemptions: 1 });
  const r = await startSubscriptionCheckout(u, true, 'NEW25');   // dev: simulated gateway payment
  assert.equal(r.paid, true);
  assert.equal(getSubscription(u.id).status, 'active');
  const paid = stmt(`SELECT -SUM(amount) AS n FROM wallet_ledger WHERE user_id = ? AND type = 'subscription'`).get(u.id).n;
  const net = PRICE - Math.round(PRICE * 0.25);
  assert.equal(paid, net + Math.round(net * 0.18));
  assert.equal(balances(aff.id).earnings, Math.floor(net * 0.2), 'commission on the discounted price');
  // Used up (max 1), and not for a second payment anyway (new users only).
  assert.match(reason(() => quote(user().id, 'NEW25')), /fully used/);
  coupon({ code: 'NEWONLY', newUsersOnly: true });
  assert.match(reason(() => quote(u.id, 'NEWONLY')), /first subscription/);
});

test('used coupons are switched off instead of deleted', async () => {
  const unused = coupon({ code: 'DELME' });
  assert.deepEqual(deleteCoupon(unused.id), { deleted: true });
  const used = listCoupons().find(c => c.code === 'GIFT2');
  assert.deepEqual(deleteCoupon(used.id), { deleted: false, disabled: true });
  assert.equal(listCoupons().find(c => c.code === 'GIFT2').status, 'off');
});
