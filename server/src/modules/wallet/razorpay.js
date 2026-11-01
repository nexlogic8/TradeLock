// Razorpay Orders + Checkout for wallet top-ups (https://razorpay.com/docs/payments/server-integration/).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../../config.js';

export const razorpayEnabled = () => Boolean(config.razorpay.keyId && config.razorpay.keySecret);

function safeEqualHex(expected, given) {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(given || ''), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Create an order for `amount` paise; the browser then opens Checkout with its id. */
export async function createOrder(amount, receipt, notes = {}) {
  const auth = Buffer.from(`${config.razorpay.keyId}:${config.razorpay.keySecret}`).toString('base64');
  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount, currency: 'INR', receipt, notes }),
    signal: AbortSignal.timeout(8000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) throw new Error(data?.error?.description || `Razorpay returned HTTP ${res.status}`);
  return data;
}

/** Checkout success handler: signature = HMAC_SHA256(order_id + "|" + payment_id, key_secret). */
export const verifyPaymentSignature = (orderId, paymentId, signature) =>
  safeEqualHex(createHmac('sha256', config.razorpay.keySecret).update(`${orderId}|${paymentId}`).digest('hex'), signature);

/** Webhook: X-Razorpay-Signature = HMAC_SHA256(raw body, webhook secret). */
export const verifyWebhookSignature = (rawBody, signature) =>
  Boolean(config.razorpay.webhookSecret) &&
  safeEqualHex(createHmac('sha256', config.razorpay.webhookSecret).update(rawBody).digest('hex'), signature);
