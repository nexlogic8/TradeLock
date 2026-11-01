import { html } from '/js/core/dom.js';
import { get } from '/js/core/api.js';
import { int, ago, dateIST, hmIST } from '/js/core/format.js';
import { icon } from '/js/ui/icons.js';
import { pill, empty } from '/js/ui/parts.js';
import { kpi, brokerPill } from './ui.js';

export default {
  sub: 'Connected broker accounts and the TradeLock agent watching each one. Refreshes every 30 seconds.',
  refreshMs: 30e3,

  load: () => get('/admin/brokers'),

  view({ data: d }) {
    const s = d.stats;
    return html`
      <div class="kpis">
        ${kpi('Brokers connected', int(s.brokersConnected))}
        ${kpi('Agents running', int(s.agentsRunning), `${s.agentsStopped} stopped by user`, 'pos')}
        ${kpi('Not syncing', int(s.unhealthy), 'Delayed, degraded or expired', s.unhealthy ? 'warn' : '')}
        ${kpi('Breaches today', int(s.breachesToday), `${s.killSwitchesToday} kill switches · ${s.blockedOrdersToday} orders blocked`)}
      </div>
      <div class="panel pad">
        <div class="panel-head"><h3 class="panel-title">${icon('link')} Connections</h3></div>
        ${d.items.length ? html`<div class="tbl-wrap"><table class="tbl cards">
          <thead><tr><th>User</th><th>Broker</th><th>Agent</th><th>Order permission</th><th>Last sync</th><th>Token expires</th></tr></thead>
          <tbody>${d.items.map(b => html`<tr>
            <td class="span"><b>${b.email}</b>${b.lastError ? html`<div class="tiny dim">${b.lastError}</div>` : ''}</td>
            <td>${brokerPill(b.broker, b.status)}</td>
            <td>${b.agentOn ? pill('Running', '', { sm: true }) : pill('Stopped', 'grey', { sm: true })}</td>
            <td>${b.ordersAllowed == null ? '–' : b.ordersAllowed ? pill('Allowed', '', { sm: true }) : pill('IP not whitelisted', 'amber', { sm: true })}</td>
            <td class="num">${b.lastSyncAt ? ago(b.lastSyncAt) : '–'}</td>
            <td class="num ${b.tokenExpiresAt && b.tokenExpiresAt - Date.now() < 864e5 ? 'warn' : ''}">${b.tokenExpiresAt ? `${dateIST(b.tokenExpiresAt)} ${hmIST(b.tokenExpiresAt)}` : '–'}</td>
          </tr>`)}</tbody></table></div>` : empty('link', 'No brokers connected', 'Connected broker accounts will appear here.')}
      </div>`;
  },
};
