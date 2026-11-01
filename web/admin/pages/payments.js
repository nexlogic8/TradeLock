import { html } from '/js/core/dom.js';
import { get } from '/js/core/api.js';
import { paise, int, dateIST, hmIST } from '/js/core/format.js';
import { icon } from '/js/ui/icons.js';
import { pill, empty } from '/js/ui/parts.js';
import { kpi, subPill } from './ui.js';

const STATUS = { paid: '', created: 'grey', failed: 'red' };

export default {
  sub: 'Razorpay payments, wallet top-ups and subscriptions.',

  load: () => get('/admin/payments'),

  view({ data: d }) {
    const s = d.stats;
    return html`
      <div class="kpis">
        ${kpi('Revenue · today', paise(s.revenue.last24h))}
        ${kpi('Revenue · 30 days', paise(s.revenue.last30d), `${s.revenue.subscriptionsPaid30d} subscription payments`)}
        ${kpi('Revenue · all time', paise(s.revenue.allTime), 'Real Razorpay payments only')}
        ${kpi('Subscribers', int(s.subscriptions.paidActive), `${s.subscriptions.trialActive} on trial · ${s.subscriptions.cancelling} cancelling`, 'pos')}
      </div>

      <div class="panel pad">
        <div class="panel-head"><h3 class="panel-title">${icon('card')} Payments</h3><span class="muted small">Latest ${d.payments.length}</span></div>
        ${d.payments.length ? html`<div class="tbl-wrap"><table class="tbl cards">
          <thead><tr><th>User</th><th>For</th><th>Status</th><th>Razorpay IDs</th><th>Created</th><th class="r">Amount</th></tr></thead>
          <tbody>${d.payments.map(p => html`<tr>
            <td class="span"><b>${p.email}</b></td>
            <td>${p.purpose === 'subscription' ? 'Subscription' : 'Wallet top-up'}<div class="tiny dim">${p.provider}</div></td>
            <td>${pill(p.status, STATUS[p.status] ?? 'amber', { sm: true })}</td>
            <td class="tiny num">${p.orderId}${p.paymentId ? html`<div class="dim">${p.paymentId}</div>` : ''}</td>
            <td class="num">${dateIST(p.createdAt)} ${hmIST(p.createdAt)}</td>
            <td class="r num"><b>${paise(p.amount)}</b></td>
          </tr>`)}</tbody></table></div>` : empty('card', 'No payments yet', 'Razorpay payments will appear here.')}
      </div>

      <div class="panel pad mt">
        <div class="panel-head"><h3 class="panel-title">${icon('shield')} Subscriptions</h3><span class="muted small">${d.subscriptions.length} accounts</span></div>
        ${d.subscriptions.length ? html`<div class="tbl-wrap"><table class="tbl cards">
          <thead><tr><th>User</th><th>Status</th><th>Trial ends</th><th>Paid until</th><th></th></tr></thead>
          <tbody>${d.subscriptions.map(x => html`<tr>
            <td class="span"><b>${x.name}</b><div class="tiny dim">${x.email}</div></td>
            <td>${subPill(x.status, x.trialEndsAt, x.periodEnd)}</td>
            <td class="num">${x.trialEndsAt ? dateIST(x.trialEndsAt) : '–'}</td>
            <td class="num">${x.periodEnd ? dateIST(x.periodEnd) : '–'}</td>
            <td>${x.cancelling ? pill('Cancelling', 'amber', { sm: true }) : ''}</td>
          </tr>`)}</tbody></table></div>` : empty('shield', 'No subscriptions', '')}
      </div>`;
  },
};
