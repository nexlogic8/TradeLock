import { setCookie } from '../../lib/http.js';
import { config } from '../../config.js';
import { bad } from '../../lib/errors.js';
import { limit } from '../../lib/ratelimit.js';
import { affiliateStats, trackClick, validRefCode } from './service.js';

const REF_TTL = 30 * 864e5;

export function affiliateRoutes(r) {
  r.get('/api/affiliate', ctx => affiliateStats(ctx.user.id));

  // Public referral link: count the click, remember the code for signup, send to the sign-up form.
  r.get('/r/:code', ctx => {
    const code = ctx.params.code.slice(0, 32);
    const ok = trackClick(code);
    if (ok) setCookie(ctx.res, 'tl_ref', code.toUpperCase(), { maxAge: REF_TTL, secure: config.isProd });
    // The code also rides in the URL so the sign-up form can show it in the Referral code box.
    ctx.res.writeHead(302, { Location: ok ? `/signup?ref=${encodeURIComponent(code.toUpperCase())}` : '/signup' });
    ctx.res.end();
  }, { public: true });

  // Sign-up form: the code remembered from a referral link (cookie is HttpOnly, so ask the server).
  r.get('/api/referral', ctx => ({ code: validRefCode(ctx.cookies.tl_ref) }), { public: true });

  // Sign-up form: check a typed code and remember it (Google sign-up reads it from the cookie).
  r.post('/api/referral', ctx => {
    limit(`refcheck:${ctx.ip}`, 30, 10 * 60e3);
    const raw = String(ctx.body.code || '').trim();
    if (!raw) { setCookie(ctx.res, 'tl_ref', '', { maxAge: 0, secure: config.isProd }); return { code: null }; }
    const code = validRefCode(raw);
    if (!code) throw bad('INVALID_REFERRAL', 'That referral code was not found. Check it, or leave the box empty.');
    setCookie(ctx.res, 'tl_ref', code, { maxAge: REF_TTL, secure: config.isProd });
    return { code };
  }, { public: true });
}
