import { html, on } from '/js/core/dom.js';
import { get, post } from '/js/core/api.js';
import { ago, dateIST, hmIST } from '/js/core/format.js';
import { icon } from '/js/ui/icons.js';
import { pill } from '/js/ui/parts.js';
import { toast, toastError } from '/js/ui/toast.js';
import { setBadges } from '../app.js';
import { levelPill } from './ui.js';

const CHECKS = [
  ['Disk', 'warning at 85% full, critical at 95%'],
  ['Memory', 'warning at 92% used'],
  ['CPU', '5-minute load above 1.5 × vCPUs'],
  ['Server errors', '10 or more in 10 minutes'],
  ['Risk monitor', 'no sync cycle for 60 seconds during market hours'],
  ['Brokers', 'any running agent delayed, degraded or expired during market hours'],
  ['HTTPS certificate', 'fewer than 14 days left'],
  ['Backups', 'none in the last 36 hours'],
  ['Withdrawals', 'a request waiting more than 48 hours'],
];

export default {
  sub: 'Checked every minute. An alert opens once and closes itself when the problem clears.',
  refreshMs: 30e3,

  async load() {
    const d = await get('/admin/alerts');
    setBadges({ alerts: d.open.length });
    return d;
  },

  view({ data: d }) {
    return html`
      <div class="panel pad">
        <div class="panel-head"><h3 class="panel-title">${icon('bell')} Open</h3>
          ${d.open.length ? pill(`${d.open.length} open`, 'red', { sm: true }) : pill('All clear', '', { sm: true, dot: true })}</div>
        ${d.open.length ? d.open.map(a => html`
          <div class="txn"><div class="grow"><b>${a.title}</b><span>${a.body} · since ${ago(a.created_at)}</span></div>${levelPill(a.level)}</div>`)
        : html`<p class="muted" style="margin:0">No problems right now.</p>`}
      </div>

      <div class="halves mt">
        <div class="panel pad">
          <div class="panel-head"><h3 class="panel-title">${icon('alert')} Email alerts</h3>
            ${d.email.enabled ? pill('On', '', { sm: true, dot: true }) : pill('Off', 'grey', { sm: true })}</div>
          ${d.email.enabled
            ? html`<p class="muted" style="margin-top:0">Alerts and resolutions are emailed to <b>${d.email.to.join(', ')}</b>.</p>
                <button class="btn btn-sm" id="test-alert">Send test email</button>`
            : html`<p class="muted" style="margin-top:0">Alerts show here and in your TradeLock notifications. To also get them by email, add the mailbox to the server's <code>deploy/.env</code>:</p>
                <pre class="adm-code">SMTP_HOST=smtp.hostinger.com\nSMTP_USER=support@nexlogic.in\nSMTP_PASS=…</pre>`}
          <p class="tiny dim">AWS alarms (server down, CPU, site unreachable) email you separately. They are set up with <code>deploy/aws-alerts.sh</code> in AWS CloudShell.</p>
        </div>
        <div class="panel pad">
          <div class="panel-head"><h3 class="panel-title">${icon('check')} What is checked</h3></div>
          ${CHECKS.map(([k, v]) => html`<div class="adm-kv"><span>${k}</span><span class="small">${v}</span></div>`)}
        </div>
      </div>

      <div class="panel pad mt">
        <div class="panel-head"><h3 class="panel-title">${icon('clock')} History</h3><span class="muted small">Last ${d.recent.length} resolved</span></div>
        ${d.recent.length ? d.recent.map(a => html`
          <div class="txn"><div class="grow"><b>${a.title}</b><span>${dateIST(a.created_at)} ${hmIST(a.created_at)} → resolved ${ago(a.resolved_at)}</span></div>${pill('Resolved', 'grey', { sm: true })}</div>`)
        : html`<p class="muted" style="margin:0">No alerts yet.</p>`}
      </div>`;
  },

  mount(ctx) {
    on(ctx.el, 'click', '#test-alert', async (_, b) => {
      b.disabled = true;
      try { const r = await post('/admin/alerts/test'); toast(`Test email sent to ${r.to.join(', ')}.`); }
      catch (e) { toastError(e); }
      finally { b.disabled = false; }
    }, ctx.signal);
  },
};
