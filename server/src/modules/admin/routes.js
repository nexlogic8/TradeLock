// Admin console API (/admin). Every route is limited to ADMIN_EMAILS.
import { forbidden, bad } from '../../lib/errors.js';
import { limit } from '../../lib/ratelimit.js';
import { config } from '../../config.js';
import { marketOpen } from '../../lib/time.js';
import { mailEnabled, sendMail } from '../../lib/mailer.js';
import { renderEmail } from '../../lib/emailtpl.js';
import { pendingWithdrawals, settleWithdrawal } from '../wallet/service.js';
import {
  businessStats, brokerHealth, listUsers, listPayments, listSubscriptions, processedWithdrawals, listAffiliates, listAudit,
} from './service.js';
import { systemHealth } from './system.js';
import { listAlerts } from './alerts.js';
import { servicesOverview } from './services.js';
import { requestRun } from '../../lib/servicestatus.js';
import { audit } from '../audit/service.js';
import { listCoupons, recentRedemptions, createCoupon, setCouponActive, deleteCoupon, getCoupon, generateCode } from '../billing/coupons.js';

export const isAdmin = user => Boolean(user && config.adminEmails.includes(user.email.toLowerCase()));

export const requireAdmin = user => {
  if (!isAdmin(user)) throw forbidden('NOT_ADMIN', 'This account is not an administrator.');
};

const q = ctx => String(ctx.query.q || '').slice(0, 80);
const health = async () => ({ ...(await systemHealth()), marketOpen: marketOpen() });

export function adminRoutes(r) {
  const get = (path, fn) => r.get(path, async ctx => { requireAdmin(ctx.user); return fn(ctx); });
  const post = (path, fn) => r.post(path, async ctx => { requireAdmin(ctx.user); return fn(ctx); });

  get('/api/admin/me', ctx => ({ email: ctx.user.email, name: ctx.user.name }));

  get('/api/admin/overview', async () => ({
    stats: businessStats(),
    system: await health(),
    alerts: listAlerts().open,
    services: servicesOverview().services.map(s => ({ id: s.id, name: s.name, status: s.status })),
    withdrawals: pendingWithdrawals().length,
    generatedAt: Date.now(),
  }));

  get('/api/admin/users', ctx => ({ items: listUsers(q(ctx)) }));
  get('/api/admin/payments', () => ({ stats: businessStats(), payments: listPayments(), subscriptions: listSubscriptions() }));
  get('/api/admin/affiliates', () => ({ stats: businessStats().affiliate, items: listAffiliates() }));
  get('/api/admin/brokers', () => ({ stats: businessStats().trading, items: brokerHealth() }));
  get('/api/admin/system', health);
  get('/api/admin/services', () => servicesOverview());
  post('/api/admin/services/:name/run', ctx => {
    if (ctx.params.name !== 'tokenkeeper') throw bad('VALIDATION', 'This service cannot be run on demand.');
    limit(`svc-run:${ctx.user.id}`, 5, 10 * 60e3);
    requestRun('tokenkeeper');
    audit(ctx.user.id, 'admin.service_run', { service: 'tokenkeeper' }, ctx.ip);
    return { ok: true };
  });
  get('/api/admin/audit', ctx => ({ items: listAudit(q(ctx)) }));
  get('/api/admin/alerts', () => ({ ...listAlerts(), email: { enabled: mailEnabled(), to: config.alertEmails } }));

  // Coupons: create, list with usage, switch on/off, delete (used ones are switched off instead).
  get('/api/admin/coupons', () => ({ coupons: listCoupons(), redemptions: recentRedemptions(), plan: { priceInr: config.plan.priceInr, gstRate: config.plan.gstRate }, suggestion: generateCode() }));
  post('/api/admin/coupons', ctx => {
    const c = createCoupon(ctx.user.id, ctx.body);
    audit(ctx.user.id, 'admin.coupon_created', { code: c.code, label: c.label }, ctx.ip);
    return { coupon: c };
  });
  post('/api/admin/coupons/:id/active', ctx => {
    const c = setCouponActive(Number(ctx.params.id), !!ctx.body.on);
    audit(ctx.user.id, c.active ? 'admin.coupon_enabled' : 'admin.coupon_disabled', { code: c.code }, ctx.ip);
    return { coupon: c };
  });
  post('/api/admin/coupons/:id/delete', ctx => {
    const code = getCoupon(Number(ctx.params.id)).code;
    const res = deleteCoupon(Number(ctx.params.id));
    audit(ctx.user.id, res.deleted ? 'admin.coupon_deleted' : 'admin.coupon_disabled', { code }, ctx.ip);
    return res;
  });

  get('/api/admin/withdrawals', () => ({ pending: pendingWithdrawals(), processed: processedWithdrawals() }));
  post('/api/admin/withdrawals/:id', ctx => {
    const action = ctx.body.action;
    const note = String(ctx.body.note || '').slice(0, 200);
    if (action === 'paid' && !note) throw bad('VALIDATION', 'Add the UPI or bank transfer reference.');
    settleWithdrawal(ctx.user.id, ctx.params.id, action, note);
    return { pending: pendingWithdrawals(), processed: processedWithdrawals() };
  });

  // Send a test alert email so the SMTP setup can be confirmed from the console.
  post('/api/admin/alerts/test', async ctx => {
    limit(`alerttest:${ctx.user.id}`, 3, 10 * 60e3);
    if (!mailEnabled()) throw bad('EMAIL_NOT_CONFIGURED', 'Email alerts are not set up yet (SMTP settings missing on the server).');
    await sendMail({ to: config.alertEmails, subject: '[TradeLock] Test alert', ...renderEmail({
      title: 'Alert emails are working',
      paragraphs: [`This is a test alert from ${config.publicUrl}. If you can read this, TradeLock can email you about outages, failed payments and pending withdrawals.`],
      button: { label: 'Open admin console', url: `${config.publicUrl}/admin` },
      note: 'You get this email because you are a TradeLock admin.',
    }) })
      .catch(e => { throw bad('EMAIL_FAILED', `Sending failed: ${e.message}`); });
    return { ok: true, to: config.alertEmails };
  });
}
