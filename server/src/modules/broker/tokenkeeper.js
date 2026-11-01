// Token keeper: keeps every user's Dhan access token alive. Dhan tokens last 24 hours and can only be
// renewed while still active (RenewToken), so each run renews every token that would expire before
// the next run (plus a margin). Tokens that already expired cannot be rescued: the user is asked to
// reconnect. Runs as its own process (src/workers/token-renewer.js) at 06:00 and 18:00 IST.
import { stmt } from '../../db/index.js';
import { encrypt, decrypt } from '../../lib/crypto.js';
import { notify } from '../notifications/service.js';
import { audit } from '../audit/service.js';
import { renewDhanToken, tokenExpiry } from './adapters/dhan.js';

export const RUN_TIMES_IST = ['06:00', '18:00'];
export const RENEW_WITHIN_MS = 14 * 3600e3;   // next run is 12 h away; 2 h margin
// Hourly safety pass between the main runs: catches a token connected after the last run that would expire
// before the next one (e.g. connected at 23:00, expiring at 06:00 exactly). Two chances before it expires.
export const SAFETY_EVERY_MS = 3600e3;
export const SAFETY_WITHIN_MS = 3 * 3600e3;

/** Milliseconds until the next 06:00 / 18:00 IST. */
export function msUntilNextRun(now = Date.now()) {
  const IST = 330 * 60e3;
  const local = new Date(now + IST);
  const dayStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - IST;
  const slots = [];
  for (const d of [0, 1]) for (const t of RUN_TIMES_IST) {
    const [h, m] = t.split(':').map(Number);
    slots.push(dayStart + d * 864e5 + (h * 60 + m) * 60e3);
  }
  return Math.min(...slots.filter(s => s > now + 1000)) - now;
}

/**
 * One pass over all connected Dhan accounts. `renew` is injectable for tests.
 * @returns summary { checked, renewed, expired, failed, skipped }
 */
export async function renewDueTokens({ now = Date.now(), renew = renewDhanToken, log = console.log, within = RENEW_WITHIN_MS } = {}) {
  const accounts = stmt(`SELECT * FROM broker_accounts WHERE broker = 'dhan' AND status != 'disconnected' AND token_enc IS NOT NULL`).all();
  const out = { checked: accounts.length, renewed: 0, expired: 0, failed: 0, skipped: 0 };

  for (const acct of accounts) {
    let token;
    try { token = decrypt(acct.token_enc); } catch { out.failed++; continue; }
    const expiresAt = tokenExpiry(token) ?? acct.token_expires_at;
    if (expiresAt && expiresAt - now > within) { out.skipped++; continue; }

    if (expiresAt && expiresAt <= now) {
      expire(acct, 'already expired');
      out.expired++;
      continue;
    }
    try {
      const fresh = await renew({ clientId: acct.client_id, accessToken: token });
      // Only replace the token if nobody reconnected meanwhile (compare with what we read).
      const done = stmt(`UPDATE broker_accounts SET token_enc = ?, token_expires_at = ?, last_error = NULL,
                           status = CASE WHEN status = 'expired' THEN 'connected' ELSE status END
                         WHERE id = ? AND token_enc = ?`).run(encrypt(fresh.accessToken), fresh.expiresAt, acct.id, acct.token_enc).changes;
      if (!done) { out.skipped++; continue; }
      audit(acct.user_id, 'broker.token_renewed', { broker: 'dhan', expiresAt: fresh.expiresAt });
      out.renewed++;
      log(`[tokenkeeper] renewed user ${acct.user_id} until ${new Date(fresh.expiresAt).toISOString()}`);
    } catch (e) {
      // Rejected before its printed expiry: Dhan cancelled it (usually a newer token was generated).
      if (e.code === 'TOKEN_EXPIRED') { expire(acct, 'rejected by Dhan before its expiry time (token cancelled)'); out.expired++; continue; }
      out.failed++;
      audit(acct.user_id, 'broker.token_renew_failed', { broker: 'dhan', error: String(e.message).slice(0, 200) });
      log(`[tokenkeeper] renew failed for user ${acct.user_id}: ${e.message}`);
      // Warn only when this was the last chance before expiry.
      if (expiresAt && expiresAt - now < 6 * 3600e3) {
        notify(acct.user_id, { kind: 'broker', level: 'warn', title: 'Dhan token could not be renewed',
          body: `TradeLock could not renew your Dhan access (${String(e.message).slice(0, 80)}). If it expires, reconnect Dhan with a new token.` });
      }
    }
  }
  return out;
}

function expire(acct, why) {
  if (acct.status !== 'expired') {
    stmt(`UPDATE broker_accounts SET status = 'expired', last_error = ? WHERE id = ?`).run('Dhan access token expired', acct.id);
    notify(acct.user_id, { kind: 'broker', level: 'critical', title: 'Reconnect Dhan to keep TradeLock protecting you',
      body: 'Your Dhan access token expired and could not be renewed automatically. Open Broker accounts, tap Reconnect and paste a new token from Dhan.' });
  }
  audit(acct.user_id, 'broker.token_expired', { broker: 'dhan', why });
}
