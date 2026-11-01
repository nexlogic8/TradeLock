// "Continue with Google": OAuth 2.0 authorization-code flow with PKCE, no SDK.
// The ID token comes straight from Google's token endpoint over TLS, which OpenID Connect
// accepts in place of signature verification; issuer, audience and expiry are still checked.
import { createHash } from 'node:crypto';
import { stmt } from '../../db/index.js';
import { config } from '../../config.js';
import { HttpError, bad } from '../../lib/errors.js';
import { setCookie } from '../../lib/http.js';
import { limit } from '../../lib/ratelimit.js';
import { randomToken, verifyTotp } from '../../lib/crypto.js';
import { startSession, endAllSessions } from './session.js';
import { createUser, findUserByEmail, publicUser } from './service.js';
import { accountFor } from '../broker/registry.js';
import { audit } from '../audit/service.js';
import { guardDevice } from '../billing/trialguard.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const STATE_COOKIE = 'tl_oauth';
const MFA_COOKIE = 'tl_mfa';
const MFA_TTL = 5 * 60e3;

// Users with MFA on finish Google sign-in by entering a code; this holds them for 5 minutes.
const pendingMfa = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of pendingMfa) if (v.exp < now) pendingMfa.delete(k); }, 60e3).unref();

export const googleEnabled = () => Boolean(config.google.clientId && config.google.clientSecret);
const redirectUri = () => `${config.publicUrl}/api/auth/google/callback`;

function redirect(ctx, location) {
  ctx.res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  ctx.res.end();
}

async function exchangeCode(code, verifier) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, code_verifier: verifier, grant_type: 'authorization_code',
      client_id: config.google.clientId, client_secret: config.google.clientSecret, redirect_uri: redirectUri(),
    }),
    signal: AbortSignal.timeout(8000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id_token) throw new Error(`token exchange failed: ${data.error || res.status}`);
  const claims = JSON.parse(Buffer.from(data.id_token.split('.')[1], 'base64url').toString('utf8'));
  if (!ISSUERS.has(claims.iss) || claims.aud !== config.google.clientId || claims.exp * 1000 < Date.now()) {
    throw new Error('id_token claims rejected');
  }
  return claims;
}

/** Existing Google link → that user; same verified email → link it; otherwise a new account. */
/** Keep the user's Google photo up to date (only googleusercontent.com images are stored). */
function savePhoto(userId, claims) {
  const pic = typeof claims.picture === 'string' && /^https:\/\/[a-z0-9.-]+\.googleusercontent\.com\//.test(claims.picture) ? claims.picture : null;
  if (pic) stmt('UPDATE users SET avatar_url = ? WHERE id = ?').run(pic.slice(0, 500), userId);
}

export function findOrCreateGoogleUser(claims, refCode) {
  const r = findOrCreate(claims, refCode);
  savePhoto(r.id, claims);
  return r;
}

function findOrCreate(claims, refCode) {
  const linked = stmt('SELECT id FROM users WHERE google_sub = ?').get(claims.sub);
  if (linked) return { id: linked.id, created: false };
  const email = String(claims.email).toLowerCase();
  const existing = findUserByEmail(email);
  if (existing) {
    // Password signups never proved they own the email; Google just did. Revoke the old password
    // and sessions so whoever registered it first cannot keep access (pre-account takeover).
    stmt(`UPDATE users SET google_sub = ?, password_hash = '!' WHERE id = ?`).run(claims.sub, existing.id);
    endAllSessions(existing.id);
    audit(existing.id, 'auth.google_linked', { passwordRevoked: true });
    return { id: existing.id, created: false };
  }
  const name = String(claims.name || email.split('@')[0]).slice(0, 80);
  return { id: createUser({ email, password: null, name, refCode, googleSub: claims.sub }), created: true };
}

export function googleRoutes(r) {
  r.get('/api/auth/google', ctx => {
    if (!googleEnabled()) return redirect(ctx, '/login?auth_error=google_disabled');
    limit(`google:${ctx.ip}`, 20, 10 * 60e3);
    const state = randomToken(24);
    const verifier = randomToken(48);
    // ?next=admin: sign-in started from the admin console (/admin), which is only for ADMIN_EMAILS.
    const next = ctx.query.next === 'admin' ? 'admin' : '';
    setCookie(ctx.res, STATE_COOKIE, `${state}.${verifier}.${next}`, { maxAge: 10 * 60e3, secure: config.isProd, path: '/api/auth/google' });
    const q = new URLSearchParams({
      client_id: config.google.clientId,
      redirect_uri: redirectUri(),
      response_type: 'code',
      scope: 'openid email profile',
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    redirect(ctx, `${AUTH_URL}?${q}`);
  }, { public: true });

  r.get('/api/auth/google/callback', async ctx => {
    const [state, verifier, next] = String(ctx.cookies[STATE_COOKIE] || '').split('.');
    const admin = next === 'admin';
    const fail = code => redirect(ctx, admin ? `/admin?auth_error=${code}` : `/login?auth_error=${code}`);
    setCookie(ctx.res, STATE_COOKIE, '', { maxAge: 0, secure: config.isProd, path: '/api/auth/google' });
    if (ctx.query.error) return fail('google_cancelled');
    if (!state || !verifier || !ctx.query.code || ctx.query.state !== state) return fail('google_state');

    let claims;
    try { claims = await exchangeCode(ctx.query.code, verifier); }
    catch (e) { console.error('[google]', e.message); return fail('google_failed'); }
    if (!claims.email || claims.email_verified !== true) return fail('google_unverified');
    // The admin console never creates accounts: anyone not on the admin list is turned away.
    if (admin && !config.adminEmails.includes(claims.email.toLowerCase())) {
      audit(null, 'admin.login_denied', { email: claims.email }, ctx.ip);
      return fail('not_admin');
    }

    const { id, created } = findOrCreateGoogleUser(claims, ctx.cookies.tl_ref);
    const user = stmt('SELECT mfa_enabled FROM users WHERE id = ?').get(id);
    if (user.mfa_enabled) {
      const ticket = randomToken();
      pendingMfa.set(ticket, { userId: id, exp: Date.now() + MFA_TTL });
      setCookie(ctx.res, MFA_COOKIE, ticket, { maxAge: MFA_TTL, secure: config.isProd, path: '/api/auth' });
      return redirect(ctx, admin ? '/admin?mfa=1' : '/mfa');
    }
    startSession(ctx.res, id);
    guardDevice(ctx, id);
    audit(id, created ? 'auth.signup_google' : 'auth.login_google', {}, ctx.ip);
    if (admin) audit(id, 'admin.login', {}, ctx.ip);
    redirect(ctx, admin ? '/admin' : accountFor(id) ? '/overview' : '/connect');
  }, { public: true });

  // Android app: native Google account picker (Credential Manager) returns an ID token issued for
  // our web client ID. Google verifies it (signature, expiry); we check issuer, audience and email.
  r.post('/api/auth/google/idtoken', async ctx => {
    if (!googleEnabled()) throw bad('GOOGLE_DISABLED', 'Google sign-in is not available right now.');
    limit(`google-id:${ctx.ip}`, 20, 10 * 60e3);
    const token = String(ctx.body.idToken || '');
    if (token.length < 100 || token.length > 4096) throw bad('VALIDATION', 'Missing Google sign-in token.');
    let claims;
    try {
      const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(8000) });
      claims = res.ok ? await res.json() : null;
    } catch { claims = null; }
    const audiences = [config.google.clientId, ...config.google.appClientIds];
    if (!claims || !ISSUERS.has(claims.iss) || !audiences.includes(claims.aud) || Number(claims.exp) * 1000 < Date.now()) {
      throw new HttpError(401, 'GOOGLE_TOKEN', 'Google sign-in could not be verified. Please try again.');
    }
    if (!claims.email || String(claims.email_verified) !== 'true') throw bad('GOOGLE_UNVERIFIED', 'Your Google email address is not verified.');
    const { id, created } = findOrCreateGoogleUser(claims, ctx.cookies.tl_ref);
    const user = stmt('SELECT mfa_enabled FROM users WHERE id = ?').get(id);
    if (user.mfa_enabled) {
      const ticket = randomToken();
      pendingMfa.set(ticket, { userId: id, exp: Date.now() + MFA_TTL });
      setCookie(ctx.res, MFA_COOKIE, ticket, { maxAge: MFA_TTL, secure: config.isProd, path: '/api/auth' });
      return { mfa: true };
    }
    startSession(ctx.res, id);
    guardDevice(ctx, id);
    audit(id, created ? 'auth.signup_google' : 'auth.login_google', { via: 'android' }, ctx.ip);
    return { user: publicUser(id) };
  }, { public: true });

  r.post('/api/auth/mfa/complete', ctx => {
    const ticket = ctx.cookies[MFA_COOKIE];
    const pending = ticket && pendingMfa.get(ticket);
    if (!pending || pending.exp < Date.now()) throw new HttpError(401, 'MFA_EXPIRED', 'This sign-in has expired. Continue with Google again.');
    limit(`mfa:${pending.userId}`, 6, 5 * 60e3);
    const { mfa_secret: secret } = stmt('SELECT mfa_secret FROM users WHERE id = ?').get(pending.userId);
    if (!verifyTotp(secret, ctx.body.code)) throw bad('MFA_INVALID', 'That code is not valid. Check your authenticator app and try again.');
    pendingMfa.delete(ticket);
    setCookie(ctx.res, MFA_COOKIE, '', { maxAge: 0, secure: config.isProd, path: '/api/auth' });
    startSession(ctx.res, pending.userId);
    guardDevice(ctx, pending.userId);
    audit(pending.userId, 'auth.login_google', { mfa: true }, ctx.ip);
    return { user: publicUser(pending.userId) };
  }, { public: true });
}
