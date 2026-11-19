// StoxKart (Superr API), stage 1: link the account and test it. The credentials are stored encrypted in their
// own table (broker_links), apart from broker_accounts, so linking StoxKart never changes the active broker:
// Dhan keeps running monitoring, the option chain and Algo Trading.
//
// Login (from StoxKart's official SDK, superrapi-dotnet):
//   1. POST /auth/login?api-key=KEY        { platform: 'api', data: { client_id, password } }      → data.token
//   2. POST /auth/twofa/verify?api-key=KEY { platform: 'api', data: { client_id, token, action: 'api-key-validation', otp } }
//                                                                                                   → data.request_token
//      otp: the TOTP code, generated here from the user's TOTP secret (so the daily login needs nobody)
//   3. POST /auth/token { api_key, signature, req_token }, signature = hex(HMAC-SHA256(key: api_key + req_token, msg: api_secret))
//                                                                                                   → data.access_token
// Then every call sends X-Access-Token, X-Client-Id, X-Platform: api and X-Api-Key. Base: https://openapi.stoxkart.com
// The API also checks the key pair in headers ("Invalid X-API-Key or X-API-Secret" from /auth/login), so every call
// carries X-API-Key and X-API-Secret as well (over TLS, to StoxKart only).
// Orders also need the exchange algo ID (SEBI retail algo rules) in an X-Algo-Id header, else StoxKart answers
// 401 "algo id is required". Non-registered apps (strategy NSE-BSE_NON_REGISTERED) use 99999.
import { createHmac } from 'node:crypto';
import { stmt } from '../../db/index.js';
import { decrypt, encrypt, totp } from '../../lib/crypto.js';
import { bad, forbidden } from '../../lib/errors.js';
import { isAdminEmail } from '../../lib/access.js';
import { v } from '../../lib/validate.js';
import { limit } from '../../lib/ratelimit.js';
import { request } from '../../lib/httpclient.js';
import { audit } from '../audit/service.js';

export const STOXKART_BASE = 'https://openapi.stoxkart.com';
const num = x => { const n = Number(String(x ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
const mask = s => (s.length > 4 ? `•••• ${s.slice(-4)}` : s);
export const DEFAULT_ALGO_ID = '99999';
const cleanSecret = s => String(s || '').replace(/[\s-]/g, '').toUpperCase();

/** A StoxKart API client for one user. `transport(method, url, { headers, body, timeoutMs })` → { status, text }. */
export function createStoxkartClient({ clientId, password, apiKey, apiSecret, totpSecret, transport = request }) {
  async function call(method, path, body, headers = {}) {
    let res;
    try {
      res = await transport(method, STOXKART_BASE + path, { headers: { Accept: 'application/json', ...(body !== undefined && { 'Content-Type': 'application/json' }), ...headers }, body, timeoutMs: 10_000 });
    } catch (e) { throw Object.assign(new Error(e.code === 'TIMEOUT' ? 'StoxKart did not respond within 10 seconds' : 'Could not reach StoxKart'), { code: 'NETWORK' }); }
    let data = null;
    try { data = res.text ? JSON.parse(res.text) : null; } catch { /* non-JSON error page */ }
    if (res.status < 200 || res.status >= 300 || (data && data.status && data.status !== 'success'))
      throw Object.assign(new Error(data?.message || data?.error || `StoxKart returned HTTP ${res.status}`), { code: 'BROKER', step: path.split('?')[0] });
    return data || {};
  }
  const q = `?api-key=${encodeURIComponent(apiKey)}`, keys = { 'X-API-Key': apiKey, 'X-API-Secret': apiSecret, 'X-Platform': 'api' };
  return {
    /** The three-step login; returns the access token. */
    async login({ now = Date.now() } = {}) {
      const a = await call('POST', `/auth/login${q}`, { platform: 'api', data: { client_id: clientId, password } }, keys);
      const token = a.data?.token || a.data?.request_token;
      if (!token) throw Object.assign(new Error('StoxKart login returned no token'), { code: 'BROKER', step: '/auth/login' });
      const b = await call('POST', `/auth/twofa/verify${q}`, { platform: 'api', data: { client_id: clientId, token, action: 'api-key-validation', otp: totp(totpSecret, now) } }, keys);
      const reqToken = b.data?.request_token || b.data?.token;
      if (!reqToken) throw Object.assign(new Error('StoxKart 2FA returned no request token'), { code: 'BROKER', step: '/auth/twofa/verify' });
      const signature = createHmac('sha256', apiKey + reqToken).update(apiSecret).digest('hex');
      const c = await call('POST', '/auth/token', { api_key: apiKey, signature, req_token: reqToken }, keys);
      const accessToken = c.data?.access_token;
      if (!accessToken) throw Object.assign(new Error('StoxKart returned no access token'), { code: 'BROKER', step: '/auth/token' });
      return accessToken;
    },
    /** GET /funds with a session: { available, cash, net, used, realised, collateral }. */
    async funds(accessToken) {
      const r = await call('GET', '/funds', undefined, { ...keys, 'X-Access-Token': accessToken, 'X-Client-Id': clientId });
      const d = r.data || {};
      return { available: num(d.available_limit), cash: num(d.cash), net: num(d.net), used: num(d.utilized_limit), realised: num(d.realised_profit), collateral: num(d.collateral) };
    },
  };
}

// ---- link storage (one row per user and broker; secrets only ever encrypted) ----
const row = userId => stmt(`SELECT * FROM broker_links WHERE user_id = ? AND broker = 'stoxkart'`).get(userId);

/** What the page may see: never a secret. */
export function stoxkartLink(userId) {
  const r = row(userId);
  if (!r) return { linked: false };
  const via = stmt(`SELECT trade_via FROM broker_accounts WHERE user_id = ? AND status != 'disconnected' ORDER BY created_at DESC LIMIT 1`).get(userId)?.trade_via;
  return { linked: true, clientId: mask(r.client_id), status: r.status, lastError: r.last_error, verifiedAt: r.verified_at, updatedAt: r.updated_at,
    funds: r.funds_json ? JSON.parse(r.funds_json) : null, trading: via === 'stoxkart', algoId: JSON.parse(decrypt(r.creds_enc)).algoId || DEFAULT_ALGO_ID };
}

/** Save (or update) the credentials. Blank fields on an update keep the stored value. */
export function saveStoxkartLink(userId, body = {}, ip) {
  const old = row(userId), prev = old ? JSON.parse(decrypt(old.creds_enc)) : {};
  const pick = (key, label, opts) => { const x = body[key]; return x === undefined || x === '' ? (prev[key] ?? v.str(x, label, opts)) : v.str(x, label, opts); };
  const creds = {
    clientId: pick('clientId', 'StoxKart client ID', { min: 3, max: 40 }).trim().toUpperCase(),
    // The password exactly as typed (no trimming).
    password: typeof body.password === 'string' && body.password.length ? (body.password.length <= 200 ? body.password : v.str('', 'StoxKart password', { min: 1, max: 200 })) : (prev.password ?? v.str(body.password, 'StoxKart password', { min: 1, max: 200 })),
    apiKey: pick('apiKey', 'API key', { min: 4, max: 200 }).trim(),
    apiSecret: pick('apiSecret', 'API secret', { min: 4, max: 400 }).trim(),
    totpSecret: cleanSecret(pick('totpSecret', 'TOTP secret (setup key)', { min: 1, max: 200 })),
    // The algo ID shown under the app's strategy on developers.stoxkart.com; blank keeps the saved one (else 99999).
    algoId: String(body.algoId ?? '').trim() || prev.algoId || DEFAULT_ALGO_ID,
  };
  if (!/^\d{1,20}$/.test(creds.algoId)) throw bad('VALIDATION', 'Algo ID: digits only, as shown under the strategy of your Superr API app (99999 for NSE-BSE_NON_REGISTERED).');
  // The setup key (base32), not the 6-digit code an authenticator app shows from it.
  if (/^\d{6,8}$/.test(creds.totpSecret)) throw bad('VALIDATION', 'TOTP secret: that looks like the 6-digit code from your authenticator app, which changes every 30 seconds. Enter the setup key instead: the code of letters and digits shown (or inside the QR code) when you enabled TOTP on developers.stoxkart.com.');
  if (creds.totpSecret.length < 8 || !/^[A-Z2-7]+=*$/.test(creds.totpSecret)) throw bad('VALIDATION', 'TOTP secret: enter the setup key shown when you enabled TOTP on developers.stoxkart.com (letters A–Z and digits 2–7, usually 16 or 32 characters).');
  const now = Date.now();
  stmt(`INSERT INTO broker_links (user_id, broker, client_id, creds_enc, status, last_error, verified_at, funds_json, created_at, updated_at)
    VALUES (?, 'stoxkart', ?, ?, 'linked', NULL, NULL, NULL, ?, ?)
    ON CONFLICT (user_id, broker) DO UPDATE SET client_id = excluded.client_id, creds_enc = excluded.creds_enc, status = 'linked', last_error = NULL,
      verified_at = NULL, funds_json = NULL, updated_at = excluded.updated_at`).run(userId, creds.clientId, encrypt(JSON.stringify(creds)), now, now);
  audit(userId, 'broker.link_saved', { broker: 'stoxkart', clientId: mask(creds.clientId) }, ip);
  return stoxkartLink(userId);
}

/** Log in with the stored credentials and read the funds; records the result. */
export async function testStoxkartLink(userId, ip, { transport } = {}) {
  const r = row(userId);
  if (!r) throw bad('NOT_LINKED', 'Save your StoxKart details first.');
  // Each test is a real login: a few wrong passwords in a row can lock the StoxKart account.
  limit(`stoxkart-test:${userId}`, 5, 10 * 60e3);
  const creds = JSON.parse(decrypt(r.creds_enc)), client = createStoxkartClient({ ...creds, ...(transport && { transport }) });
  try {
    const token = await client.login();
    const funds = await client.funds(token);
    stmt(`UPDATE broker_links SET status = 'verified', last_error = NULL, verified_at = ?, funds_json = ?, updated_at = ? WHERE user_id = ? AND broker = 'stoxkart'`)
      .run(Date.now(), JSON.stringify(funds), Date.now(), userId);
    audit(userId, 'broker.link_tested', { broker: 'stoxkart', ok: true }, ip);
  } catch (e) {
    const why = `${e.step ? `${e.step}: ` : ''}${e.message}`.slice(0, 300);
    stmt(`UPDATE broker_links SET status = 'failed', last_error = ?, updated_at = ? WHERE user_id = ? AND broker = 'stoxkart'`).run(why, Date.now(), userId);
    audit(userId, 'broker.link_tested', { broker: 'stoxkart', ok: false, error: why }, ip);
  }
  return stoxkartLink(userId);
}

export function removeStoxkartLink(userId, ip) {
  if (stmt(`SELECT 1 FROM broker_accounts WHERE user_id = ? AND trade_via = 'stoxkart'`).get(userId)) throw bad('STOXKART_TRADING', 'Switch trading back to Dhan first (the "Trade through StoxKart" switch).');
  stmt(`DELETE FROM broker_links WHERE user_id = ? AND broker = 'stoxkart'`).run(userId);
  audit(userId, 'broker.link_removed', { broker: 'stoxkart' }, ip);
  return { linked: false };
}

/** StoxKart is in beta: administrators only (ADMIN_EMAILS). Everyone else sees it as coming soon. */
export const stoxkartAllowed = user => isAdminEmail(user?.email);
export function requireStoxkart(user) {
  if (!stoxkartAllowed(user)) throw forbidden('STOXKART_BETA', 'StoxKart is in beta and not available on your account yet.');
}

export function stoxkartRoutes(r) {
  r.get('/api/brokers/links/stoxkart', ctx => { requireStoxkart(ctx.user); return stoxkartLink(ctx.user.id); });
  r.put('/api/brokers/links/stoxkart', ctx => { requireStoxkart(ctx.user); limit(`stoxkart-save:${ctx.user.id}`, 10, 10 * 60e3); return saveStoxkartLink(ctx.user.id, ctx.body, ctx.ip); });
  r.post('/api/brokers/links/stoxkart/test', ctx => { requireStoxkart(ctx.user); return testStoxkartLink(ctx.user.id, ctx.ip); });
  r.delete('/api/brokers/links/stoxkart', ctx => { requireStoxkart(ctx.user); return removeStoxkartLink(ctx.user.id, ctx.ip); });
  // The redirect and postback URLs registered in the StoxKart app. Stage 1 logs in with TOTP on the server, so
  // nothing is read from them yet: the redirect returns to Broker accounts, postbacks are acknowledged.
  r.get('/api/brokers/stoxkart/callback', ctx => {
    ctx.res.writeHead(302, { Location: '/brokers?stoxkart=back', 'Cache-Control': 'no-store' });
    ctx.res.end();
  }, { public: true });
  r.post('/api/brokers/stoxkart/postback', () => ({ ok: true }), { public: true });
}
