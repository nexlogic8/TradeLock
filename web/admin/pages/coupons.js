import { html, $, on } from '/js/core/dom.js';
import { get, post } from '/js/core/api.js';
import { paise, ago, dateIST } from '/js/core/format.js';
import { icon } from '/js/ui/icons.js';
import { pill, empty, formError } from '/js/ui/parts.js';
import { toast, toastError } from '/js/ui/toast.js';

const STATUS = { live: ['Live', ''], scheduled: ['Scheduled', 'ice'], expired: ['Expired', 'grey'], 'used up': ['Used up', 'amber'], off: ['Off', 'red'] };
const MONTHS = [1, 2, 3, 6, 12];

/** What the customer pays with the coupon being created (same maths as the server). */
function preview(f, plan) {
  const months = Number(f.months) || 1;
  const base = Math.round(plan.priceInr * 100) * months;
  const v = Number(f.discountValue) || 0;
  const discount = f.discountType === 'flat' ? Math.min(base, Math.round(v * 100)) : Math.round(base * Math.min(100, Math.max(0, v)) / 100);
  const net = base - discount;
  return { months, base, discount, total: net + Math.round(net * plan.gstRate) };
}

const validity = c => (!c.validFrom && !c.validUntil ? 'Always'
  : `${c.validFrom ? dateIST(c.validFrom) : 'Now'} → ${c.validUntil ? dateIST(c.validUntil) : 'no end'}`);

function form(ctx) {
  const d = ctx.data, f = ctx.ui.form;
  const p = preview(f, d.plan);
  return html`
    <div class="panel pad">
      <div class="panel-head"><h3 class="panel-title">${icon('plus')} Create a coupon</h3></div>
      <form id="coupon-form" class="cp-form" novalidate>
        <div class="field cp-code"><label for="cp-code">Coupon code</label>
          <div class="row" style="gap:8px;flex-wrap:nowrap"><input class="input num" id="cp-code" name="code" maxlength="24" autocomplete="off" spellcheck="false" value="${f.code}" placeholder="e.g. DIWALI50">
          <button type="button" class="btn" id="cp-gen">${icon('refresh')}Generate</button></div>
          <span class="tiny dim">Letters, digits, - and _. Customers type it on the Subscription page (any case).</span></div>

        <div class="field"><label>Discount</label>
          <div class="seg" role="group" aria-label="Discount type">
            <button type="button" data-dtype="percent" aria-pressed="${f.discountType === 'percent'}">% off</button>
            <button type="button" data-dtype="flat" aria-pressed="${f.discountType === 'flat'}">₹ off</button>
          </div></div>
        <div class="field"><label for="cp-value">${f.discountType === 'flat' ? 'Amount off (₹)' : 'Percent off (100 = free)'}</label>
          <input class="input num" id="cp-value" name="discountValue" inputmode="decimal" value="${f.discountValue}"></div>
        <div class="field"><label for="cp-months">Plan length</label>
          <select class="input" id="cp-months" name="months">${MONTHS.map(m => html`<option value="${m}" ${Number(f.months) === m ? 'selected' : ''}>${m} month${m === 1 ? '' : 's'}</option>`)}</select></div>

        <div class="field"><label for="cp-from">Valid from <span class="dim">(optional)</span></label><input class="input" type="date" id="cp-from" name="validFrom" value="${f.validFrom}"></div>
        <div class="field"><label for="cp-until">Valid until <span class="dim">(optional)</span></label><input class="input" type="date" id="cp-until" name="validUntil" value="${f.validUntil}"></div>
        <div class="field"><label>Total uses</label>
          <div class="seg" role="group" aria-label="Total uses">
            <button type="button" data-uses="1" aria-pressed="${f.maxRedemptions === '1'}">One time</button>
            <button type="button" data-uses="" aria-pressed="${f.maxRedemptions !== '1'}">Unlimited</button>
          </div>
          <input type="hidden" name="maxRedemptions" value="${f.maxRedemptions}"></div>
        <div class="field"><label for="cp-per">Uses per user</label>
          <select class="input" id="cp-per" name="perUserLimit">
            <option value="1" ${f.perUserLimit === '1' ? 'selected' : ''}>Once per user</option>
            <option value="3" ${f.perUserLimit === '3' ? 'selected' : ''}>Up to 3 times</option>
            <option value="" ${f.perUserLimit === '' ? 'selected' : ''}>Unlimited (every renewal)</option>
          </select></div>

        <label class="check-row cp-wide"><input type="checkbox" name="newUsersOnly" ${f.newUsersOnly ? 'checked' : ''}><span class="grow">New subscribers only <span class="dim">(not for traders who have paid before)</span></span></label>
        <div class="field cp-wide"><label for="cp-note">Internal note <span class="dim">(optional, only admins see it)</span></label><input class="input" id="cp-note" name="note" maxlength="200" value="${f.note}" placeholder="e.g. Telegram group launch offer"></div>

        <div class="cp-preview cp-wide">
          ${icon('tag')}<div class="grow"><b>Customer pays ${paise(p.total)}</b> <span class="muted">for ${p.months} month${p.months === 1 ? '' : 's'} incl. GST</span>
            ${p.discount ? html`<span class="pos small"> · saves ${paise(p.discount)}</span>` : ''}</div>
          <button class="btn btn-primary" type="submit">${icon('check')}Create coupon</button>
        </div>
        ${formError(ctx.ui.error)}
      </form>
    </div>`;
}

function list(d) {
  return html`
    <div class="panel pad mt">
      <div class="panel-head"><h3 class="panel-title">${icon('tag')} Coupons</h3><span class="muted small">${d.coupons.length} total</span></div>
      ${d.coupons.length ? html`<div class="tbl-wrap"><table class="tbl cards">
        <thead><tr><th>Code</th><th>Offer</th><th>Valid</th><th class="r">Uses</th><th>Rules</th><th class="r">Revenue</th><th>Status</th><th></th></tr></thead>
        <tbody>${d.coupons.map(c => html`<tr>
          <td class="span"><b class="num">${c.code}</b> <button class="icon-btn cp-copy" data-copy="${c.code}" title="Copy code" aria-label="Copy ${c.code}">${icon('copy')}</button>${c.note ? html`<span class="tiny dim cp-note">${c.note}</span>` : ''}</td>
          <td data-label="Offer">${c.label}</td>
          <td data-label="Valid" class="small">${validity(c)}</td>
          <td data-label="Uses" class="num r">${c.uses}${c.maxRedemptions ? ` / ${c.maxRedemptions}` : ''}</td>
          <td data-label="Rules" class="small">${c.perUserLimit ? (c.perUserLimit === 1 ? 'Once per user' : `${c.perUserLimit}× per user`) : 'Unlimited per user'}${c.newUsersOnly ? ' · new only' : ''}</td>
          <td data-label="Revenue" class="num r">${paise(c.revenue)}${c.discountGiven ? html`<span class="tiny dim"> (−${paise(c.discountGiven)})</span>` : ''}</td>
          <td data-label="Status">${pill(...(STATUS[c.status] || [c.status, 'grey']), { sm: true, dot: true })}</td>
          <td class="cp-actions">
            <button class="btn btn-sm" data-toggle="${c.id}:${c.active ? 0 : 1}">${c.active ? 'Turn off' : 'Turn on'}</button>
            <button class="btn btn-sm btn-ghost" data-del="${c.id}" title="${c.uses ? 'Used coupons are turned off, not deleted' : 'Delete'}">${icon('trash')}</button>
          </td></tr>`)}</tbody></table></div>`
      : empty('tag', 'No coupons yet', 'Create one above. Customers enter it on the Subscription page.')}
    </div>`;
}

export default {
  sub: 'Discount codes for TradeLock Pro: % or ₹ off, plan length, validity dates and usage limits.',

  async load(ctx) {
    const d = await get('/admin/coupons');
    ctx.ui.form ??= { code: d.suggestion, discountType: 'percent', discountValue: '20', months: '1', validFrom: '', validUntil: '', maxRedemptions: '1', perUserLimit: '1', newUsersOnly: true, note: '' };
    return d;
  },

  view(ctx) {
    const d = ctx.data;
    return html`
      ${form(ctx)}
      ${list(d)}
      <div class="panel pad mt">
        <div class="panel-head"><h3 class="panel-title">${icon('list')} Recent uses</h3><span class="muted small">Latest ${d.redemptions.length}</span></div>
        ${d.redemptions.length ? d.redemptions.map(r => html`
          <div class="txn"><div class="grow"><b><span class="num">${r.code}</span> · ${r.email}</b>
            <span>${r.months} month${r.months === 1 ? '' : 's'} · saved ${paise(r.discount)} · ${ago(r.at)}</span></div>
            <b class="num">${r.total ? paise(r.total) : 'Free'}</b></div>`)
        : html`<p class="muted" style="margin:0">No coupon has been used yet.</p>`}
      </div>`;
  },

  mount(ctx) {
    const { el, signal, ui } = ctx;
    const keep = () => {
      const fm = $('#coupon-form', el);
      if (!fm) return;
      const v = Object.fromEntries(new FormData(fm));
      ui.form = { ...ui.form, ...v, newUsersOnly: !!v.newUsersOnly };
    };
    on(el, 'input', '#coupon-form', () => {
      keep();
      const p = preview(ui.form, ctx.data.plan);
      const box = $('.cp-preview .grow', el);
      if (box) box.innerHTML = `<b>Customer pays ${paise(p.total)}</b> <span class="muted">for ${p.months} month${p.months === 1 ? '' : 's'} incl. GST</span>${p.discount ? `<span class="pos small"> · saves ${paise(p.discount)}</span>` : ''}`;
    }, signal);
    on(el, 'change', '#coupon-form', () => { keep(); }, signal);
    on(el, 'click', '[data-dtype]', (_, b) => { keep(); ui.form.discountType = b.dataset.dtype; ctx.paint(); }, signal);
    on(el, 'click', '[data-uses]', (_, b) => { keep(); ui.form.maxRedemptions = b.dataset.uses; ctx.paint(); }, signal);
    on(el, 'click', '#cp-gen', async () => {
      keep();
      ui.form.code = (await get('/admin/coupons')).suggestion;
      ctx.paint();
    }, signal);
    on(el, 'submit', '#coupon-form', async e => {
      e.preventDefault();
      keep();
      const btn = e.target.querySelector('[type=submit]');
      btn.disabled = true;
      try {
        const { coupon } = await post('/admin/coupons', ui.form);
        toast(`Coupon ${coupon.code} created: ${coupon.label}.`);
        ui.error = null;
        ui.form = null;
        await ctx.reload();
      } catch (err) { ui.error = err.message; ctx.paint(); }
    }, signal);
    on(el, 'click', '[data-copy]', async (_, b) => {
      try { await navigator.clipboard.writeText(b.dataset.copy); toast(`${b.dataset.copy} copied.`); } catch { /* clipboard blocked */ }
    }, signal);
    on(el, 'click', '[data-toggle]', async (_, b) => {
      const [id, on1] = b.dataset.toggle.split(':');
      b.disabled = true;
      try { await post(`/admin/coupons/${id}/active`, { on: on1 === '1' }); await ctx.reload(); } catch (err) { toastError(err); b.disabled = false; }
    }, signal);
    on(el, 'click', '[data-del]', async (_, b) => {
      if (!confirm('Delete this coupon? Coupons that were already used are turned off instead, so their history stays.')) return;
      b.disabled = true;
      try {
        const r = await post(`/admin/coupons/${b.dataset.del}/delete`);
        toast(r.deleted ? 'Coupon deleted.' : 'This coupon was used, so it was turned off instead.');
        await ctx.reload();
      } catch (err) { toastError(err); b.disabled = false; }
    }, signal);
  },
};
