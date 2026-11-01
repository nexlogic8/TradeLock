import { html, on } from '/js/core/dom.js';
import { get, post } from '/js/core/api.js';
import { ago, dateIST, hmIST } from '/js/core/format.js';
import { icon } from '/js/ui/icons.js';
import { pill, empty } from '/js/ui/parts.js';
import { toast, toastError } from '/js/ui/toast.js';

const STATUS = { running: ['Running', ''], starting: ['Starting', 'ice'], idle: ['Idle', 'grey'], degraded: ['Degraded', 'amber'], down: ['Down', 'red'], off: ['Off', 'grey'] };
const ICON = { api: 'server', monitor: 'radar', alerts: 'bell', httpworker: 'link', tokenkeeper: 'key' };
export const statusPill = s => pill(...(STATUS[s] || [s, 'grey']), { sm: true, dot: true, pulse: s === 'running' });

const when = ts => (!ts ? '–' : ts > Date.now() ? `${dateIST(ts, { day: '2-digit', month: 'short' })} ${hmIST(ts)}` : ago(ts));
const left = ms => {
  if (ms <= 0) return 'expired';
  const h = Math.floor(ms / 3600e3), m = Math.floor((ms % 3600e3) / 60e3);
  return h ? `${h}h ${m}m left` : `${m}m left`;
};

function serviceCard(s) {
  const r = s.lastResult;
  return html`
    <div class="panel pad svc ${s.status}">
      <div class="panel-head">
        <h3 class="panel-title">${icon(ICON[s.id] || 'server')} ${s.name}</h3>
        ${statusPill(s.status)}
      </div>
      <p class="muted small svc-detail">${s.detail}</p>
      <div class="adm-grid">
        <div class="adm-kv"><span>Runs</span><b class="num">${s.kind}</b></div>
        <div class="adm-kv"><span>Schedule</span><b class="num">${s.schedule}</b></div>
        ${s.facts.map(([k, v]) => html`<div class="adm-kv"><span>${k}</span><b class="num">${typeof v === 'number' && v > 1e12 ? when(v) : v ?? '–'}</b></div>`)}
      </div>
      ${r ? html`<div class="svc-result">
          <span class="muted small">Last run (${r.reason || 'scheduled'})</span>
          <div class="svc-nums">
            <span><b class="num">${r.checked}</b> checked</span><span class="pos"><b class="num">${r.renewed}</b> renewed</span>
            <span class="${r.expired ? 'warn' : ''}"><b class="num">${r.expired}</b> expired</span><span class="${r.failed ? 'neg' : ''}"><b class="num">${r.failed}</b> failed</span>
            <span><b class="num">${r.skipped}</b> not due</span>
          </div></div>` : ''}
      ${s.lastError ? html`<p class="small neg">Last error: ${s.lastError}</p>` : ''}
      ${s.canRun ? html`<button class="btn btn-sm mt-s" data-run="${s.id}" ${s.runRequested ? 'disabled' : ''}>${icon('refresh')}${s.runRequested ? 'Run requested…' : 'Run now'}</button>` : ''}
    </div>`;
}

export default {
  sub: 'Background services that keep TradeLock running. Refreshes every 30 seconds.',
  refreshMs: 30e3,

  load: () => get('/admin/services'),

  view({ data: d }) {
    const down = d.services.filter(s => s.status === 'down').length;
    return html`
      ${down ? html`<div class="banner red mb">${icon('alert')}<span><b>${down} service${down > 1 ? 's are' : ' is'} down.</b> On the server: <code>cd ~/tradelock/deploy && docker compose ps</code></span></div>` : ''}
      <div class="svc-grid">${d.services.map(serviceCard)}</div>

      <div class="panel pad mt">
        <div class="panel-head"><h3 class="panel-title">${icon('key')} Dhan access tokens</h3><span class="muted small">Renewed by the token keeper before they expire</span></div>
        ${d.tokens.length ? html`<div class="tbl-wrap"><table class="tbl cards">
          <thead><tr><th>User</th><th>Connection</th><th>Printed expiry</th><th>Time left</th></tr></thead>
          <tbody>${d.tokens.map(t => {
            const ms = (t.expiresAt || 0) - Date.now();
            // Dhan rejected the token (e.g. a newer token was generated): its printed expiry no longer matters.
            const rejected = t.status === 'expired' && ms > 0;
            return html`<tr>
              <td class="span"><b>${t.email}</b></td>
              <td>${pill(t.status, t.status === 'connected' ? '' : t.status === 'expired' ? 'red' : 'amber', { sm: true, dot: true })}</td>
              <td class="num">${t.expiresAt ? `${dateIST(t.expiresAt, { day: '2-digit', month: 'short' })} ${hmIST(t.expiresAt)}` : '–'}</td>
              <td class="num ${ms <= 0 || rejected ? 'neg' : ms < 14 * 3600e3 ? 'warn' : ''}">${rejected ? 'Invalid · reconnect' : t.expiresAt ? left(ms) : '–'}</td>
            </tr>`;
          })}</tbody></table></div>` : empty('key', 'No Dhan accounts', 'Connected Dhan accounts and their token expiry appear here.')}
        <p class="tiny dim" style="margin:12px 0 0">Tokens expiring within 14 hours are renewed at the next run. Expired tokens, and tokens Dhan has cancelled early (e.g. after the user generated a newer one), cannot be renewed: the user is notified to reconnect.</p>
      </div>`;
  },

  mount(ctx) {
    on(ctx.el, 'click', '[data-run]', async (_, b) => {
      b.disabled = true;
      try {
        await post(`/admin/services/${b.dataset.run}/run`);
        toast('Run requested. The token keeper starts it within 30 seconds.');
        setTimeout(() => ctx.reload(), 35e3);
        await ctx.reload();
      } catch (e) { toastError(e); b.disabled = false; }
    }, ctx.signal);
  },
};
