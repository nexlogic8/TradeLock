// Demo data: one trader on the simulated broker with 19 past sessions of history.
import { pathToFileURL } from 'node:url';
import { stmt, tx } from './index.js';
import { config } from '../config.js';
import { ist, previousTradingDays } from '../lib/time.js';
import { createUser, findUserByEmail } from '../modules/auth/service.js';
import { ensureAffiliate } from '../modules/affiliate/service.js';
import { upsertAccount } from '../modules/broker/registry.js';

const PAST_PNL = [1200, -800, 2100, 650, -1500, 900, 1800, -400, 1250, 700, -2100, 1600, 950, -600, 2300, 1100, -900, 1480, 1100];
const BREACH_DAYS = new Set([4, 10, 16]);
const BLOCKED_DAYS = new Set([10]);

export const seedDemo = tx(() => {
  if (findUserByEmail(config.demo.email)) return;
  const uid = createUser({ email: config.demo.email, password: config.demo.password, name: 'Jordan Demo' });
  const now = Date.now();
  const day = 864e5;

  stmt(`UPDATE subscriptions SET trial_ends_at = ? WHERE user_id = ?`).run(now + 6 * day, uid);
  upsertAccount(uid, { broker: 'mock', clientId: 'DEMO-2841' });

  const insDay = stmt(`INSERT INTO day_state (user_id, day, realized, worst, peak, entries, wins, losses, breaches, blocked, sync_ok, sync_fail)
                       VALUES (?, ?, ?, ?, ?, 3, ?, ?, ?, ?, ?, ?)`);
  previousTradingDays(ist().day, PAST_PNL.length).forEach((d, i) => {
    const pnl = PAST_PNL[i];
    const wins = pnl > 0 ? 2 : 1;
    insDay.run(uid, d, pnl, Math.min(0, pnl, -300), Math.max(0, pnl), wins, 3 - wins,
      BREACH_DAYS.has(i) ? 1 : 0, BLOCKED_DAYS.has(i) ? 1 : 0, 11100, i % 4 === 0 ? 700 : 180);
  });

  stmt(`INSERT INTO notifications (user_id, kind, level, title, body, read, created_at) VALUES (?, 'billing', 'info', ?, ?, 1, ?)`)
    .run(uid, 'Your free trial ends in 6 days', 'Subscribe to keep monitoring after your trial.', now - day);

  stmt('DELETE FROM affiliates WHERE user_id = ?').run(uid);
  ensureAffiliate(uid, 'CREATOR123');
  stmt('UPDATE affiliates SET clicks = 12480 WHERE user_id = ?').run(uid);
  const insRef = stmt(`INSERT INTO referrals (affiliate_user_id, status, created_at) VALUES (?, 'active', ?)`);
  for (let i = 0; i < 126; i++) insRef.run(uid, now - (i + 1) * 3600e3 * 5);
  stmt(`INSERT INTO wallet_ledger (user_id, bucket, amount, type, ref, note, created_at) VALUES (?, 'earnings', ?, 'commission', ?, ?, ?)`)
    .run(uid, 249500, 'seed-commissions', 'Commissions from referred traders (demo)', now - 2 * day);
  const insPayout = stmt(`INSERT INTO payouts (user_id, period, amount, status, paid_at) VALUES (?, ?, ?, 'paid', ?)`);
  insPayout.run(uid, '2026-09', 8981, Date.parse('2026-09-30T12:00:00+05:30'));
  insPayout.run(uid, '2026-08', 6240, Date.parse('2026-08-31T12:00:00+05:30'));
  insPayout.run(uid, '2026-07', 3993, Date.parse('2026-07-31T12:00:00+05:30'));
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedDemo();
  console.log(`Demo account ready: ${config.demo.email} / ${config.demo.password}`);
}
