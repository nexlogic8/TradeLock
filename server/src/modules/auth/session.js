import { stmt } from '../../db/index.js';
import { sha256, randomToken } from '../../lib/crypto.js';
import { setCookie } from '../../lib/http.js';
import { config } from '../../config.js';

export const SESSION_COOKIE = 'tl_sid';

// Only the SHA-256 of the session token is stored, so a DB leak does not leak live sessions.
export function userFromSession(cookies) {
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const u = stmt(`
    SELECT u.id, u.email, u.name, u.timezone, u.currency, u.mfa_enabled, u.prefs
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha256(token), Date.now());
  if (!u) return null;
  return { id: u.id, email: u.email, name: u.name, timezone: u.timezone, currency: u.currency, mfaEnabled: !!u.mfa_enabled, prefs: JSON.parse(u.prefs) };
}

export function startSession(res, userId) {
  const token = randomToken();
  const now = Date.now();
  stmt('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), userId, now + config.sessionTtlMs, now);
  setCookie(res, SESSION_COOKIE, token, { maxAge: config.sessionTtlMs, secure: config.isProd });
}

export function endSession(res, cookies) {
  const token = cookies[SESSION_COOKIE];
  if (token) stmt('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  setCookie(res, SESSION_COOKIE, '', { maxAge: 0, secure: config.isProd });
}

export const endAllSessions = userId => stmt('DELETE FROM sessions WHERE user_id = ?').run(userId);
export const purgeExpiredSessions = () => stmt('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
