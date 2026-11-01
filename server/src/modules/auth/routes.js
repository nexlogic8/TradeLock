import { stmt } from '../../db/index.js';
import { HttpError, bad } from '../../lib/errors.js';
import { v } from '../../lib/validate.js';
import { limit } from '../../lib/ratelimit.js';
import { verifyPassword, verifyTotp, newTotpSecret, hashPassword, randomToken, sha256 } from '../../lib/crypto.js';
import { startSession, endSession, endAllSessions } from './session.js';
import { mailEnabled, sendMail } from '../../lib/mailer.js';
import { config } from '../../config.js';

const RESET_TTL = 30 * 60e3;
import { createUser, findUserByEmail, publicUser } from './service.js';
import { audit } from '../audit/service.js';
import { validRefCode } from '../affiliate/service.js';
import { guardDevice } from '../billing/trialguard.js';
import { renderEmail } from '../../lib/emailtpl.js';
import { deleteAccount } from './deletion.js';

export function authRoutes(r) {
  r.post('/api/auth/signup', ctx => {
    limit(`signup:${ctx.ip}`, 10, 3600e3);
    const email = v.email(ctx.body.email);
    const password = v.str(ctx.body.password, 'Password', { min: 8, max: 200 });
    const name = v.str(ctx.body.name || email.split('@')[0], 'Name', { min: 1, max: 80 });
    let refCode = ctx.cookies.tl_ref;
    if (String(ctx.body.ref || '').trim()) {
      refCode = validRefCode(ctx.body.ref);
      if (!refCode) throw bad('INVALID_REFERRAL', 'That referral code was not found. Check it, or leave the box empty.', { field: 'ref' });
    }
    const id = createUser({ email, password, name, refCode });
    audit(id, 'auth.signup', {}, ctx.ip);
    startSession(ctx.res, id);
    guardDevice(ctx, id);
    ctx.status = 201;
    return { user: publicUser(id) };
  }, { public: true });

  r.post('/api/auth/login', ctx => {
    const email = String(ctx.body.email || '').trim().toLowerCase();
    limit(`login:${ctx.ip}:${email}`, 8, 15 * 60e3);
    const u = findUserByEmail(email);
    if (!u || !verifyPassword(String(ctx.body.password || ''), u.password_hash)) {
      throw new HttpError(401, 'BAD_CREDENTIALS', 'Email or password is incorrect. If you signed up with Google, use Continue with Google.');
    }
    if (u.mfa_enabled) {
      if (!ctx.body.code) throw new HttpError(401, 'MFA_REQUIRED', 'Enter the 6-digit code from your authenticator app.');
      if (!verifyTotp(u.mfa_secret, ctx.body.code)) throw new HttpError(401, 'MFA_INVALID', 'That code is not valid. Check your authenticator app and try again.');
    }
    startSession(ctx.res, u.id);
    guardDevice(ctx, u.id);
    audit(u.id, 'auth.login', {}, ctx.ip);
    return { user: publicUser(u.id) };
  }, { public: true });

  // Forgot password: email a single-use link (30 minutes). The reply never says whether the email exists.
  r.post('/api/auth/forgot', async ctx => {
    const email = v.email(ctx.body.email);
    limit(`forgot:${ctx.ip}`, 10, 3600e3);
    limit(`forgot:${email}`, 3, 3600e3);
    if (!mailEnabled()) throw new HttpError(503, 'MAIL_DISABLED', 'Password reset by email is not available yet. Use Continue with Google, or contact support@nexlogic.in.');
    const u = findUserByEmail(email);
    if (u) {
      const token = randomToken(32);
      stmt('INSERT INTO password_resets (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(sha256(token), u.id, Date.now() + RESET_TTL, Date.now());
      const link = `${config.publicUrl}/reset?token=${token}`;
      const first = String(u.name || '').trim().split(/\s+/)[0];
      await sendMail({
        to: email,
        subject: 'Reset your TradeLock password',
        ...renderEmail({
          title: 'Reset your password',
          preheader: 'Use this link within 30 minutes to choose a new TradeLock password.',
          greeting: `Hi ${first || 'there'},`,
          paragraphs: ['We received a request to reset the password for your TradeLock account. Click the button below to choose a new one.'],
          button: { label: 'Reset password', url: link },
          facts: [`Account: ${email}`, 'Link valid for: 30 minutes, one use only', 'After the reset: you are signed out on all devices'],
          note: "Didn't ask for this? You can safely ignore this email: your password stays the same. Never share this link with anyone; TradeLock will never ask you for it.",
        }),
      });
      audit(u.id, 'auth.reset_requested', {}, ctx.ip);
    }
    return { ok: true };
  }, { public: true });

  // Set a new password with a reset link. All existing sessions end.
  r.post('/api/auth/reset', ctx => {
    limit(`reset:${ctx.ip}`, 20, 3600e3);
    const token = String(ctx.body.token || '');
    const password = v.str(ctx.body.password, 'Password', { min: 8, max: 200 });
    const row = token && stmt('SELECT * FROM password_resets WHERE token_hash = ?').get(sha256(token));
    if (!row || row.used_at || row.expires_at < Date.now()) throw bad('RESET_INVALID', 'This reset link has expired or was already used. Ask for a new one.');
    stmt('UPDATE password_resets SET used_at = ? WHERE token_hash = ?').run(Date.now(), row.token_hash);
    stmt('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), row.user_id);
    endAllSessions(row.user_id);
    audit(row.user_id, 'auth.password_reset', {}, ctx.ip);
    return { ok: true };
  }, { public: true });

  // Delete my account (Google Play requirement). Signs out everywhere.
  r.post('/api/account/delete', ctx => {
    limit(`delete:${ctx.user.id}`, 5, 3600e3);
    const res = deleteAccount(ctx.user.id, ctx.body, ctx.ip);
    endSession(ctx.res, ctx.cookies);
    return res;
  });

  r.post('/api/auth/logout', ctx => {
    endSession(ctx.res, ctx.cookies);
    return { ok: true };
  }, { public: true });

  r.get('/api/auth/me', ctx => {
    if (ctx.user) guardDevice(ctx, ctx.user.id);   // also covers sessions that started before this check existed
    return { user: ctx.user ? publicUser(ctx.user.id) : null };
  }, { public: true });

  // MFA: setup returns a secret to add to an authenticator app; enable confirms it with a code.
  r.post('/api/auth/mfa/setup', ctx => {
    if (ctx.user.mfaEnabled) throw bad('MFA_ALREADY_ENABLED', 'Multi-factor authentication is already on.');
    const secret = newTotpSecret();
    stmt('UPDATE users SET mfa_pending = ? WHERE id = ?').run(secret, ctx.user.id);
    const label = encodeURIComponent(`TradeLock:${ctx.user.email}`);
    return { secret, otpauth: `otpauth://totp/${label}?secret=${secret}&issuer=TradeLock` };
  });

  r.post('/api/auth/mfa/enable', ctx => {
    const { mfa_pending: pending } = stmt('SELECT mfa_pending FROM users WHERE id = ?').get(ctx.user.id);
    if (!pending) throw bad('MFA_NOT_STARTED', 'Start MFA setup first.');
    if (!verifyTotp(pending, ctx.body.code)) throw bad('MFA_INVALID', 'That code is not valid. Check the time on your phone and try again.');
    stmt('UPDATE users SET mfa_secret = mfa_pending, mfa_pending = NULL, mfa_enabled = 1 WHERE id = ?').run(ctx.user.id);
    audit(ctx.user.id, 'auth.mfa_enabled', {}, ctx.ip);
    return { user: publicUser(ctx.user.id) };
  });

  r.post('/api/auth/mfa/disable', ctx => {
    const { mfa_secret: secret } = stmt('SELECT mfa_secret FROM users WHERE id = ?').get(ctx.user.id);
    if (!verifyTotp(secret, ctx.body.code)) throw bad('MFA_INVALID', 'Enter a valid code to turn off MFA.');
    stmt('UPDATE users SET mfa_secret = NULL, mfa_enabled = 0 WHERE id = ?').run(ctx.user.id);
    audit(ctx.user.id, 'auth.mfa_disabled', {}, ctx.ip);
    return { user: publicUser(ctx.user.id) };
  });
}
