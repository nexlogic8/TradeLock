import { html } from '/js/core/dom.js';
import { get } from '/js/core/api.js';
import { int, ago } from '/js/core/format.js';
import { icon } from '/js/ui/icons.js';
import { pill, meter } from '/js/ui/parts.js';
import { kv, gb, mb, span } from './ui.js';

const tone = (pct, warn, bad) => (pct >= bad ? 'red' : pct >= warn ? 'amber' : '');

export default {
  sub: 'The EC2 server, the app process, backups and HTTPS. Refreshes every 30 seconds.',
  refreshMs: 30e3,

  load: () => get('/admin/system'),

  view({ data: s }) {
    const r = s.runtime, aws = s.aws;
    const consoleUrl = aws && `https://${aws.region}.console.aws.amazon.com/ec2/home?region=${aws.region}#InstanceDetails:instanceId=${aws.instanceId}`;
    return html`
      <div class="halves">
        <div class="panel pad">
          <div class="panel-head"><h3 class="panel-title">${icon('radar')} AWS EC2</h3>
            ${aws ? html`<a class="small" href="${consoleUrl}" target="_blank" rel="noopener">Open in AWS console →</a>` : ''}</div>
          ${aws ? html`<div class="adm-grid">
              ${kv('Instance', aws.instanceId)}
              ${kv('Type', aws.instanceType)}
              ${kv('Region / zone', aws.availabilityZone)}
              ${kv('Public IP', aws.publicIp || s.serverIp || '–')}
              ${kv('Image (AMI)', aws.amiId)}
              ${kv('Server uptime', span(s.hostUptimeS))}
            </div>`
          : html`<p class="muted" style="margin:0">Not running on AWS (instance metadata unavailable). Host: ${s.host}</p>`}
        </div>

        <div class="panel pad">
          <div class="panel-head"><h3 class="panel-title">${icon('gauge')} Resources</h3>
            ${pill(s.marketOpen ? 'Market open' : 'Market closed', s.marketOpen ? '' : 'grey', { sm: true, dot: true })}</div>
          ${s.disk ? html`<div class="gauge-row"><span>Disk</span>${meter(s.disk.usedPct / 100, tone(s.disk.usedPct, 85, 95))}<b class="num">${s.disk.usedPct}%</b><span class="dim">${gb(s.disk.freeBytes)} free of ${gb(s.disk.totalBytes)}</span></div>` : ''}
          <div class="gauge-row"><span>Memory</span>${meter(s.memory.usedPct / 100, tone(s.memory.usedPct, 80, 92))}<b class="num">${s.memory.usedPct}%</b><span class="dim">${mb(s.memory.freeBytes)} free of ${mb(s.memory.totalBytes)}</span></div>
          <div class="gauge-row"><span>CPU load</span>${meter(Math.min(1, s.load[0] / s.cpus), tone(s.load[0] / s.cpus * 100, 80, 150))}<b class="num">${s.load[0]}</b><span class="dim">${s.cpus} vCPU · 5m ${s.load[1]} · 15m ${s.load[2]}</span></div>
        </div>
      </div>

      <div class="halves mt">
        <div class="panel pad">
          <div class="panel-head"><h3 class="panel-title">${icon('server')} App</h3></div>
          <div class="adm-grid">
            ${kv('Uptime', span(r.uptimeMs / 1000))}
            ${kv('Node.js', s.node)}
            ${kv('App memory', mb(s.memory.processRss))}
            ${kv('Live dashboards', int(r.sseConnections))}
            ${kv('Requests (1h)', int(r.requestsLastHour))}
            ${kv('Server errors (1h)', html`<span class="${r.errorsLastHour ? 'warn' : ''}">${int(r.errorsLastHour)}</span>`)}
            ${kv('Risk monitor', r.monitor.lastTickAt ? `${ago(r.monitor.lastTickAt)} · ${r.monitor.lastTickMs} ms` : s.monitorEnabled === false ? 'disabled' : 'not started')}
            ${kv('Broker IP', s.serverIp || '–')}
          </div>
        </div>

        <div class="panel pad">
          <div class="panel-head"><h3 class="panel-title">${icon('shield')} Data &amp; HTTPS</h3></div>
          <div class="adm-grid">
            ${kv('Database size', mb(s.dbBytes))}
            ${kv('Last backup', !s.backup.available ? 'not mounted' : s.backup.latestAt ? ago(s.backup.latestAt) : 'none yet')}
            ${kv('Backups kept', s.backup.available ? `${s.backup.count}` : '–')}
            ${kv('Backup schedule', 'Daily 16:30 IST')}
            ${kv('HTTPS certificate', s.certDaysLeft == null ? '–' : html`<span class="${s.certDaysLeft < 14 ? 'warn' : ''}">${s.certDaysLeft} days left</span>`)}
            ${kv('Renewal', 'Automatic (Caddy)')}
          </div>
        </div>
      </div>`;
  },
};
