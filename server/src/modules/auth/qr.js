// Sign in on the web by scanning a QR code with the signed-in TradeLock phone app (as WhatsApp Web).
//
//   1. The login page asks for a code (POST /api/auth/qr/start). The server keeps it for 2 minutes and gives the
//      browser a private cookie (tl_qrb) that only that browser holds.
//   2. The phone scans the QR (https://<site>/qr/<code>) and tells the server (POST /api/auth/qr/scan); the page
//      then shows "Confirm on your phone", and the phone shows which browser and computer is asking.
//   3. The phone approves (POST /api/auth/qr/approve). The browser's next status check (GET /api/auth/qr/status)
//      carries its cookie and gets the session; a copy of the code alone (someone photographing the screen) is not
//      enough, because the session is only ever handed to the browser that started it.
//
// The phone is already signed in (with its own two-step check), so its approval stands in for the password and code.
import { HttpError, bad } from '../../lib/errors.js';
import { limit } from '../../lib/ratelimit.js';
import { randomToken } from '../../lib/crypto.js';
import { setCookie } from '../../lib/http.js';
import { config } from '../../config.js';
import { startSession } from './session.js';
import { publicUser } from './service.js';
import { audit } from '../audit/service.js';
import { guardDevice } from '../billing/trialguard.js';

export const QR_TTL = 2 * 60e3;
const BROWSER_COOKIE = 'tl_qrb';
const pending = new Map();   // code -> { browserKey, status, userId, createdAt, ua, ip }

const sweep = (now = Date.now()) => { for (const [k, v] of pending) if (now - v.createdAt > QR_TTL) pending.delete(k); };
const live = code => { const e = pending.get(String(code || '')); return e && Date.now() - e.createdAt <= QR_TTL ? e : null; };

/** "Chrome on Windows" from a User-Agent (shown on the phone so you can tell it's your computer). */
export function describeBrowser(ua = '') {
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'A browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) && !/iPhone|iPad/.test(ua) ? 'Mac' : /Android/.test(ua) ? 'Android'
    : /iPhone|iPad/.test(ua) ? 'iPhone' : /Linux/.test(ua) ? 'Linux' : 'a computer';
  return `${browser} on ${os}`;
}

/** The code from what the phone scanned: the full https://…/qr/<code> link, or the bare code. */
export const codeFrom = scanned => String(scanned || '').trim().replace(/^.*\/qr\//, '').replace(/[?#].*$/, '');

export function qrRoutes(r) {
  // The login page: a fresh code to show as a QR (it asks again when this one expires).
  r.post('/api/auth/qr/start', ctx => {
    limit(`qr-start:${ctx.ip}`, 30, 10 * 60e3);
    sweep();
    const code = randomToken(18), browserKey = randomToken(24);
    pending.set(code, { browserKey, status: 'pending', userId: null, createdAt: Date.now(), ua: String(ctx.req.headers['user-agent'] || '').slice(0, 300), ip: ctx.ip });
    setCookie(ctx.res, BROWSER_COOKIE, browserKey, { maxAge: QR_TTL, secure: config.isProd, path: '/api/auth/qr' });
    return { code, url: `${config.publicUrl}/qr/${code}`, expiresIn: QR_TTL };
  }, { public: true });

  // The login page polls: pending → scanned → approved (signs this browser in) | rejected | expired.
  r.get('/api/auth/qr/status', ctx => {
    const e = live(ctx.query.code);
    if (!e) return { status: 'expired' };
    if (!ctx.cookies[BROWSER_COOKIE] || ctx.cookies[BROWSER_COOKIE] !== e.browserKey) throw new HttpError(403, 'QR_NOT_YOURS', 'Start the QR sign-in again on this page.');
    if (e.status !== 'approved') return { status: e.status };
    pending.delete(String(ctx.query.code));
    setCookie(ctx.res, BROWSER_COOKIE, '', { maxAge: 0, secure: config.isProd, path: '/api/auth/qr' });
    startSession(ctx.res, e.userId);
    guardDevice(ctx, e.userId);
    audit(e.userId, 'auth.login_qr', { browser: describeBrowser(e.ua) }, ctx.ip);
    return { status: 'approved', user: publicUser(e.userId) };
  }, { public: true });

  // The phone scanned a code: what is asking to sign in (for the confirm screen).
  r.post('/api/auth/qr/scan', ctx => {
    limit(`qr-scan:${ctx.user.id}`, 30, 10 * 60e3);
    const code = codeFrom(ctx.body.code), e = live(code);
    if (!e) throw bad('QR_EXPIRED', 'This QR code has expired. Refresh the sign-in page and scan the new one.');
    if (e.status !== 'pending' && e.status !== 'scanned') throw bad('QR_USED', 'This QR code was already used. Refresh the sign-in page.');
    e.status = 'scanned';
    return { code, browser: describeBrowser(e.ua), ip: e.ip, startedAt: e.createdAt, expiresAt: e.createdAt + QR_TTL };
  });

  // The phone said yes (or no).
  r.post('/api/auth/qr/approve', ctx => {
    limit(`qr-approve:${ctx.user.id}`, 30, 10 * 60e3);
    const code = codeFrom(ctx.body.code), e = live(code);
    if (!e) throw bad('QR_EXPIRED', 'This QR code has expired. Refresh the sign-in page and scan the new one.');
    if (e.status !== 'scanned') throw bad('QR_USED', 'Scan the QR code again.');
    if (ctx.body.approve === false) { e.status = 'rejected'; return { ok: true, status: 'rejected' }; }
    e.status = 'approved'; e.userId = ctx.user.id;
    return { ok: true, status: 'approved', browser: describeBrowser(e.ua) };
  });

  // Scanned with the phone's camera instead of the app: say where to scan it.
  r.get('/qr/:code', ctx => {
    ctx.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    ctx.res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>TradeLock</title>
<body style="font-family:system-ui,sans-serif;background:#06080c;color:#e8edf2;display:grid;place-items:center;min-height:90vh;margin:0;text-align:center;padding:24px">
<div><h2 style="margin:0 0 10px">Scan this in the TradeLock app</h2><p style="color:#8e98a8;max-width:340px">Open the TradeLock app on your phone and tap the QR button on Home (or Menu → Scan to sign in on web), then scan the code on your computer.</p></div></body>`);
  }, { public: true });
}

/** Tests: forget every pending code. */
export const resetQr = () => pending.clear();
