import { html, on } from '../core/dom.js';
import { get, post } from '../core/api.js';
import { store } from '../core/store.js';
import { hmIST, dateIST } from '../core/format.js';
import { icon } from '../ui/icons.js';
import { empty } from '../ui/parts.js';
import { toastError } from '../ui/toast.js';

const FILTERS = [['all', 'All'], ['risk', 'Risk'], ['broker', 'Broker'], ['billing', 'Billing']];
const ICON = { risk: 'gauge', broker: 'link', billing: 'card' };
const KIND = { risk: 'Risk', broker: 'Broker', billing: 'Billing' };
const when = ts => (Date.now() - ts < 864e5 ? hmIST(ts) : dateIST(ts, { day: '2-digit', month: 'short' }));

export default {
  title: 'Notifications',
  sub: 'Risk alerts, broker issues and billing updates',
  layout: 'app',
  auth: true,

  load: () => get('/notifications'),

  view(ctx) {
    const ui = ctx.ui;
    ui.filter ??= 'all';
    const items = ctx.data.items.filter(n => ui.filter === 'all' || n.kind === ui.filter);
    return html`
      <div class="panel pad">
        <div class="panel-head">
          <div class="seg" role="group" aria-label="Filter notifications">${FILTERS.map(([k, l]) => html`<button type="button" data-filter="${k}" aria-pressed="${ui.filter === k}">${l}</button>`)}</div>
          <button class="btn btn-sm" id="read-all" ${ctx.data.unread ? '' : 'disabled'}>${icon('check')}Mark all read</button>
        </div>
        ${items.length ? html`<div class="notes">${items.map(n => html`
          <div class="notification-row note ${n.read ? '' : 'unread'}" data-id="${n.id}">
            <span class="n-ico ${n.kind}-${n.level}">${icon(ICON[n.kind] || 'bell')}</span>
            <span><b>${n.title}${n.read ? '' : html`<span class="unread-dot" aria-label="unread"></span>`}</b><span class="body">${KIND[n.kind]} · ${n.body}</span></span>
            <time datetime="${new Date(n.createdAt).toISOString()}">${when(n.createdAt)}</time>
            <button type="button" class="note-delete" data-delete="${n.id}" aria-label="Delete notification: ${n.title}" title="Delete">${icon('trash')}</button>
          </div>`)}</div>` : empty('bell', 'All quiet', 'Risk warnings, broker issues and billing updates will appear here.')}
      </div>`;
  },

  onStore(ctx, patch) {
    if (!patch.notification) return;
    ctx.data.items.unshift(patch.notification);
    ctx.data.unread += 1;
    ctx.paint();
  },

  mount(ctx) {
    const { el, signal, ui } = ctx;
    const markRead = async ids => {
      try {
        const { unread } = await post('/notifications/read', { ids });
        for (const n of ctx.data.items) if (ids === 'all' || ids.includes(n.id)) n.read = true;
        ctx.data.unread = unread;
        store.set({ unread });
        ctx.paint();
      } catch (e) { toastError(e); }
    };
    on(el, 'click', '[data-filter]', (_, b) => { ui.filter = b.dataset.filter; ctx.paint(); }, signal);
    on(el, 'click', '[data-delete]', async (event, b) => {
      event.stopPropagation();
      b.disabled = true;
      const row = b.closest('.notification-row');
      try {
        const { unread } = await post('/notifications/delete', { id: Number(b.dataset.delete) });
        row.classList.add('deleting');
        await new Promise(resolve => row.addEventListener('animationend', resolve, { once: true }));
        ctx.data.items = ctx.data.items.filter(n => n.id !== Number(b.dataset.delete));
        ctx.data.unread = unread;
        store.set({ unread });
        ctx.paint();
      } catch (err) { row.classList.remove('deleting'); b.disabled = false; toastError(err); }
    }, signal);
    on(el, 'click', '#read-all', () => markRead('all'), signal);
    on(el, 'click', '.note.unread', (_, n) => markRead([Number(n.dataset.id)]), signal);
  },
};
