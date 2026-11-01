// Platform alerts: checked every minute. An alert opens once (in-app notice to admins + email when
// SMTP is configured) and resolves by itself when the condition clears.
import { stmt } from '../../db/index.js';
import { config } from '../../config.js';
import { marketOpen } from '../../lib/time.js';
import { mailEnabled, sendMail } from '../../lib/mailer.js';
import { renderEmail } from '../../lib/emailtpl.js';
import { notify } from '../notifications/service.js';
import { systemHealth } from './system.js';
import { getStatus } from '../../lib/servicestatus.js';
import { businessStats, adminIds } from './service.js';

const CHECK_MS = 60e3;
const fmtBytes = b => `${(b / 1e9).toFixed(1)} GB`;

/** Pure: health + stats -> active conditions { key, level, title, body }. */
export function conditions(h, b, now = Date.now()) {
  const out = [];
  const add = (key, level, title, body) => out.push({ key, level, title, body });
  if (h.disk?.usedPct >= 95) add('disk', 'critical', `Disk ${h.disk.usedPct}% full`, `Only ${fmtBytes(h.disk.freeBytes)} left. The database and backups will fail when it fills.`);
  else if (h.disk?.usedPct >= 85) add('disk', 'warn', `Disk ${h.disk.usedPct}% full`, `${fmtBytes(h.disk.freeBytes)} free. Clean up old Docker images or grow the EBS volume.`);
  if (h.memory.usedPct >= 92) add('memory', 'warn', `Memory ${h.memory.usedPct}% used`, 'The server is close to running out of memory.');
  if (h.load[1] >= h.cpus * 1.5) add('cpu', 'warn', `High CPU load (${h.load[1]})`, `5-minute load average on ${h.cpus} CPUs. Check the t3 CPU credit balance in AWS.`);
  if (h.runtime.errorsLast10m >= 10) add('errors', 'critical', `${h.runtime.errorsLast10m} server errors in 10 minutes`, 'Check the logs: docker compose logs --tail=200 app');
  const tick = h.runtime.monitor.lastTickAt;
  if (h.marketOpen && h.monitorEnabled !== false && (!tick || now - tick > 60e3)) add('monitor', 'critical', 'Risk monitor has stalled', `No broker sync cycle for ${tick ? Math.round((now - tick) / 1000) + 's' : 'since start'} during market hours. Rules are not being checked.`);
  if (h.marketOpen && b.trading.unhealthy > 0) add('brokers', 'warn', `${b.trading.unhealthy} broker connection(s) not syncing`, 'Users with delayed, degraded or expired broker sessions are not protected.');
  if (h.certDaysLeft != null && h.certDaysLeft < 14) add('cert', h.certDaysLeft < 5 ? 'critical' : 'warn', `HTTPS certificate expires in ${h.certDaysLeft} days`, 'Caddy renews automatically; if this persists, check: docker compose logs caddy');
  if (h.backup?.available && (h.backup.latestAt ? now - h.backup.latestAt > 36 * 3600e3 : h.runtime.uptimeMs > 36 * 3600e3)) add('backup', 'warn', 'No database backup in the last 36 hours', 'Check the 16:30 IST cron job: crontab -l and ~/backups/backup.log');
  // Token keeper (separate container): only expected where it is deployed (production).
  if (h.expectTokenKeeper && (!h.tokenKeeper?.heartbeat_at || now - h.tokenKeeper.heartbeat_at > 3 * 60e3)) {
    add('tokenkeeper', 'critical', 'Token keeper is not running', 'Dhan access tokens will not be renewed and users will be disconnected within a day. Check: docker compose logs tokenkeeper');
  }
  if (b.wallet.oldestPendingAt && now - b.wallet.oldestPendingAt > 48 * 3600e3) add('withdrawals', 'warn', `${b.wallet.pendingWithdrawals} withdrawal(s) waiting over 48 hours`, 'Users were promised payment within 2 working days. Process them on the Wallet page.');
  return out;
}

async function deliver(level, title, body, resolved = false) {
  const ids = adminIds();
  for (const id of ids) notify(id, { kind: 'broker', level: resolved ? 'ok' : level, title: `${resolved ? '✓ Resolved: ' : ''}${title}`, body });
  if (mailEnabled() && config.alertEmails.length) {
    await sendMail({
      to: config.alertEmails,
      subject: `[TradeLock ${resolved ? 'RESOLVED' : level.toUpperCase()}] ${title}`,
      ...renderEmail({
        title: resolved ? `Resolved: ${title}` : title,
        preheader: body,
        tone: resolved ? 'info' : level === 'critical' ? 'critical' : 'warn',
        paragraphs: [body],
        facts: [`Severity: ${resolved ? 'resolved' : level}`, `Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`],
        button: { label: 'Open admin console', url: `${config.publicUrl}/admin` },
        note: 'You get this email because you are a TradeLock admin.',
      }),
    }).catch(e => console.error('[alerts] email failed:', e.message));
  }
}

export async function checkAlerts(health, stats) {
  const active = conditions(health, stats);
  const open = new Map(stmt('SELECT * FROM admin_alerts WHERE resolved_at IS NULL').all().map(a => [a.key, a]));
  for (const c of active) {
    if (open.has(c.key)) continue;
    stmt('INSERT INTO admin_alerts (key, level, title, body, created_at) VALUES (?, ?, ?, ?, ?)').run(c.key, c.level, c.title, c.body, Date.now());
    await deliver(c.level, c.title, c.body);
  }
  for (const [key, a] of open) {
    if (active.some(c => c.key === key)) continue;
    stmt('UPDATE admin_alerts SET resolved_at = ? WHERE id = ?').run(Date.now(), a.id);
    await deliver(a.level, a.title, 'The condition has cleared.', true);
  }
}

let lastCheckAt = null;
export const alertEngineStatus = () => ({ lastCheckAt });

export function startAlerts() {
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await checkAlerts({ ...(await systemHealth()), marketOpen: marketOpen(), expectTokenKeeper: config.isProd, tokenKeeper: getStatus('tokenkeeper') }, businessStats());
      lastCheckAt = Date.now();
    }
    catch (e) { console.error('[alerts]', e.message); }
    finally { busy = false; }
  };
  const t = setInterval(run, CHECK_MS);
  setTimeout(run, 15e3).unref();
  return () => clearInterval(t);
}

export const listAlerts = () => ({
  open: stmt('SELECT * FROM admin_alerts WHERE resolved_at IS NULL ORDER BY created_at DESC').all(),
  recent: stmt('SELECT * FROM admin_alerts WHERE resolved_at IS NOT NULL ORDER BY resolved_at DESC LIMIT 15').all(),
});
