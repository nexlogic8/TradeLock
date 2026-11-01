import { randomBytes } from 'node:crypto';
import { stmt } from '../../db/index.js';
import { config } from '../../config.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from(randomBytes(8), b => ALPHABET[b % ALPHABET.length]).join('');

export function ensureAffiliate(userId, code = newCode()) {
  stmt('INSERT OR IGNORE INTO affiliates (user_id, code) VALUES (?, ?)').run(userId, code);
}

export function trackClick(code) {
  return stmt('UPDATE affiliates SET clicks = clicks + 1 WHERE code = ?').run(String(code).toUpperCase()).changes > 0;
}

export function attributeReferral(code, referredUserId) {
  const a = stmt('SELECT user_id FROM affiliates WHERE code = ?').get(String(code).toUpperCase());
  if (!a || a.user_id === referredUserId) return;
  stmt(`INSERT INTO referrals (affiliate_user_id, referred_user_id, status, created_at) VALUES (?, ?, 'trial', ?)`)
    .run(a.user_id, referredUserId, Date.now());
}

const shortName = name => {
  const [first, ...rest] = String(name || 'Trader').trim().split(/\s+/);
  return rest.length ? `${first} ${rest.at(-1)[0].toUpperCase()}.` : first;
};

export function affiliateStats(userId) {
  ensureAffiliate(userId);
  const a = stmt('SELECT code, clicks FROM affiliates WHERE user_id = ?').get(userId);
  const active = stmt(`SELECT COUNT(*) AS n FROM referrals WHERE affiliate_user_id = ? AND status = 'active'`).get(userId).n;
  const trials = stmt(`SELECT COUNT(*) AS n FROM referrals WHERE affiliate_user_id = ? AND status = 'trial'`).get(userId).n;
  return {
    code: a.code,
    link: `${config.publicUrl}/r/${a.code}`,
    clicks: a.clicks,
    activeSubscribers: active,
    trials,
    rate: config.affiliateRate,
    // Plan price excluding GST, which is not commissionable.
    estimatedCommission: Math.floor(active * config.plan.priceInr * config.affiliateRate),
    payouts: stmt('SELECT period, amount, status, paid_at AS paidAt FROM payouts WHERE user_id = ? ORDER BY period DESC LIMIT 24').all(userId),
    // Commissions are credited to the wallet (paise) the moment a referred trader pays.
    walletCredited: stmt(`SELECT COALESCE(SUM(amount), 0) AS n FROM wallet_ledger WHERE user_id = ? AND type = 'commission'`).get(userId).n,
    recentCommissions: stmt(`SELECT amount, note, created_at AS createdAt FROM wallet_ledger WHERE user_id = ? AND type = 'commission' ORDER BY id DESC LIMIT 10`).all(userId),
    commissionPerPayment: Math.round(config.plan.priceInr * config.affiliateRate * 100),   // paise
    // Who signed up through the link. Names are shortened ("Rahul S.") for the referred traders' privacy.
    referrals: stmt(`SELECT u.name, r.status, r.created_at AS joinedAt FROM referrals r JOIN users u ON u.id = r.referred_user_id
                     WHERE r.affiliate_user_id = ? ORDER BY r.id DESC LIMIT 50`).all(userId)
      .map(r => ({ name: shortName(r.name), status: r.status, joinedAt: r.joinedAt })),
  };
}

/** Normalised referral code if it belongs to an affiliate, else null. */
export function validRefCode(code) {
  const c = String(code || '').trim().toUpperCase().slice(0, 32);
  if (!/^[A-Z0-9_-]{3,32}$/.test(c)) return null;
  return stmt('SELECT 1 FROM affiliates WHERE code = ?').get(c) ? c : null;
}
