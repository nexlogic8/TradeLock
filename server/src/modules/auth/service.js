import { createHash } from 'node:crypto';
import { stmt, tx } from '../../db/index.js';
import { hashPassword } from '../../lib/crypto.js';
import { conflict } from '../../lib/errors.js';
import { ensureRules } from '../rules/service.js';
import { startTrial, getSubscription } from '../billing/service.js';
import { ensureAffiliate, attributeReferral } from '../affiliate/service.js';
import { accountFor, accountSummary } from '../broker/registry.js';

export const DEFAULT_PREFS = { push: true, brokerAlerts: true, emergencyConfirm: true };

export const findUserByEmail = email => stmt('SELECT * FROM users WHERE email = ?').get(email);

// Accounts created through Google get an unusable password hash ('!'); verifyPassword never matches it.
export const createUser = tx(({ email, password, name, refCode, googleSub = null }) => {
  if (findUserByEmail(email)) throw conflict('EMAIL_TAKEN', 'An account with this email already exists. Sign in instead.');
  const { lastInsertRowid } = stmt(
    'INSERT INTO users (email, password_hash, name, prefs, google_sub, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(email, password ? hashPassword(password) : '!', name, JSON.stringify(DEFAULT_PREFS), googleSub, Date.now());
  const id = Number(lastInsertRowid);
  ensureRules(id);
  startTrial(id);
  ensureAffiliate(id);
  if (refCode) attributeReferral(refCode, id);
  return id;
});

/** The user object the web client works with. */
export function publicUser(id) {
  const u = stmt('SELECT id, email, name, phone, timezone, currency, mfa_enabled, prefs, avatar_url FROM users WHERE id = ?').get(id);
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    phone: u.phone,
    initials: u.name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase(),
    // Google photo, else the email's Gravatar (404 when none, and the page falls back to initials).
    avatar: u.avatar_url || `https://www.gravatar.com/avatar/${createHash('sha256').update(u.email.trim().toLowerCase()).digest('hex')}?s=96&d=404`,
    timezone: u.timezone,
    currency: u.currency,
    mfaEnabled: !!u.mfa_enabled,
    prefs: { ...DEFAULT_PREFS, ...JSON.parse(u.prefs) },
    subscription: getSubscription(id),
    broker: accountSummary(accountFor(id)),
  };
}
