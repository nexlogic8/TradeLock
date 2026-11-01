import { config } from '../config.js';
import { HttpError } from './errors.js';
import { readJson, readRaw, parseCookies, sendJson } from './http.js';
import { serveStatic } from './static.js';
import { assets } from './assets.js';
import { recordRequest } from './metrics.js';
import { userFromSession } from '../modules/auth/session.js';

const cspFor = importMapHash => [
  "default-src 'self'",
  // Razorpay Checkout (wallet top-ups): its script, fraud-detection bundle, payment frame and telemetry
  // are all served from razorpay.com subdomains. The app shell's inline import map is allowed by its hash only.
  `script-src 'self' ${importMapHash} https://checkout.razorpay.com https://*.razorpay.com`,
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: https://*.razorpay.com https://*.googleusercontent.com https://www.gravatar.com",
  `connect-src 'self' wss://${new URL(config.publicUrl).host}${config.isProd ? '' : ` ws://${new URL(config.publicUrl).host}`} https://*.razorpay.com`,
  "frame-src https://*.razorpay.com",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');
let csp = null, cspKey = null;
const CSP = () => { const h = assets().importMapHash; if (h !== cspKey) { cspKey = h; csp = cspFor(h); } return csp; };

function securityHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP());
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (config.isProd) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

// Cookies are SameSite=Lax; this blocks cross-site POSTs that still carry an Origin header.
function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let host = null;
  try { host = new URL(origin).host; } catch { /* invalid origin */ }
  if (host !== req.headers.host) throw new HttpError(403, 'BAD_ORIGIN', 'Cross-site request blocked');
}

const clientIp = req =>
  (config.trustProxy && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress;

export function createHandler(router) {
  return async (req, res) => {
    securityHeaders(res);
    const url = new URL(req.url, 'http://localhost');
    try {
      if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/r/')) {
        return await serveStatic(req, res, url);
      }
      res.on('finish', () => recordRequest(res.statusCode));
      const route = router.match(req.method, url.pathname);
      const ctx = {
        req, res, url,
        params: route.params,
        query: Object.fromEntries(url.searchParams),
        cookies: parseCookies(req.headers.cookie),
        ip: clientIp(req),
        status: 200,
        body: {},
      };
      if (route.opts.raw) {
        ctx.rawBody = await readRaw(req); // server-to-server webhook: verified by signature, not origin
      } else if (!['GET', 'HEAD'].includes(req.method)) {
        assertSameOrigin(req);
        ctx.body = await readJson(req);
      }
      ctx.user = userFromSession(ctx.cookies);
      if (!route.opts.public && !ctx.user) throw new HttpError(401, 'UNAUTHENTICATED', 'Please sign in to continue');
      const out = await route.handler(ctx);
      if (!res.headersSent) sendJson(res, ctx.status, out ?? { ok: true });
    } catch (err) {
      if (res.headersSent) return void res.destroy();
      if (err instanceof HttpError) {
        return sendJson(res, err.status, { code: err.code, message: err.message, ...(err.extra && { extra: err.extra }) });
      }
      console.error(`[${req.method} ${url.pathname}]`, err);
      sendJson(res, 500, { code: 'INTERNAL', message: 'Something went wrong on our side. Try again in a moment.' });
    }
  };
}
