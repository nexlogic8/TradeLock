import { HttpError } from '../../lib/errors.js';
import { limit } from '../../lib/ratelimit.js';
import { startSubscriptionCheckout, balances, PLAN_TOTAL_PAISE } from '../wallet/service.js';
import { getSubscription, setCancelAtPeriodEnd } from './service.js';
import { audit } from '../audit/service.js';
import { quote } from './coupons.js';

export function billingRoutes(r) {
  r.get('/api/billing', ctx => ({
    subscription: getSubscription(ctx.user.id),
    wallet: balances(ctx.user.id),
    total: PLAN_TOTAL_PAISE,
  }));

  // Price with a coupon applied (or the reason it can't be used).
  r.post('/api/billing/quote', ctx => {
    limit(`quote:${ctx.user.id}`, 30, 10 * 60e3);
    return { quote: quote(ctx.user.id, ctx.body.coupon) };
  });

  // Wallet first (optional), Razorpay for whatever is left. Completed via /wallet/topup/verify or the webhook.
  r.post('/api/billing/checkout', async ctx => {
    limit(`checkout:${ctx.user.id}`, 10, 10 * 60e3);
    return startSubscriptionCheckout(ctx.user, ctx.body.useWallet !== false, ctx.body.coupon || null);
  });

  r.post('/api/billing/cancel', ctx => {
    setCancelAtPeriodEnd(ctx.user.id, true);
    audit(ctx.user.id, 'billing.cancel_renewal', {}, ctx.ip);
    return { subscription: getSubscription(ctx.user.id) };
  });

  r.post('/api/billing/resume', ctx => {
    setCancelAtPeriodEnd(ctx.user.id, false);
    audit(ctx.user.id, 'billing.resume_renewal', {}, ctx.ip);
    return { subscription: getSubscription(ctx.user.id) };
  });
}
