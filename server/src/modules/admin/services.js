// Status of TradeLock's background services for the admin console.
//  - in the app process: API server, risk monitor, alert engine, broker HTTP worker thread
//  - separate container: token keeper (reports through service_status)
import { stmt } from '../../db/index.js';
import { config } from '../../config.js';
import { metrics } from '../../lib/metrics.js';
import { marketOpen } from '../../lib/time.js';
import { getStatus } from '../../lib/servicestatus.js';
import { decrypt } from '../../lib/crypto.js';
import { tokenExpiry } from '../broker/adapters/dhan.js';
import { RUN_TIMES_IST } from '../broker/tokenkeeper.js';
import { alertEngineStatus } from './alerts.js';

export const TOKENKEEPER_STALE_MS = 3 * 60e3;   // heartbeat every 30 s

const state = (ok, warn = false) => (ok ? 'running' : warn ? 'degraded' : 'down');

export function servicesOverview(now = Date.now()) {
  const m = metrics();
  const tick = m.monitor.lastTickAt;
  const agents = stmt(`SELECT COUNT(*) AS n FROM broker_accounts WHERE status != 'disconnected' AND agent_on = 1`).get().n;
  const alertsAt = alertEngineStatus().lastCheckAt;
  const tk = getStatus('tokenkeeper');
  const tkAlive = !!tk?.heartbeat_at && now - tk.heartbeat_at < TOKENKEEPER_STALE_MS;

  const services = [
    { id: 'api', name: 'API server', kind: 'In the app', schedule: 'Always on',
      status: state(true), detail: `${m.requestsLastHour} requests and ${m.errorsLastHour} server errors in the last hour`,
      facts: [['Up since', m.bootAt], ['Live dashboards', m.sseConnections]] },
    { id: 'monitor', name: 'Risk monitor', kind: 'In the app', schedule: `Every ${config.syncMs / 1000} s (4 s when flat)`,
      status: !config.monitor ? 'off' : !marketOpen() ? 'idle' : state(!!tick && now - tick < 60e3),
      detail: !config.monitor ? 'Disabled on this server' : marketOpen() ? `Watching ${agents} running agent(s)` : `Market closed: refreshing ${agents} account(s) every 5 minutes`,
      facts: [['Last cycle', tick], ['Cycle time', tick ? `${m.monitor.lastTickMs} ms` : null]] },
    { id: 'alerts', name: 'Alert engine', kind: 'In the app', schedule: 'Every minute',
      status: !alertsAt && m.uptimeMs < 2 * 60e3 ? 'starting' : state(!!alertsAt && now - alertsAt < 3 * 60e3), detail: 'Checks disk, memory, CPU, errors, monitor, brokers, HTTPS, backups, withdrawals, token keeper',
      facts: [['Last check', alertsAt]] },
    { id: 'httpworker', name: 'Broker HTTP worker', kind: 'In the app (thread)', schedule: 'Always on',
      status: config.httpWorker ? 'running' : 'off', detail: config.httpWorker ? 'Dhan API calls run on a background thread (second CPU core)' : 'Disabled: Dhan calls run on the main thread',
      facts: [] },
    { id: 'tokenkeeper', name: 'Token keeper', kind: 'Separate container', schedule: `Daily ${RUN_TIMES_IST.join(' and ')} IST`,
      status: !tk ? 'down' : tkAlive ? 'running' : 'down', canRun: true,
      detail: !tk ? 'Never reported. Check: docker compose logs tokenkeeper' : tkAlive ? 'Renews Dhan access tokens before they expire' : 'No heartbeat. Check: docker compose logs tokenkeeper',
      facts: [['Started', tk?.started_at], ['Heartbeat', tk?.heartbeat_at], ['Last run', tk?.last_run_at], ['Next run', tk?.next_run_at]],
      lastResult: tk?.last_result || null, lastError: tk?.last_error || null, runRequested: !!tk?.run_requested },
  ];

  // Every Dhan token and how long it has left.
  const tokens = stmt(`SELECT b.status, b.token_enc, b.token_expires_at, u.email FROM broker_accounts b JOIN users u ON u.id = b.user_id
                       WHERE b.broker = 'dhan' AND b.status != 'disconnected' ORDER BY b.token_expires_at`).all()
    .map(r => {
      let exp = r.token_expires_at;
      try { exp = tokenExpiry(decrypt(r.token_enc)) ?? exp; } catch { /* unreadable token */ }
      return { email: r.email, status: r.status, expiresAt: exp };
    });

  return { services, tokens, generatedAt: now };
}
