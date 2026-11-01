// TradeLock wallet: an append-only ledger in paise. See schema migration 6 for the two buckets.
import { stmt, tx } from '../../db/index.js';
import { config } from '../../config.js';
import { bad, conflict, notFound, HttpError } from '../../lib/errors.js';
import { emit } from '../../lib/bus.js';
import { notify } from '../notifications/service.js';
import { audit } from '../audit/service.js';
import { extendSubscription, getSubscription } from '../billing/service.js';
import { razorpayEnabled, createOrder } from './razorpay.js';
import { quote, recordRedemption, redeemedWith } from '../billing/coupons.js';

export const PLAN_PAISE = Math.round(config.plan.priceInr * 100);
export const PLAN_TOTAL_PAISE = Math.round(PLAN_PAISE * (1 + config.plan.gstRate));   // incl. GST
export const COMMISSION_PAISE = Math.floor(PLAN_PAISE * config.affiliateRate);         // GST is not commissionable
export const LIMITS = Object.freeze({ minTopup: 1_00, maxTopup: 50_000_00, maxFunds: 1_00_000_00, minWithdraw: 100_00 });

const rupees = paise => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function balances(userId) {
  const b = { funds: 0, earnings: 0 };
  for (const r of stmt('SELECT bucket, COALESCE(SUM(amount), 0) AS bal FROM wallet_ledger WHERE user_id = ? GROUP BY bucket').all(userId)) b[r.bucket] = r.bal;
  const pending = stmt(`SELECT COALESCE(SUM(amount), 0) AS n FROM withdrawals WHERE user_id = ? AND status = 'requested'`).get(userId).n;
  return { funds: b.funds, earnings: b.earnings, total: b.funds + b.earnings, pendingWithdrawals: pending };
}

/** Insert one ledger line; returns false if this (bucket, type, ref) was already recorded. */
function entry(userId, bucket, amount, type, ref, note = '') {
  const r = stmt('INSERT OR IGNORE INTO wallet_ledger (user_id, bucket, amount, type, ref, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(userId, bucket, amount, type, ref, note, Date.now());
  return r.changes > 0;
}

const pushBalance = userId => emit(userId, 'wallet', balances(userId));

export const ledger = (userId, limit = 50) =>
  stmt('SELECT id, bucket, amount, type, note, created_at AS createdAt FROM wallet_ledger WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit);

export const withdrawalsFor = userId =>
  stmt('SELECT id, amount, method, destination, status, note, created_at AS createdAt, processed_at AS processedAt FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 20').all(userId);

// ---------------- top-ups ----------------

export const creditTopup = tx((userId, amount, ref, via) => {
  if (!entry(userId, 'funds', amount, 'topup', ref, `Added via ${via}`)) return false;
  stmt(`UPDATE payments SET status = 'paid', paid_at = ? WHERE provider_order_id = ? AND status != 'paid'`).run(Date.now(), ref);
  audit(userId, 'wallet.topup', { amount, ref, via });
  return true;
});

function afterTopup(userId, amount) {
  notify(userId, { kind: 'billing', level: 'ok', title: `${rupees(amount)} added to your wallet`, body: 'Use it to pay for your TradeLock subscription.' });
  pushBalance(userId);
}

/** Create a Razorpay order and return what the browser needs to open Checkout. */
async function razorpayOrder(user, amount, purpose, couponCode = null) {
  const order = await createOrder(amount, `${purpose === 'subscription' ? 's' : 'w'}${user.id}-${Date.now()}`, { userId: String(user.id), purpose })
    .catch(e => { throw new HttpError(502, 'PAYMENT_PROVIDER', `Could not start the payment: ${e.message}`); });
  stmt(`INSERT INTO payments (user_id, provider, provider_order_id, amount, status, purpose, coupon_code, created_at) VALUES (?, 'razorpay', ?, ?, 'created', ?, ?, ?)`)
    .run(user.id, order.id, amount, purpose, couponCode, Date.now());
  const phone = stmt('SELECT phone FROM users WHERE id = ?').get(user.id)?.phone;
  return {
    provider: 'razorpay', keyId: config.razorpay.keyId, orderId: order.id, amount, name: user.name, email: user.email,
    contact: phone || config.razorpay.defaultContact, purpose,
  };
}

export async function startTopup(user, rupeesAmount) {
  const amount = Math.round(Number(rupeesAmount) * 100);
  if (!Number.isFinite(amount) || amount < LIMITS.minTopup || amount > LIMITS.maxTopup) {
    throw bad('VALIDATION', `Add between ${rupees(LIMITS.minTopup)} and ${rupees(LIMITS.maxTopup)} at a time.`, { field: 'amount' });
  }
  if (balances(user.id).funds + amount > LIMITS.maxFunds) {
    throw bad('WALLET_LIMIT', `Added funds can hold up to ${rupees(LIMITS.maxFunds)}.`);
  }
  if (razorpayEnabled()) return razorpayOrder(user, amount, 'topup');
  if (config.isProd) throw new HttpError(501, 'PAYMENTS_NOT_CONFIGURED', 'Online payments are not set up yet. Please try again later.');
  // Development only: credit straight away so the wallet can be tried without a gateway.
  const ref = `sim-${user.id}-${Date.now()}`;
  stmt(`INSERT INTO payments (user_id, provider, provider_order_id, amount, status, created_at) VALUES (?, 'simulated', ?, ?, 'created', ?)`)
    .run(user.id, ref, amount, Date.now());
  creditTopup(user.id, amount, ref, 'test payment');
  afterTopup(user.id, amount);
  return { provider: 'simulated', credited: true, amount };
}

/** Called with the order the payment belongs to, once its signature has been verified. */
export function completeTopup(orderId, paymentId) {
  const p = stmt('SELECT * FROM payments WHERE provider_order_id = ?').get(orderId);
  if (!p) throw notFound('Payment not found');
  stmt('UPDATE payments SET provider_payment_id = COALESCE(provider_payment_id, ?) WHERE id = ?').run(paymentId, p.id);
  const credited = creditTopup(p.user_id, p.amount, orderId, 'Razorpay');
  if (p.purpose === 'subscription') {
    // The payment covered what the wallet couldn't; buy the plan from the wallet now. Same ref = applied once.
    // The coupon was checked when the order was created, so it is honoured even if it expired meanwhile.
    try { paySubscription(p.user_id, `sub-rzp-${orderId}`, p.amount, p.coupon_code, { lenient: true }); }
    catch (e) {
      notify(p.user_id, { kind: 'billing', level: 'warn', title: `${rupees(p.amount)} added to your wallet`, body: `Your payment arrived but the plan could not be renewed (${e.message}). Pay from the Subscription page.` });
      pushBalance(p.user_id);
    }
  } else if (credited) {
    afterTopup(p.user_id, p.amount);
  }
  return p;
}

// ---------------- subscription from the wallet ----------------

/** Credit the referrer 20% of the plan price (excl. GST) when a referred user pays. */
function creditCommission(payerId, ref, paidExGst = PLAN_PAISE) {
  const r = stmt('SELECT affiliate_user_id AS aff FROM referrals WHERE referred_user_id = ?').get(payerId);
  const amount = Math.floor(paidExGst * config.affiliateRate);
  if (!r || amount <= 0) return;
  if (entry(r.aff, 'earnings', amount, 'commission', ref, 'Commission: a referred trader paid for TradeLock Pro')) {
    notify(r.aff, { kind: 'billing', level: 'ok', title: `${rupees(amount)} commission added to your wallet`, body: 'Someone you referred paid for TradeLock Pro. Withdraw it or use it for your subscription.' });
    pushBalance(r.aff);
  }
}

const alreadyApplied = (userId, ref) =>
  !!stmt(`SELECT 1 FROM wallet_ledger WHERE user_id = ? AND type = 'subscription' AND ref = ?`).get(userId, ref) || redeemedWith(ref);

/** Buy the plan from the wallet: 1 month at full price, or what the coupon gives. Idempotent per ref. */
export const paySubscriptionFromWallet = tx((userId, givenRef = null, couponCode = null, opts = {}) => {
  if (givenRef && alreadyApplied(userId, givenRef)) return { ref: givenRef, periodEnd: getSubscription(userId).currentPeriodEnd, duplicate: true };
  const q = quote(userId, couponCode, opts);
  const b = balances(userId);
  if (b.total < q.total) {
    throw bad('INSUFFICIENT_BALANCE', `Your wallet has ${rupees(b.total)}. Add ${rupees(q.total - b.total)} more to pay ${rupees(q.total)}.`,
      { shortfall: q.total - b.total });
  }
  // Spend added funds first (they can't be withdrawn), then earnings.
  const fromFunds = Math.min(b.funds, q.total);
  const fromEarnings = q.total - fromFunds;
  const ref = givenRef || `sub-${userId}-${Date.now()}`;
  const note = `${config.plan.name} · ${q.months} month${q.months === 1 ? '' : 's'}${q.coupon ? ` · coupon ${q.coupon.code}` : ''} incl. ${Math.round(config.plan.gstRate * 100)}% GST`;
  if (fromFunds) entry(userId, 'funds', -fromFunds, 'subscription', ref, note);
  if (fromEarnings) entry(userId, 'earnings', -fromEarnings, 'subscription', ref, note);
  const periodEnd = extendSubscription(userId, 30 * q.months);
  recordRedemption(userId, ref, q);
  creditCommission(userId, ref, q.net);
  audit(userId, 'wallet.subscription', { amount: q.total, months: q.months, coupon: q.coupon?.code, ref, periodEnd });
  return { ref, periodEnd, quote: q };
});

export function paySubscription(userId, ref = null, viaRazorpay = 0, couponCode = null, opts = {}) {
  const res = paySubscriptionFromWallet(userId, ref, couponCode, opts);
  if (!res.duplicate) {
    const total = res.quote.total;
    const until = new Date(res.periodEnd).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
    const how = total === 0 ? `Coupon ${res.quote.coupon?.code} applied: no payment needed`
      : viaRazorpay
        ? `Paid ${rupees(Math.min(viaRazorpay, total))} with Razorpay${total > viaRazorpay ? ` and ${rupees(total - viaRazorpay)} from your wallet` : ''}`
        : `Paid ${rupees(total)} from your wallet`;
    notify(userId, { kind: 'billing', level: 'ok', title: 'TradeLock Pro active', body: `${how}. Active until ${until}.` });
  }
  pushBalance(userId);
  return { ...res, subscription: getSubscription(userId) };
}

/**
 * Subscription checkout. With useWallet the wallet pays first and Razorpay only charges the rest;
 * if the wallet covers everything there is no gateway step at all.
 */
export async function startSubscriptionCheckout(user, useWallet, couponCode = null) {
  const q = quote(user.id, couponCode);   // throws COUPON_INVALID with the reason
  const code = q.coupon?.code || null;
  const b = balances(user.id);
  const fromWallet = useWallet ? Math.min(b.total, q.total) : 0;
  const due = q.total - fromWallet;
  if (due <= 0) return { paid: true, ...paySubscription(user.id, null, 0, code) };
  // Razorpay's minimum charge is ₹1; anything above what's needed stays in the wallet.
  const charge = Math.max(100, due);
  if (razorpayEnabled()) return { paid: false, fromWallet, ...(await razorpayOrder(user, charge, 'subscription', code)) };
  if (config.isProd) throw new HttpError(501, 'PAYMENTS_NOT_CONFIGURED', 'Online payments are not set up yet. Please try again later.');
  // Development: simulate the gateway payment, then complete exactly as a real one would.
  const ref = `sim-sub-${user.id}-${Date.now()}`;
  stmt(`INSERT INTO payments (user_id, provider, provider_order_id, amount, status, purpose, coupon_code, created_at) VALUES (?, 'simulated', ?, ?, 'created', 'subscription', ?, ?)`)
    .run(user.id, ref, charge, code, Date.now());
  completeTopup(ref, 'simulated');
  return { paid: true, provider: 'simulated', fromWallet, amount: charge, subscription: getSubscription(user.id) };
}

// ---------------- withdrawals (earnings only) ----------------

const UPI = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/;
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;

export function normalizeDestination(method, input = {}) {
  if (method === 'upi') {
    const upi = String(input.upi || '').trim();
    if (!UPI.test(upi)) throw bad('VALIDATION', 'Enter a valid UPI ID, like name@okhdfcbank.', { field: 'upi' });
    return upi;
  }
  if (method === 'bank') {
    const account = String(input.account || '').replace(/\s/g, '');
    const ifsc = String(input.ifsc || '').trim().toUpperCase();
    const name = String(input.name || '').trim();
    if (!/^\d{9,18}$/.test(account)) throw bad('VALIDATION', 'Account number must be 9 to 18 digits.', { field: 'account' });
    if (!IFSC.test(ifsc)) throw bad('VALIDATION', 'Enter a valid IFSC code, like HDFC0001234.', { field: 'ifsc' });
    if (name.length < 2) throw bad('VALIDATION', 'Enter the account holder name.', { field: 'name' });
    return `${name} · ${account} · ${ifsc}`;
  }
  throw bad('VALIDATION', 'Choose UPI or bank transfer.');
}

const maskDest = d => d.replace(/\d(?=\d{4})/g, '•');

export const requestWithdrawal = tx((userId, rupeesAmount, method, destinationInput) => {
  const amount = Math.round(Number(rupeesAmount) * 100);
  if (!Number.isFinite(amount) || amount < LIMITS.minWithdraw) throw bad('VALIDATION', `The minimum withdrawal is ${rupees(LIMITS.minWithdraw)}.`, { field: 'amount' });
  const destination = normalizeDestination(method, destinationInput);
  const b = balances(userId);
  if (amount > b.total) {
    throw bad('INSUFFICIENT_BALANCE', `You can withdraw up to ${rupees(b.total)} from your wallet.`);
  }
  const { lastInsertRowid } = stmt(`INSERT INTO withdrawals (user_id, amount, method, destination, status, created_at) VALUES (?, ?, ?, ?, 'requested', ?)`)
    .run(userId, amount, method, destination, Date.now());
  const id = Number(lastInsertRowid);
  // Hold the money now so it can't be spent twice; a rejection returns it.
  const fromEarnings = Math.min(amount, b.earnings);
  const fromFunds = amount - fromEarnings;
  if (fromEarnings) entry(userId, 'earnings', -fromEarnings, 'withdrawal', `wd-${id}`, `Withdrawal to ${maskDest(destination)}`);
  if (fromFunds) entry(userId, 'funds', -fromFunds, 'withdrawal', `wd-${id}`, `Withdrawal to ${maskDest(destination)}`);
  audit(userId, 'wallet.withdraw_requested', { id, amount, method });
  return id;
});

export function withdraw(userId, body) {
  const id = requestWithdrawal(userId, body.amount, body.method, body);
  notify(userId, { kind: 'billing', level: 'info', title: 'Withdrawal requested', body: 'We will send it within 2 working days and notify you when it is paid.' });
  pushBalance(userId);
  return id;
}

// ---------------- admin ----------------

export const pendingWithdrawals = () =>
  stmt(`SELECT w.id, w.amount, w.method, w.destination, w.created_at AS createdAt, u.email, u.name
        FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.status = 'requested' ORDER BY w.created_at`).all();

export const processWithdrawal = tx((adminId, id, action, note = '') => {
  const w = stmt('SELECT * FROM withdrawals WHERE id = ?').get(Number(id));
  if (!w) throw notFound('Withdrawal not found');
  if (w.status !== 'requested') throw conflict('ALREADY_PROCESSED', `This withdrawal is already ${w.status}.`);
  if (!['paid', 'rejected'].includes(action)) throw bad('VALIDATION', 'Action must be paid or rejected.');
  stmt('UPDATE withdrawals SET status = ?, note = ?, processed_at = ?, processed_by = ? WHERE id = ?').run(action, note || null, Date.now(), adminId, w.id);
  if (action === 'rejected') {
    const held = stmt(`SELECT bucket, -SUM(amount) AS amount FROM wallet_ledger
                       WHERE user_id = ? AND type = 'withdrawal' AND ref = ? GROUP BY bucket`)
      .all(w.user_id, `wd-${w.id}`);
    for (const part of held) entry(w.user_id, part.bucket, part.amount, 'withdrawal_reversal', `wd-${w.id}`, `Withdrawal returned${note ? `: ${note}` : ''}`);
  }
  audit(adminId, `admin.withdrawal_${action}`, { id: w.id, userId: w.user_id, amount: w.amount });
  return w;
});

export function settleWithdrawal(adminId, id, action, note) {
  const w = processWithdrawal(adminId, id, action, note);
  notify(w.user_id, action === 'paid'
    ? { kind: 'billing', level: 'ok', title: `Withdrawal of ${rupees(w.amount)} paid`, body: `Sent to ${maskDest(w.destination)}.${note ? ` Reference: ${note}` : ''}` }
    : { kind: 'billing', level: 'warn', title: 'Withdrawal returned to your wallet', body: `${rupees(w.amount)} is back in your wallet.${note ? ` Reason: ${note}` : ''}` });
  pushBalance(w.user_id);
  return w;
}
