import { stmt } from '../../db/index.js';
import { HttpError, bad } from '../../lib/errors.js';
import { limit } from '../../lib/ratelimit.js';
import { verifyTotp } from '../../lib/crypto.js';
import { config } from '../../config.js';
import { getBook } from '../broker/book.js';
import { accountFor, accountSummary } from '../broker/registry.js';
import { razorpayEnabled, verifyPaymentSignature, verifyWebhookSignature } from './razorpay.js';
import { getSubscription } from '../billing/service.js';
import {
  balances, ledger, withdrawalsFor, startTopup, completeTopup, paySubscription, withdraw,
  PLAN_PAISE, PLAN_TOTAL_PAISE, COMMISSION_PAISE, LIMITS,
} from './service.js';

export function walletRoutes(r) {
  r.get('/api/wallet', ctx => {
    const uid = ctx.user.id;
    const funds = getBook(uid).funds;
    const acct = accountSummary(accountFor(uid));
    return {
      balances: balances(uid),
      broker: acct ? { broker: acct.broker, label: acct.label, available: funds?.available ?? null, used: funds?.used ?? null, withdrawable: funds?.withdrawable ?? null } : null,
      plan: { name: config.plan.name, price: PLAN_PAISE, total: PLAN_TOTAL_PAISE, gstRate: config.plan.gstRate, commission: COMMISSION_PAISE },
      limits: LIMITS,
      provider: razorpayEnabled() ? 'razorpay' : config.isProd ? null : 'simulated',
      ledger: ledger(uid),
      withdrawals: withdrawalsFor(uid),
    };
  });

  r.post('/api/wallet/topup', async ctx => {
    limit(`topup:${ctx.user.id}`, 10, 10 * 60e3);
    return startTopup(ctx.user, ctx.body.amount);
  });

  // Razorpay Checkout success handler posts here; the signature proves the payment is genuine.
  r.post('/api/wallet/topup/verify', ctx => {
    const { orderId, paymentId, signature } = ctx.body;
    if (!razorpayEnabled() || !verifyPaymentSignature(orderId, paymentId, signature)) {
      throw new HttpError(400, 'BAD_SIGNATURE', 'We could not verify this payment. If money was deducted, it will be credited automatically within a few minutes.');
    }
    const p = stmt('SELECT user_id FROM payments WHERE provider_order_id = ?').get(orderId);
    if (!p || p.user_id !== ctx.user.id) throw bad('VALIDATION', 'Payment not found for this account.');
    const payment = completeTopup(orderId, paymentId);
    return { balances: balances(ctx.user.id), purpose: payment.purpose, subscription: getSubscription(ctx.user.id) };
  });

  // Server-to-server backup for when the browser closes before the success handler runs.
  r.post('/api/webhooks/razorpay', ctx => {
    if (!verifyWebhookSignature(ctx.rawBody, ctx.req.headers['x-razorpay-signature'])) throw new HttpError(400, 'BAD_SIGNATURE', 'Invalid signature');
    const evt = JSON.parse(ctx.rawBody);
    const pay = evt?.payload?.payment?.entity;
    if ((evt.event === 'payment.captured' || evt.event === 'order.paid') && pay?.order_id) {
      try { completeTopup(pay.order_id, pay.id); } catch (e) { if (e.status !== 404) throw e; }
    }
    return { ok: true };
  }, { public: true, raw: true });

  r.post('/api/wallet/subscribe', ctx => {
    limit(`walletsub:${ctx.user.id}`, 5, 60e3);
    return paySubscription(ctx.user.id);
  });

  r.post('/api/wallet/withdraw', ctx => {
    limit(`withdraw:${ctx.user.id}`, 5, 60 * 60e3);
    if (ctx.user.mfaEnabled) {
      const { mfa_secret: secret } = stmt('SELECT mfa_secret FROM users WHERE id = ?').get(ctx.user.id);
      if (!verifyTotp(secret, ctx.body.code)) throw new HttpError(401, 'MFA_INVALID', 'Enter a valid 6-digit code from your authenticator app.');
    }
    const id = withdraw(ctx.user.id, ctx.body);
    ctx.status = 201;
    return { id, balances: balances(ctx.user.id), withdrawals: withdrawalsFor(ctx.user.id) };
  });
}
