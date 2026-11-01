import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
loadDotEnv(path.join(root, '.env'));

// Minimal .env loader so the server needs no extra dependency. Real env vars win.
function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const env = process.env;
const isProd = env.NODE_ENV === 'production';
if (isProd && !env.APP_SECRET) throw new Error('APP_SECRET must be set in production');
const secret = env.APP_SECRET || 'dev-only-secret-do-not-use-in-production';
const port = Number(env.PORT ?? 3000);

export const config = Object.freeze({
  root,
  isProd,
  port,
  host: env.HOST || '127.0.0.1',
  publicUrl: env.PUBLIC_URL || `http://localhost:${port}`,
  // Public IPv4 brokers see (for static-IP whitelisting). Detected at boot when not set.
  publicIp: env.PUBLIC_IP || '',
  publicIpv6: env.PUBLIC_IPV6 || '',
  // The server's IPv6 block (an AWS /80 prefix, e.g. 2406:da1a:13ae:3200:a1b2::/80): one static IP per user from it.
  ipv6Pool: env.IPV6_POOL || '',
  // The Google Play reviewers' account: it alone may use the simulated demo broker in production (no real orders).
  reviewUserId: Number(env.REVIEW_USER_ID) || 0,
  // Accounts on flexible discipline (comma-separated user ids): Algo Trading can be switched off in market hours, and
  // loosening a rule that paused trading today lifts that pause once the day is back inside the new limit.
  flexUserIds: new Set(String(env.FLEX_USER_IDS || '').split(',').map(Number).filter(n => n > 0)),
  // The TradeLock user whose Dhan account (with Data APIs) supplies market data to everyone; 0 = each user's own.
  marketDataUserId: Number(env.MARKET_DATA_USER_ID) || 0,
  trustProxy: env.TRUST_PROXY === '1',
  dbPath: env.DB_PATH === ':memory:' ? ':memory:' : path.resolve(root, env.DB_PATH || 'data/tradelock.db'),
  webDir: path.join(root, 'web'),
  encKey: createHash('sha256').update(`enc:${secret}`).digest(),
  sessionTtlMs: 7 * 24 * 3600e3,
  syncMs: Number(env.SYNC_MS || 2000),          // accounts in a trade or with an order working
  flatSyncMs: Number(env.FLAT_SYNC_MS || 4000),  // flat accounts (no position, no pending order)
  degradedAfterMs: Number(env.DEGRADED_AFTER_MS || 30000),
  monitor: env.MONITOR !== '0',
  // Google sign-in is enabled when both are set. Redirect URI: <PUBLIC_URL>/api/auth/google/callback
  // GOOGLE_APP_CLIENT_IDS: further web client IDs the Android app's ID tokens may be issued for (comma-separated);
  // the app's Android client lives in the project of the client it asks for, so the app can keep an older one.
  google: { clientId: env.GOOGLE_CLIENT_ID || '', clientSecret: env.GOOGLE_CLIENT_SECRET || '',
    appClientIds: String(env.GOOGLE_APP_CLIENT_IDS || '').split(',').map(s => s.trim()).filter(Boolean) },
  dhanBaseUrl: env.DHAN_BASE_URL || 'https://api.dhan.co/v2',
  // Optional AI decision provider. The key is server-only and is never returned by an API route.
  openai: { apiKey: env.OPENAI_API_KEY || '', model: env.OPENAI_MODEL || 'gpt-6-luna' },
  // Broker HTTP on a background thread (uses the second CPU core). HTTP_WORKER=0 keeps it inline.
  httpWorker: env.HTTP_WORKER !== '0',
  // Wallet top-ups are enabled when Razorpay keys are set (webhook secret optional but recommended).
  razorpay: {
    keyId: env.RAZORPAY_KEY_ID || '', keySecret: env.RAZORPAY_KEY_SECRET || '', webhookSecret: env.RAZORPAY_WEBHOOK_SECRET || '',
    // Prefilled in Checkout when the user hasn't saved a mobile number, so Razorpay doesn't ask for one.
    // Razorpay discards obvious dummies like +919999999999 and asks anyway; its documented sample works.
    // Better: set RAZORPAY_DEFAULT_CONTACT to the business's own support number.
    defaultContact: env.RAZORPAY_DEFAULT_CONTACT || '+919000090000',
  },
  // Comma-separated emails allowed to approve withdrawals.
  adminEmails: (env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  // Alert emails (optional). Hostinger mail: smtp.hostinger.com, port 465 (implicit TLS).
  smtp: {
    host: env.SMTP_HOST || '', port: Number(env.SMTP_PORT || 465),
    user: env.SMTP_USER || '', pass: env.SMTP_PASS || '', from: env.SMTP_FROM || env.SMTP_USER || '',
  },
  // Who receives alert emails; defaults to the admins.
  alertEmails: (env.ALERT_EMAIL || env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  // Where the host's backup cron writes *.db.gz (mounted read-only into the container).
  backupDir: env.BACKUP_DIR || '/backups',
  // PLAN_PRICE_INR overrides the price (e.g. ₹1 while testing live payments); default ₹499.
  plan: { name: 'TradeLock Pro', priceInr: Number(env.PLAN_PRICE_INR) > 0 ? Number(env.PLAN_PRICE_INR) : 499, gstRate: 0.18, trialDays: 7 },
  affiliateRate: 0.2,
  // NSE cash/F&O session in IST minutes from midnight.
  market: { open: 9 * 60 + 15, close: 15 * 60 + 30 },
  demo: { email: 'demo@tradelock.local', password: 'demo1234' },
});
