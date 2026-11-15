// Account deletion (required by Google Play). Personal data and trading data are erased and the broker
// is disconnected. Payment, subscription and wallet records stay, de-identified, because invoices and
// GST records must be kept by law; they are linked only to an anonymous "Deleted user".
import { stmt, tx } from '../../db/index.js';
import { bad } from '../../lib/errors.js';
import { verifyTotp } from '../../lib/crypto.js';
import { accountsChanged, dropAdapter } from '../broker/registry.js';
import { audit } from '../audit/service.js';
import { endAllSessions } from './session.js';

// Personal and trading data removed outright.
const ERASE = [
  'risk_rules', 'day_state', 'pnl_points', 'trades', 'notifications', 'emergency_actions',
  'broker_fills', 'broker_pnl_days', 'broker_sync', 'password_resets', 'affiliates', 'scalper_lots', 'position_brackets', 'price_alerts',
];

export function deleteAccount(userId, { confirm, code } = {}, ip = null) {
  if (String(confirm || '').trim().toUpperCase() !== 'DELETE') {
    throw bad('CONFIRM_REQUIRED', 'Type DELETE to confirm.', { field: 'confirm' });
  }
  const u = stmt('SELECT * FROM users WHERE id = ?').get(userId);
  if (!u || u.deleted_at) throw bad('NOT_FOUND', 'This account no longer exists.');
  if (u.mfa_enabled && !verifyTotp(u.mfa_secret, String(code || ''))) {
    throw bad('MFA_INVALID', 'Enter the current 6-digit code from your authenticator app.', { field: 'code' });
  }
  if (stmt(`SELECT 1 FROM withdrawals WHERE user_id = ? AND status = 'requested'`).get(userId)) {
    throw bad('WITHDRAWAL_PENDING', 'A withdrawal from your wallet is still being processed. You can delete your account once it has been paid.');
  }

  const accounts = stmt('SELECT id FROM broker_accounts WHERE user_id = ?').all(userId);
  tx(() => {
    stmt('DELETE FROM broker_accounts WHERE user_id = ?').run(userId);   // also removes the encrypted token
    for (const t of ERASE) stmt(`DELETE FROM ${t} WHERE user_id = ?`).run(userId);
    stmt(`UPDATE users SET email = ?, name = 'Deleted user', password_hash = '!', google_sub = NULL, avatar_url = NULL,
            phone = NULL, mfa_enabled = 0, mfa_secret = NULL, mfa_pending = NULL, prefs = '{}', deleted_at = ? WHERE id = ?`)
      .run(`deleted-${userId}@deleted.tradelock.in`, Date.now(), userId);
    // A plan they paid for simply ends; nothing renews (there is no auto-debit anyway).
    stmt(`UPDATE subscriptions SET cancel_at_period_end = 1 WHERE user_id = ?`).run(userId);
  })();
  for (const a of accounts) dropAdapter(a.id);
  accountsChanged();
  endAllSessions(userId);
  audit(userId, 'account.deleted', {}, ip);
  return { ok: true };
}
