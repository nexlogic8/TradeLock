import { html } from '/js/core/dom.js';
import { get } from '/js/core/api.js';
import { dateIST, hmIST } from '/js/core/format.js';
import { icon } from '/js/ui/icons.js';
import { empty } from '/js/ui/parts.js';
import { searchBox, bindSearch } from './ui.js';

export default {
  sub: 'Sign-ins, rule changes, payments, withdrawals and admin actions. Search by action, email or IP.',

  load: ctx => get(`/admin/audit${ctx.ui.q ? `?q=${encodeURIComponent(ctx.ui.q)}` : ''}`),

  view(ctx) {
    const items = ctx.data.items;
    return html`
      <div class="panel pad">
        <div class="panel-head"><h3 class="panel-title">${icon('list')} Audit log <span class="muted small">${items.length}</span></h3>
          ${searchBox('audit-q', ctx.ui.q, 'e.g. login, withdrawal, an email')}</div>
        ${items.length ? html`<div class="tbl-wrap"><table class="tbl cards">
          <thead><tr><th>When</th><th>Action</th><th>Account</th><th>Details</th><th>IP</th></tr></thead>
          <tbody>${items.map(a => html`<tr>
            <td class="num">${dateIST(a.createdAt, { day: '2-digit', month: 'short' })} ${hmIST(a.createdAt)}</td>
            <td><b class="${a.action.startsWith('admin.') ? 'warn' : ''}">${a.action}</b></td>
            <td>${a.email || html`<span class="dim">system</span>`}</td>
            <td class="span tiny dim adm-detail">${a.detail === '{}' ? '' : a.detail}</td>
            <td class="num tiny">${a.ip || ''}</td>
          </tr>`)}</tbody></table></div>` : empty('list', 'Nothing found', 'Try a different search.')}
      </div>`;
  },

  mount: ctx => bindSearch(ctx, 'audit-q'),
};
