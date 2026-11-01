import { stmt } from '../../db/index.js';
import { config } from '../../config.js';
import { trialBlockedText } from './trialguard.js';

const DAY = 864e5;

export const startTrial = userId =>
  stmt(`INSERT OR IGNORE INTO subscriptions (user_id, plan, status, trial_ends_at) VALUES (?, 'pro', 'trial', ?)`)
    .run(userId, Date.now() + config.plan.trialDays * DAY);

export function getSubscription(userId) {
  const s = stmt('SELECT * FROM subscriptions WHERE user_id = ?').get(userId);
  if (!s) return null;
  const now = Date.now();
  const active = (s.status === 'active' && (!s.current_period_end || s.current_period_end > now))
    || (s.status === 'trial' && s.trial_ends_at > now);
  return {
    plan: config.plan.name,
    priceInr: config.plan.priceInr,
    gstRate: config.plan.gstRate,
    status: s.status,
    active,
    trialEndsAt: s.trial_ends_at,
    trialDaysLeft: s.status === 'trial' ? Math.max(0, Math.ceil((s.trial_ends_at - now) / DAY)) : null,
    currentPeriodEnd: s.current_period_end,
    cancelAtPeriodEnd: !!s.cancel_at_period_end,
    // Why the free trial ended early (another account already used it on this device / broker account).
    trialBlocked: s.status === 'trial' ? trialBlockedText(s.trial_blocked) : null,
  };
}

/** Called by a payment provider webhook once a payment is captured. */
export function activateSubscription(userId, periodEnd) {
  stmt(`UPDATE subscriptions SET status = 'active', current_period_end = ?, cancel_at_period_end = 0 WHERE user_id = ?`).run(periodEnd, userId);
  stmt(`UPDATE referrals SET status = 'active' WHERE referred_user_id = ?`).run(userId);
}

/** Add a paid month after whatever is left (trial days or the current paid period are kept). */
export function extendSubscription(userId, days = 30) {
  const s = stmt('SELECT * FROM subscriptions WHERE user_id = ?').get(userId);
  const base = Math.max(Date.now(), s?.current_period_end || 0, s?.status === 'trial' ? s.trial_ends_at || 0 : 0);
  const end = base + days * DAY;
  activateSubscription(userId, end);
  return end;
}

export const setCancelAtPeriodEnd = (userId, on) =>
  stmt('UPDATE subscriptions SET cancel_at_period_end = ? WHERE user_id = ?').run(on ? 1 : 0, userId);
