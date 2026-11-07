// Who sees what: administrators (ADMIN_EMAILS) get every strategy and its full detail; other users get the
// public strategy set only (Gap open 09:15), described without its technical rules.
import { stmt } from '../db/index.js';
import { config } from '../config.js';

export const isAdminEmail = email => config.adminEmails.includes(String(email || '').toLowerCase());
export const isAdminUser = userId => isAdminEmail(stmt('SELECT email FROM users WHERE id = ?').get(userId)?.email);

/** Strategies other users can see and switch on (broker_accounts switch columns). */
export const PUBLIC_STRATEGIES = ['gap_on'];
const PRIVATE_SWITCHES = ['orb_on', 'cross_on', 'ema915_on', 'strangle_on'];

/** The account as Algo Trading may use it: for non-admins the private strategies count as off. */
export const withAllowedStrategies = acct =>
  !acct || isAdminUser(acct.user_id) ? acct : { ...acct, ...Object.fromEntries(PRIVATE_SWITCHES.map(k => [k, 0])) };
