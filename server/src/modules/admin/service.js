// Platform-wide numbers for the admin dashboard (read-only queries).
import { stmt } from '../../db/index.js';
import { config } from '../../config.js';
import { ist } from '../../lib/time.js';
import { getPermissions } from '../broker/book.js';

const DAY = 864e5;

export function businessStats() {
  const now = Date.now();
  const today = ist().day;
  const one = (sql, ...a) => stmt(sql).get(...a);
  const sum = (sql, ...a) => one(sql, ...a).n || 0;
  const sumWhere = where => sum(`SELECT COALESCE(SUM(amount), 0) AS n FROM payments WHERE status = 'paid' AND provider != 'simulated' ${where}`);
  return {
    users: {
      total: sum('SELECT COUNT(*) AS n FROM users'),
      last24h: sum('SELECT COUNT(*) AS n FROM users WHERE created_at > ?', now - DAY),
      last7d: sum('SELECT COUNT(*) AS n FROM users WHERE created_at > ?', now - 7 * DAY),
      google: sum('SELECT COUNT(*) AS n FROM users WHERE google_sub IS NOT NULL'),
      mfa: sum('SELECT COUNT(*) AS n FROM users WHERE mfa_enabled = 1'),
    },
    subscriptions: {
      trialActive: sum(`SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'trial' AND trial_ends_at > ?`, now),
      trialExpired: sum(`SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'trial' AND trial_ends_at <= ?`, now),
      paidActive: sum(`SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'active' AND (current_period_end IS NULL OR current_period_end > ?)`, now),
      cancelling: sum(`SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'active' AND cancel_at_period_end = 1`),
    },
    revenue: {   // paise, real gateway payments only (top-ups + subscription charges)
      last24h: sumWhere(`AND paid_at > ${now - DAY}`),
      last30d: sumWhere(`AND paid_at > ${now - 30 * DAY}`),
      allTime: sumWhere(''),
      subscriptionsPaid30d: sum(`SELECT COUNT(DISTINCT ref) AS n FROM wallet_ledger WHERE type = 'subscription' AND created_at > ?`, now - 30 * DAY),
    },
    wallet: {    // what TradeLock owes users (paise)
      funds: sum(`SELECT COALESCE(SUM(amount), 0) AS n FROM wallet_ledger WHERE bucket = 'funds'`),
      earnings: sum(`SELECT COALESCE(SUM(amount), 0) AS n FROM wallet_ledger WHERE bucket = 'earnings'`),
      pendingWithdrawals: sum(`SELECT COUNT(*) AS n FROM withdrawals WHERE status = 'requested'`),
      pendingAmount: sum(`SELECT COALESCE(SUM(amount), 0) AS n FROM withdrawals WHERE status = 'requested'`),
      oldestPendingAt: one(`SELECT MIN(created_at) AS n FROM withdrawals WHERE status = 'requested'`).n,
    },
    affiliate: {
      referrals: sum('SELECT COUNT(*) AS n FROM referrals WHERE referred_user_id IS NOT NULL'),
      activeReferrals: sum(`SELECT COUNT(*) AS n FROM referrals WHERE referred_user_id IS NOT NULL AND status = 'active'`),
      commissions30d: sum(`SELECT COALESCE(SUM(amount), 0) AS n FROM wallet_ledger WHERE type = 'commission' AND created_at > ?`, now - 30 * DAY),
    },
    trading: {
      brokersConnected: sum(`SELECT COUNT(*) AS n FROM broker_accounts WHERE status != 'disconnected'`),
      agentsRunning: sum(`SELECT COUNT(*) AS n FROM broker_accounts WHERE status != 'disconnected' AND agent_on = 1`),
      agentsStopped: sum(`SELECT COUNT(*) AS n FROM broker_accounts WHERE status != 'disconnected' AND agent_on = 0`),
      unhealthy: sum(`SELECT COUNT(*) AS n FROM broker_accounts WHERE status IN ('delayed', 'degraded', 'expired') AND agent_on = 1`),
      breachesToday: sum('SELECT COALESCE(SUM(breaches), 0) AS n FROM day_state WHERE day = ?', today),
      killSwitchesToday: sum('SELECT COUNT(*) AS n FROM day_state WHERE day = ? AND ks_active_at IS NOT NULL', today),
      emergenciesToday: sum('SELECT COUNT(*) AS n FROM emergency_actions WHERE created_at > ?', Date.parse(`${today}T00:00:00+05:30`)),
      blockedOrdersToday: sum('SELECT COALESCE(SUM(blocked), 0) AS n FROM day_state WHERE day = ?', today),
    },
  };
}

export function brokerHealth() {
  return stmt(`SELECT b.id, b.user_id, b.broker, b.status, b.agent_on, b.last_sync_at, b.last_error, b.token_expires_at, u.email
               FROM broker_accounts b JOIN users u ON u.id = b.user_id WHERE b.status != 'disconnected' ORDER BY b.last_sync_at DESC`).all()
    .map(r => ({
      email: r.email, broker: r.broker, status: r.status, agentOn: !!r.agent_on, lastSyncAt: r.last_sync_at, lastError: r.last_error,
      tokenExpiresAt: r.token_expires_at, ordersAllowed: getPermissions(r.user_id)?.ordersAllowed ?? null,
    }));
}

const like = q => `%${String(q || '').trim().toLowerCase()}%`;

export const listUsers = (q = '', limit = 200) =>
  stmt(`SELECT u.id, u.email, u.name, u.phone, u.created_at AS createdAt, u.google_sub IS NOT NULL AS google, u.mfa_enabled AS mfa,
          s.status AS sub, s.trial_ends_at AS trialEndsAt, s.current_period_end AS periodEnd,
          (SELECT broker || ':' || status FROM broker_accounts b WHERE b.user_id = u.id AND b.status != 'disconnected' LIMIT 1) AS broker,
          (SELECT COALESCE(SUM(amount), 0) FROM wallet_ledger w WHERE w.user_id = u.id) AS wallet,
          (SELECT MAX(created_at) FROM sessions x WHERE x.user_id = u.id) AS lastLoginAt,
          (SELECT a.email FROM referrals r JOIN users a ON a.id = r.affiliate_user_id WHERE r.referred_user_id = u.id LIMIT 1) AS referredBy
        FROM users u LEFT JOIN subscriptions s ON s.user_id = u.id
        WHERE lower(u.email) LIKE ? OR lower(u.name) LIKE ? OR COALESCE(u.phone, '') LIKE ?
        ORDER BY u.created_at DESC LIMIT ?`).all(like(q), like(q), like(q), limit);

export const listPayments = (limit = 200) =>
  stmt(`SELECT p.id, p.provider, p.provider_order_id AS orderId, p.provider_payment_id AS paymentId, p.amount, p.status, p.purpose,
          p.created_at AS createdAt, p.paid_at AS paidAt, u.email
        FROM payments p JOIN users u ON u.id = p.user_id ORDER BY p.id DESC LIMIT ?`).all(limit);

export const listSubscriptions = () =>
  stmt(`SELECT u.email, u.name, s.plan, s.status, s.trial_ends_at AS trialEndsAt, s.current_period_end AS periodEnd, s.cancel_at_period_end AS cancelling
        FROM subscriptions s JOIN users u ON u.id = s.user_id
        ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'trial' THEN 1 ELSE 2 END, COALESCE(s.current_period_end, s.trial_ends_at) DESC LIMIT 300`).all();

export const processedWithdrawals = (limit = 50) =>
  stmt(`SELECT w.id, w.amount, w.method, w.destination, w.status, w.note, w.created_at AS createdAt, w.processed_at AS processedAt, u.email, a.email AS processedBy
        FROM withdrawals w JOIN users u ON u.id = w.user_id LEFT JOIN users a ON a.id = w.processed_by
        WHERE w.status != 'requested' ORDER BY w.processed_at DESC LIMIT ?`).all(limit);

export const listAffiliates = () =>
  stmt(`SELECT u.email, u.name, a.code, a.clicks,
          (SELECT COUNT(*) FROM referrals r WHERE r.affiliate_user_id = a.user_id AND r.referred_user_id IS NOT NULL) AS signups,
          (SELECT COUNT(*) FROM referrals r WHERE r.affiliate_user_id = a.user_id AND r.status = 'active') AS paying,
          (SELECT COALESCE(SUM(amount), 0) FROM wallet_ledger w WHERE w.user_id = a.user_id AND w.type = 'commission') AS earned,
          (SELECT COALESCE(SUM(amount), 0) FROM wallet_ledger w WHERE w.user_id = a.user_id AND w.bucket = 'earnings') AS balance
        FROM affiliates a JOIN users u ON u.id = a.user_id
        ORDER BY signups DESC, a.clicks DESC LIMIT 300`).all();

export const listAudit = (q = '', limit = 200) =>
  stmt(`SELECT a.action, a.detail, a.ip, a.created_at AS createdAt, u.email
        FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
        WHERE lower(a.action) LIKE ? OR lower(COALESCE(u.email, '')) LIKE ? OR COALESCE(a.ip, '') LIKE ?
        ORDER BY a.id DESC LIMIT ?`).all(like(q), like(q), like(q), limit)
    .map(r => ({ ...r, detail: r.detail.length > 240 ? `${r.detail.slice(0, 240)}…` : r.detail }));

export const adminIds = () => config.adminEmails.length
  ? stmt(`SELECT id FROM users WHERE lower(email) IN (${config.adminEmails.map(() => '?').join(',')})`).all(...config.adminEmails).map(r => r.id)
  : [];
