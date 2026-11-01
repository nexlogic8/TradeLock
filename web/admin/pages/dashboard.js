import { html } from '/js/core/dom.js';
import { get } from '/js/core/api.js';
import { paise, int, ago, hmIST } from '/js/core/format.js';
import { icon } from '/js/ui/icons.js';
import { pill, meter } from '/js/ui/parts.js';
import { setBadges } from '../app.js';
import { kpi, kv, gb, levelPill } from './ui.js';
import { statusPill } from './services.js';

const tone = (pct, warn, bad) => (pct >= bad ? 'red' : pct >= warn ? 'amber' : '');

export default {
  sub: 'Everything at a glance. Refreshes every 30 seconds.',
  refreshMs: 30e3,

  async load() {
    const d = await get('/admin/overview');
    setBadges({ alerts: d.alerts.length, withdrawals: d.withdrawals });
    return d;
  },

  view({ data: d }) {
    const s = d.stats, sys = d.system;
    return html`
      ${d.alerts.length ? html`<a class="banner ${d.alerts.some(a => a.level === 'critical') ? 'red' : 'amber'} mb adm-banner" href="/admin/alerts" data-link>
        ${icon('alert')}<span><b>${d.alerts.length} open alert${d.alerts.length > 1 ? 's' : ''}:</b> ${d.alerts.map(a => a.title).join(' · ')}</span></a>` : ''}

      <div class="kpis">
        ${kpi('Users', int(s.users.total), `+${s.users.last24h} today · +${s.users.last7d} this week`)}
        ${kpi('Paying subscribers', int(s.subscriptions.paidActive), `${s.subscriptions.trialActive} on trial · ${s.subscriptions.trialExpired} trial ended`, 'pos')}
        ${kpi('Revenue · 30 days', paise(s.revenue.last30d), `Today ${paise(s.revenue.last24h)} · all time ${paise(s.revenue.allTime)}`)}
        ${kpi('Agents running', html`${s.trading.agentsRunning}<small>/${s.trading.brokersConnected}</small>`,
          s.trading.unhealthy ? `${s.trading.unhealthy} not syncing` : 'All connected brokers syncing', s.trading.unhealthy ? 'warn' : '')}
      </div>

      <div class="halves">
        <div class="panel pad">
          <div class="panel-head"><h3 class="panel-title">${icon('server')} Server</h3>
            ${pill(sys.marketOpen ? 'Market open' : 'Market closed', sys.marketOpen ? '' : 'grey', { sm: true, dot: true })}</div>
          ${sys.disk ? html`<div class="gauge-row"><span>Disk</span>${meter(sys.disk.usedPct / 100, tone(sys.disk.usedPct, 85, 95))}<b class="num">${sys.disk.usedPct}%</b><span class="dim">${gb(sys.disk.freeBytes)} free</span></div>` : ''}
          <div class="gauge-row"><span>Memory</span>${meter(sys.memory.usedPct / 100, tone(sys.memory.usedPct, 80, 92))}<b class="num">${sys.memory.usedPct}%</b><span class="dim">${gb(sys.memory.freeBytes)} free</span></div>
          <div class="gauge-row"><span>CPU</span>${meter(Math.min(1, sys.load[0] / sys.cpus), tone(sys.load[0] / sys.cpus * 100, 80, 150))}<b class="num">${sys.load[0]}</b><span class="dim">load on ${sys.cpus} vCPU</span></div>
          <div class="adm-grid mt-s">
            ${kv('Risk monitor', sys.runtime.monitor.lastTickAt ? ago(sys.runtime.monitor.lastTickAt) : 'not started')}
            ${kv('Errors (1h)', int(sys.runtime.errorsLastHour))}
            ${kv('Last backup', !sys.backup.available ? 'not mounted' : sys.backup.latestAt ? ago(sys.backup.latestAt) : 'none yet')}
            ${kv('HTTPS cert', sys.certDaysLeft == null ? '–' : `${sys.certDaysLeft} days`)}
          </div>
          <a class="small adm-more" href="/admin/server" data-link>Server &amp; AWS details →</a>
        </div>

        <div class="panel pad">
          <div class="panel-head"><h3 class="panel-title">${icon('wallet')} Money &amp; activity</h3></div>
          <div class="adm-grid">
            ${kv('Pending withdrawals', html`<span class="${d.withdrawals ? 'warn' : ''}">${d.withdrawals} · ${paise(s.wallet.pendingAmount)}</span>`)}
            ${kv('Wallet funds held', paise(s.wallet.funds))}
            ${kv('Affiliate earnings held', paise(s.wallet.earnings))}
            ${kv('Commissions (30d)', paise(s.affiliate.commissions30d))}
            ${kv('Referred sign-ups', `${s.affiliate.referrals}`)}
            ${kv('Subscriptions paid (30d)', `${s.revenue.subscriptionsPaid30d}`)}
            ${kv('Breaches today', `${s.trading.breachesToday}`)}
            ${kv('Kill switches today', `${s.trading.killSwitchesToday}`)}
            ${kv('Orders blocked today', `${s.trading.blockedOrdersToday}`)}
            ${kv('Emergency stops today', `${s.trading.emergenciesToday}`)}
          </div>
          ${d.withdrawals ? html`<a class="small adm-more" href="/admin/withdrawals" data-link>Process withdrawals →</a>` : ''}
        </div>
      </div>

      <div class="panel pad mt">
        <div class="panel-head"><h3 class="panel-title">${icon('radar')} Microservices</h3><a class="small" href="/admin/services" data-link>Details →</a></div>
        <div class="svc-strip">${(d.services || []).map(s => html`<a class="svc-chip" href="/admin/services" data-link><b>${s.name}</b>${statusPill(s.status)}</a>`)}</div>
      </div>

      ${d.alerts.length ? html`<div class="panel pad mt">
        <div class="panel-head"><h3 class="panel-title">${icon('bell')} Open alerts</h3></div>
        ${d.alerts.map(a => html`<div class="txn"><div class="grow"><b>${a.title}</b><span>${a.body} · since ${ago(a.created_at)}</span></div>${levelPill(a.level)}</div>`)}
      </div>` : ''}
      <p class="tiny dim mt">Updated ${hmIST(d.generatedAt)} IST</p>`;
  },
};
