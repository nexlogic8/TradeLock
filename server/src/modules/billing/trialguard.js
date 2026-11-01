// One free trial per person, judged by the device and by the broker account. Several TradeLock accounts
// on the same device (browser cookie, or the Android app's device ID), or connected to the same broker
// client ID, share one trial: the oldest account keeps it, newer ones lose theirs at once and must buy
// a plan. Paid plans are never touched. Device IDs are stored only as a keyed hash.
import { createHmac } from 'node:crypto';
import { stmt, tx } from '../../db/index.js';
import { config } from '../../config.js';
import { setCookie } from '../../lib/http.js';
import { randomToken } from '../../lib/crypto.js';
import { notify } from '../notifications/service.js';
import { audit } from '../audit/service.js';

const COOKIE = 'tl_dev';
const COOKIE_TTL = 2 * 365 * 864e5;
const VALID = /^[A-Za-z0-9_-]{8,128}$/;

const keyed = s => createHmac('sha256', config.encKey).update(s).digest('hex');

/** The caller's device: the Android app's ID header, else a long-lived cookie (set here if missing). */
export function deviceOf(ctx) {
  const app = String(ctx.req.headers['x-tl-device'] || '');
  if (VALID.test(app)) return `app:${app}`;
  let id = ctx.cookies?.[COOKIE];
  if (!VALID.test(id || '')) {
    id = randomToken(18);
    setCookie(ctx.res, COOKIE, id, { maxAge: COOKIE_TTL, secure: config.isProd });
  }
  return `web:${id}`;
}

const REASON = {
  device: 'A free trial was already used on this device',
  broker: 'A free trial was already used with this broker account',
};

/** Among `userIds`, the oldest account keeps its trial; every newer one still on a trial loses it. */
function settle(userIds, reason) {
  if (userIds.length < 2) return [];
  const ids = [...new Set(userIds)];
  const users = stmt(`SELECT u.id, u.created_at, s.status, s.trial_ends_at FROM users u JOIN subscriptions s ON s.user_id = u.id
                      WHERE u.id IN (${ids.map(() => '?').join(',')}) ORDER BY u.created_at, u.id`).all(...ids);
  const now = Date.now();
  const ended = [];
  for (const u of users.slice(1)) {
    if (u.status !== 'trial' || !(u.trial_ends_at > now)) continue;
    stmt(`UPDATE subscriptions SET trial_ends_at = ?, trial_blocked = ? WHERE user_id = ? AND status = 'trial'`).run(now, reason, u.id);
    audit(u.id, 'billing.trial_blocked', { reason });
    notify(u.id, { kind: 'billing', level: 'warn', title: 'Free trial not available',
      body: `${REASON[reason]}. Subscribe to TradeLock Pro to turn on protection for this account.` });
    ended.push(u.id);
  }
  return ended;
}

/** Record that `userId` used this device, and end any duplicate trial. Call after sign-in / on session check. */
export function guardDevice(ctx, userId) {
  if (!userId) return [];
  const hash = keyed(deviceOf(ctx));
  const now = Date.now();
  return tx(() => {
    stmt(`INSERT INTO device_links (device_hash, user_id, first_seen, last_seen) VALUES (?, ?, ?, ?)
          ON CONFLICT(device_hash, user_id) DO UPDATE SET last_seen = excluded.last_seen`).run(hash, userId, now, now);
    const users = stmt('SELECT user_id FROM device_links WHERE device_hash = ?').all(hash).map(r => r.user_id);
    return settle(users, 'device');
  })();
}

/** After a broker is connected: accounts sharing the same broker client ID share one trial. */
export function guardBroker(userId, broker, clientId) {
  if (!clientId || broker === 'mock') return [];
  const users = stmt('SELECT DISTINCT user_id FROM broker_accounts WHERE broker = ? AND client_id = ?').all(broker, clientId).map(r => r.user_id);
  return settle([userId, ...users], 'broker');
}

export const trialBlockedText = reason => REASON[reason] || null;
