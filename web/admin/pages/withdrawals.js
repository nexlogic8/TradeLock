import { html, $, on } from '/js/core/dom.js';
import { get, post } from '/js/core/api.js';
import { paise, ago, dateIST, hmIST } from '/js/core/format.js';
import { icon } from '/js/ui/icons.js';
import { pill, empty } from '/js/ui/parts.js';
import { toast, toastError } from '/js/ui/toast.js';
import { setBadges } from '../app.js';

export default {
  sub: 'Affiliate earnings payouts. Send the money by UPI or bank, then mark it paid with the reference.',

  async load() {
    const d = await get('/admin/withdrawals');
    setBadges({ withdrawals: d.pending.length });
    return d;
  },

  view({ data: d }) {
    return html`
      <div class="panel pad">
        <div class="panel-head"><h3 class="panel-title">${icon('bank')} Waiting to be paid</h3><span class="muted small">${d.pending.length} request${d.pending.length === 1 ? '' : 's'}</span></div>
        ${d.pending.length ? d.pending.map(x => html`
          <div class="txn adm-wd">
            <div class="grow"><b>${paise(x.amount)} · ${x.name} (${x.email})</b>
              <span>${x.method.toUpperCase()}: <b class="adm-dest">${x.destination}</b> · requested ${ago(x.createdAt)}${Date.now() - x.createdAt > 48 * 3600e3 ? ' · overdue' : ''}</span></div>
            <input class="input adm-ref" data-ref="${x.id}" placeholder="UTR / UPI reference or reason">
            <button class="btn btn-sm btn-primary" data-settle="${x.id}:paid">Mark paid</button>
            <button class="btn btn-sm" data-settle="${x.id}:rejected">Return to wallet</button>
          </div>`) : empty('check', 'Nothing to pay', 'New withdrawal requests will appear here. Users are promised payment within 2 working days.')}
      </div>

      <div class="panel pad mt">
        <div class="panel-head"><h3 class="panel-title">${icon('list')} Processed</h3><span class="muted small">Latest ${d.processed.length}</span></div>
        ${d.processed.length ? d.processed.map(x => html`
          <div class="txn"><div class="grow"><b>${paise(x.amount)} · ${x.email}</b>
            <span>${x.method.toUpperCase()} ${x.destination} · ${dateIST(x.processedAt)} ${hmIST(x.processedAt)} by ${x.processedBy || '–'}${x.note ? ` · ${x.note}` : ''}</span></div>
            ${x.status === 'paid' ? pill('Paid', '', { sm: true }) : pill('Returned', 'amber', { sm: true })}</div>`)
        : html`<p class="muted" style="margin:0">No processed withdrawals yet.</p>`}
      </div>`;
  },

  mount(ctx) {
    on(ctx.el, 'click', '[data-settle]', async (_, b) => {
      const [id, action] = b.dataset.settle.split(':');
      const note = $(`[data-ref="${id}"]`, ctx.el)?.value.trim() || '';
      if (action === 'rejected' && !confirm('Return this amount to the user\'s wallet?')) return;
      b.disabled = true;
      try {
        await post(`/admin/withdrawals/${id}`, { action, note });
        toast(action === 'paid' ? 'Marked as paid. The user has been notified.' : 'Returned to the user’s wallet.');
        await ctx.reload();
      } catch (e) { toastError(e); b.disabled = false; }
    }, ctx.signal);
  },
};
