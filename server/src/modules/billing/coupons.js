// Subscription coupons. A coupon buys N months of TradeLock Pro at a percent or flat discount, inside an
// optional validity window, with optional caps on total uses and uses per user, and can be limited to
// traders who have never paid before. Prices are in paise; GST is charged on the discounted amount.
import { randomBytes } from 'node:crypto';
import { stmt } from '../../db/index.js';
import { config } from '../../config.js';
import { bad, notFound } from '../../lib/errors.js';

const unitPaise = () => Math.round(config.plan.priceInr * 100);
export const normalizeCode = s => String(s || '').trim().toUpperCase().replace(/\s+/g, '');
const CODE = /^[A-Z0-9_-]{3,24}$/;

/** A readable random code: no 0/O/1/I. */
export function generateCode(prefix = 'TL') {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(6);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `${normalizeCode(prefix).slice(0, 8)}${out}`;
}

const usesOf = id => stmt('SELECT COUNT(*) AS n FROM coupon_redemptions WHERE coupon_id = ?').get(id).n;
const userUsesOf = (id, userId) => stmt('SELECT COUNT(*) AS n FROM coupon_redemptions WHERE coupon_id = ? AND user_id = ?').get(id, userId).n;
const hasPaidBefore = userId =>
  !!stmt(`SELECT 1 FROM wallet_ledger WHERE user_id = ? AND type = 'subscription' LIMIT 1`).get(userId)
  || !!stmt('SELECT 1 FROM coupon_redemptions WHERE user_id = ? LIMIT 1').get(userId);

const fmtDay = ts => new Date(ts + 330 * 60e3).toISOString().slice(0, 10).split('-').reverse().join('-');

/** Why this user cannot use this coupon now, or null. `lenient`: the order was already validated at checkout. */
function refusal(c, userId, { at, lenient }) {
  if (!c || (!c.active && !lenient)) return 'This coupon code is not valid.';
  if (lenient) return null;
  if (c.valid_from && at < c.valid_from) return `This coupon starts on ${fmtDay(c.valid_from)}.`;
  if (c.valid_until && at > c.valid_until) return 'This coupon has expired.';
  if (c.max_redemptions && usesOf(c.id) >= c.max_redemptions) return 'This coupon has been fully used.';
  if (c.per_user_limit && userUsesOf(c.id, userId) >= c.per_user_limit) {
    return c.per_user_limit === 1 ? 'You have already used this coupon.' : `You have used this coupon ${c.per_user_limit} times, the maximum.`;
  }
  if (c.new_users_only && hasPaidBefore(userId)) return 'This coupon is only for your first subscription.';
  return null;
}

/**
 * What the next subscription payment costs. Without a code: 1 month at full price.
 * @returns {{ months, base, discount, net, gst, total, coupon: null | { id, code, label } }}
 */
export function quote(userId, code = null, { at = Date.now(), lenient = false } = {}) {
  const unit = unitPaise();
  const price = (months, discount, coupon) => {
    const base = unit * months;
    const net = Math.max(0, base - discount);
    const gst = Math.round(net * config.plan.gstRate);
    return { months, base, discount: base - net, net, gst, total: net + gst, coupon };
  };
  const wanted = normalizeCode(code);
  if (!wanted) return price(1, 0, null);
  const c = stmt('SELECT * FROM coupons WHERE code = ?').get(wanted);
  const why = refusal(c, userId, { at, lenient });
  if (why) throw bad('COUPON_INVALID', why, { field: 'coupon' });
  const base = unit * c.months;
  const discount = c.discount_type === 'percent'
    ? Math.round(base * Math.min(100, c.discount_value) / 100)
    : Math.min(base, Math.round(c.discount_value * 100));
  return price(c.months, discount, { id: c.id, code: c.code, label: couponLabel(c) });
}

export function couponLabel(c) {
  const off = c.discount_type === 'percent'
    ? (c.discount_value >= 100 ? 'Free' : `${+c.discount_value}% off`)
    : `₹${+c.discount_value} off`;
  return `${off} · ${c.months} month${c.months === 1 ? '' : 's'}`;
}

/** Record a use; the same payment reference is only counted once. */
export function recordRedemption(userId, ref, q) {
  if (!q.coupon) return;
  stmt(`INSERT OR IGNORE INTO coupon_redemptions (coupon_id, user_id, ref, months, base, discount, total, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(q.coupon.id, userId, ref, q.months, q.base, q.discount, q.total, Date.now());
}
export const redeemedWith = ref => !!stmt('SELECT 1 FROM coupon_redemptions WHERE ref = ?').get(ref);

// ---------------- admin ----------------

const num = (v, name, { min, max, int = false, optional = false } = {}) => {
  if ((v === '' || v == null) && optional) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) {
    throw bad('VALIDATION', `${name} must be ${int ? 'a whole number ' : ''}between ${min} and ${max}.`, { field: name });
  }
  return n;
};
const dayStart = d => (d ? Date.parse(`${d}T00:00:00+05:30`) : null);
const dayEnd = d => (d ? Date.parse(`${d}T23:59:59.999+05:30`) : null);

export function createCoupon(adminId, b) {
  const code = normalizeCode(b.code) || generateCode(b.prefix || 'TL');
  if (!CODE.test(code)) throw bad('VALIDATION', 'Code: 3 to 24 letters, digits, - or _.', { field: 'code' });
  if (stmt('SELECT 1 FROM coupons WHERE code = ?').get(code)) throw bad('VALIDATION', `The code ${code} already exists.`, { field: 'code' });
  const type = b.discountType === 'flat' ? 'flat' : 'percent';
  const months = num(b.months ?? 1, 'Months', { min: 1, max: 24, int: true });
  const value = type === 'percent'
    ? num(b.discountValue, 'Percent off', { min: 1, max: 100 })
    : num(b.discountValue, 'Amount off', { min: 1, max: config.plan.priceInr * months });
  if (b.validFrom && !/^\d{4}-\d{2}-\d{2}$/.test(b.validFrom)) throw bad('VALIDATION', 'Start date is not valid.', { field: 'validFrom' });
  if (b.validUntil && !/^\d{4}-\d{2}-\d{2}$/.test(b.validUntil)) throw bad('VALIDATION', 'End date is not valid.', { field: 'validUntil' });
  const from = dayStart(b.validFrom), until = dayEnd(b.validUntil);
  if (from && until && until < from) throw bad('VALIDATION', 'The end date is before the start date.', { field: 'validUntil' });
  const maxUses = num(b.maxRedemptions, 'Total uses', { min: 1, max: 1_000_000, int: true, optional: true });
  const perUser = num(b.perUserLimit, 'Uses per user', { min: 1, max: 1000, int: true, optional: true });
  const id = stmt(`INSERT INTO coupons (code, note, discount_type, discount_value, months, valid_from, valid_until, max_redemptions, per_user_limit, new_users_only, active, created_by, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
    .run(code, String(b.note || '').slice(0, 200), type, value, months, from, until, maxUses, perUser, b.newUsersOnly ? 1 : 0, adminId, Date.now()).lastInsertRowid;
  return getCoupon(id);
}

function view(c) {
  const now = Date.now();
  const uses = usesOf(c.id);
  const status = !c.active ? 'off'
    : c.valid_until && now > c.valid_until ? 'expired'
    : c.valid_from && now < c.valid_from ? 'scheduled'
    : c.max_redemptions && uses >= c.max_redemptions ? 'used up' : 'live';
  const totals = stmt('SELECT COALESCE(SUM(discount), 0) AS discount, COALESCE(SUM(total), 0) AS revenue FROM coupon_redemptions WHERE coupon_id = ?').get(c.id);
  return {
    id: c.id, code: c.code, note: c.note, label: couponLabel(c),
    discountType: c.discount_type, discountValue: c.discount_value, months: c.months,
    validFrom: c.valid_from, validUntil: c.valid_until, maxRedemptions: c.max_redemptions, perUserLimit: c.per_user_limit,
    newUsersOnly: !!c.new_users_only, active: !!c.active, createdAt: c.created_at,
    uses, status, discountGiven: totals.discount, revenue: totals.revenue,
  };
}

export function getCoupon(id) {
  const c = stmt('SELECT * FROM coupons WHERE id = ?').get(id);
  if (!c) throw notFound('Coupon not found');
  return view(c);
}

export const listCoupons = () => stmt('SELECT * FROM coupons ORDER BY created_at DESC').all().map(view);

export const recentRedemptions = (limit = 50) => stmt(`
  SELECT r.created_at AS at, r.months, r.discount, r.total, c.code, u.email
  FROM coupon_redemptions r JOIN coupons c ON c.id = r.coupon_id JOIN users u ON u.id = r.user_id
  ORDER BY r.created_at DESC LIMIT ?`).all(limit);

export function setCouponActive(id, on) {
  getCoupon(id);
  stmt('UPDATE coupons SET active = ? WHERE id = ?').run(on ? 1 : 0, id);
  return getCoupon(id);
}

/** Unused coupons can be deleted; used ones are switched off instead (their history stays). */
export function deleteCoupon(id) {
  const c = getCoupon(id);
  if (c.uses) { setCouponActive(id, false); return { deleted: false, disabled: true }; }
  stmt('DELETE FROM coupons WHERE id = ?').run(id);
  return { deleted: true };
}

