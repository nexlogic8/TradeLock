import { html } from '/js/core/dom.js';
import { get } from '/js/core/api.js';
import { paise, ago, dateIST } from '/js/core/format.js';
import { icon } from '/js/ui/icons.js';
import { empty } from '/js/ui/parts.js';
import { brokerPill, subPill, searchBox, bindSearch } from './ui.js';

export default {
  sub: 'Every account, newest first. Search by email, name or phone.',

  load: ctx => get(`/admin/users${ctx.ui.q ? `?q=${encodeURIComponent(ctx.ui.q)}` : ''}`),

  view(ctx) {
    const items = ctx.data.items;
    return html`
      <div class="panel pad">
        <div class="panel-head"><h3 class="panel-title">${icon('users')} Users <span class="muted small">${items.length}${items.length === 200 ? '+' : ''}</span></h3>
          ${searchBox('user-q', ctx.ui.q, 'Search email, name or phone')}</div>
        ${items.length ? html`<div class="tbl-wrap"><table class="tbl cards">
          <thead><tr><th>User</th><th>Joined</th><th>Last sign-in</th><th>Plan</th><th>Broker</th><th class="r">Wallet</th></tr></thead>
          <tbody>${items.map(u => html`<tr>
            <td class="span"><b>${u.name}</b><div class="tiny dim">${u.email}${u.phone ? ` · ${u.phone}` : ''}${u.google ? ' · Google' : ''}${u.mfa ? ' · 2FA' : ''}${u.referredBy ? ` · referred by ${u.referredBy}` : ''}</div></td>
            <td class="num">${dateIST(u.createdAt)}</td>
            <td class="num">${u.lastLoginAt ? ago(u.lastLoginAt) : '–'}</td>
            <td>${subPill(u.sub, u.trialEndsAt, u.periodEnd)}</td>
            <td>${u.broker ? brokerPill(...u.broker.split(':')) : html`<span class="dim">none</span>`}</td>
            <td class="r num">${paise(u.wallet)}</td>
          </tr>`)}</tbody></table></div>` : empty('users', 'No users found', 'Try a different search.')}
      </div>`;
  },

  mount: ctx => bindSearch(ctx, 'user-q'),
};
