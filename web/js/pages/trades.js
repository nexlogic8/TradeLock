// Positions: what is open right now, each closable in one click. TradeLock does not place new trades;
// below is today's history (fills and risk events).
import { html, on } from '../core/dom.js';
import { get, post, del } from '../core/api.js';
import { inr, tone, price, timeIST, longDay } from '../core/format.js';
import { icon } from '../ui/icons.js';
import { pill, empty, orderPermission } from '../ui/parts.js';
import { toast, toastError } from '../ui/toast.js';

const FILTERS = [['all', 'All'], ['exec', 'Executions'], ['event', 'Risk events']];
const CLOSING_TIMEOUT_MS = 20e3;   // give the broker this long before offering the button again

function historyRow(t) {
  if (t.kind === 'event') {
    return html`<tr><td class="inst span"><b>${t.symbol}</b><span>${t.note}</span></td><td class="num" data-label="Time">${timeIST(t.ts)}</td>
      <td data-label="Type"><span class="side-tag evt">${t.side}</span></td><td class="r num muted hide-card">–</td><td class="r num muted hide-card">–</td><td class="r num muted hide-card">–</td><td data-label="Status">${pill('Logged', 'grey')}</td></tr>`;
  }
  return html`<tr><td class="inst span"><b>${t.symbol}</b><span>${t.fills > 1 ? `Order · ${t.fills} fills` : t.pnl == null ? 'Fill' : 'Closing fill'}</span></td><td class="num" data-label="Time">${timeIST(t.ts)}</td>
    <td data-label="Side"><span class="side-tag ${t.side === 'BUY' ? 'buy' : 'sell'}">${t.side}</span></td><td class="r num" data-label="Qty">${t.qty}</td><td class="r num" data-label="Price">${price(t.price)}</td>
    <td class="r num ${tone(t.pnl)}" data-label="Realized P&L">${t.pnl == null ? '–' : inr(t.pnl, { sign: true, dp: 2 })}</td><td data-label="Status">${pill('Complete')}</td></tr>`;
}

const isClosing = (ctx, key) => (ctx.ui.closing.get(key) ?? 0) > Date.now();

function positionsPanel(ctx) {
  const d = ctx.state.dash;
  if (!d) return html`<div class="panel pad"><div class="loading">Waiting for the first sync…</div></div>`;
  const open = d.positions || [];
  const orders = d.orders || [];
  const perm = orderPermission(d.broker).state;
  const totalOpen = open.reduce((a, p) => a + (p.unrealized || 0), 0);
  return html`
    <div class="panel pad">
      <div class="panel-head">
        <h3 class="panel-title">${icon('list')} Open positions <span class="muted small">${open.length}</span></h3>
        ${open.length ? html`<span class="small">Open P&amp;L <b class="num ${tone(totalOpen)}">${inr(totalOpen, { sign: true })}</b></span>` : ''}
      </div>
      ${perm === 'blocked' ? html`<div class="banner red mb">${icon('alert')}<div class="grow"><b>${d.broker.label} is rejecting orders from TradeLock,</b> so Close will fail until you add <code>${d.broker.permissions.serverIp}</code> in ${d.broker.label} → Static IP Setting.</div><a class="btn btn-sm" href="/brokers">How to fix</a></div>` : ''}
      ${open.length ? html`
        <div class="tbl-wrap"><table class="tbl cards pos-tbl">
          <thead><tr><th>Instrument</th><th>Side</th><th class="r">Qty</th><th class="r">Avg price</th><th class="r">Open P&amp;L</th><th class="r">Booked today</th><th></th></tr></thead>
          <tbody>${open.map(p => html`<tr>
            <td class="inst span"><b>${p.symbol}</b><span>${p.productType ? p.productType.toLowerCase() : 'position'}</span></td>
            <td data-label="Side"><span class="side-tag ${p.qty > 0 ? 'buy' : 'sell'}">${p.qty > 0 ? 'LONG' : 'SHORT'}</span></td>
            <td class="r num" data-label="Qty">${Math.abs(p.qty)}</td>
            <td class="r num" data-label="Avg">${price(p.avg)}</td>
            <td class="r num ${tone(p.unrealized)}" data-label="Open P&L">${inr(p.unrealized, { sign: true })}</td>
            <td class="r num ${tone(p.realized)}" data-label="Booked">${inr(p.realized || 0, { sign: true })}</td>
            <td class="r span">${isClosing(ctx, `p:${p.symbol}`)
              ? html`<button class="btn btn-sm btn-close" disabled>Closing…</button>`
              : html`<button class="btn btn-sm btn-close" data-close="${p.symbol}" title="Exit ${Math.abs(p.qty)} at market">${icon('x')}Close</button>`}</td>
          </tr>`)}</tbody>
        </table></div>
        <p class="tiny dim" style="margin:12px 0 0">Close sends a market order for the full quantity to ${d.broker?.label || 'your broker'}. It disappears from this list once the broker confirms.</p>`
      : empty('check', 'No open positions', 'Positions you open in your broker app appear here within seconds, each with a Close button.')}
    </div>

    ${orders.length ? html`
      <div class="panel pad mt">
        <div class="panel-head"><h3 class="panel-title">${icon('clock')} Pending orders <span class="muted small">${orders.length}</span></h3></div>
        <div class="tbl-wrap"><table class="tbl cards">
          <thead><tr><th>Instrument</th><th>Side</th><th class="r">Qty</th><th class="r">Limit</th><th>Type</th><th></th></tr></thead>
          <tbody>${orders.map(o => html`<tr>
            <td class="inst span"><b>${o.symbol}</b><span>working order</span></td>
            <td data-label="Side"><span class="side-tag ${o.side === 'BUY' ? 'buy' : 'sell'}">${o.side}</span></td>
            <td class="r num" data-label="Qty">${o.qty}</td>
            <td class="r num" data-label="Limit">${price(o.price)}</td>
            <td data-label="Type">${o.type}</td>
            <td class="r span">${isClosing(ctx, `o:${o.id}`)
              ? html`<button class="btn btn-sm" disabled>Cancelling…</button>`
              : html`<button class="btn btn-sm" data-cancel="${o.id}">Cancel</button>`}</td>
          </tr>`)}</tbody>
        </table></div>
      </div>` : ''}`;
}

export default {
  title: 'Positions',
  sub: 'Close any open position in one click',
  layout: 'app',
  auth: true,
  live: ['dash'],

  load: () => get('/trades'),

  view(ctx) {
    const ui = ctx.ui;
    ui.filter ??= 'all';
    ui.closing ??= new Map();
    const { rows, summary, day } = ctx.data;
    const shown = rows.filter(r => ui.filter === 'all' || r.kind === ui.filter);
    return html`
      <div class="pos-cols">
      <div class="pos-col">${positionsPanel(ctx)}</div>

      <div class="panel pad pos-today">
        <div class="panel-head">
          <h3 class="panel-title">Today · ${longDay(day)}</h3>
          <div class="seg" role="group" aria-label="Filter">${FILTERS.map(([k, l]) => html`<button type="button" data-filter="${k}" aria-pressed="${ui.filter === k}">${l}</button>`)}</div>
        </div>
        ${shown.length ? html`
          <div class="tbl-wrap"><table class="tbl cards">
            <thead><tr><th>Instrument</th><th>Time (IST)</th><th>Side</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Realized P&amp;L</th><th>Status</th></tr></thead>
            <tbody>${shown.map(historyRow)}</tbody>
          </table></div>` : empty('list', 'Nothing here yet', 'Fills and risk events for today will appear here as they happen.')}
        <div class="row mt" style="gap:28px;border-top:1px solid var(--line);padding-top:16px">
          <div><div class="eyebrow">Realized</div><b class="num ${tone(summary.realized)}">${inr(summary.realized, { sign: true, dp: 2 })}</b></div>
          <div><div class="eyebrow">Open</div><b class="num ${tone(summary.unrealized)}">${inr(summary.unrealized, { sign: true, dp: 2 })}</b></div>
          <div><div class="eyebrow">Net (before charges)</div><b class="num ${tone(summary.net)}">${inr(summary.net, { sign: true, dp: 2 })}</b></div>
        </div>
      </div>
      </div>`;
  },

  onStore(ctx, patch) {
    const d = patch.dash;
    if (!d) return;
    // A position that is gone (or an order no longer pending) is no longer "closing".
    for (const key of [...ctx.ui.closing.keys()]) {
      const still = key.startsWith('p:') ? d.positions.some(p => `p:${p.symbol}` === key) : d.orders.some(o => `o:${o.id}` === key);
      if (!still) ctx.ui.closing.delete(key);
    }
    if (d.day === ctx.data.day && d.tradeCount !== ctx.data.rows.length) {
      get('/trades').then(data => { if (!ctx.signal.aborted) { ctx.data = data; ctx.paint(); } }).catch(() => {});
    }
  },

  mount(ctx) {
    const { el, signal, ui } = ctx;
    on(el, 'click', '[data-filter]', (_, b) => { ui.filter = b.dataset.filter; ctx.paint(); }, signal);

    on(el, 'click', '[data-close]', async (_, b) => {
      const symbol = b.dataset.close;
      ui.closing.set(`p:${symbol}`, Date.now() + CLOSING_TIMEOUT_MS);
      ctx.paint();
      try {
        await post('/positions/exit', { symbol });
        toast(`Exit order sent for ${symbol}.`);
      } catch (e) {
        ui.closing.delete(`p:${symbol}`);
        toastError(e);
      }
      ctx.paint();
      setTimeout(() => { if (!signal.aborted) ctx.paint(); }, CLOSING_TIMEOUT_MS + 100);
    }, signal);

    on(el, 'click', '[data-cancel]', async (_, b) => {
      const id = b.dataset.cancel;
      ui.closing.set(`o:${id}`, Date.now() + CLOSING_TIMEOUT_MS);
      ctx.paint();
      try {
        await del(`/orders/${encodeURIComponent(id)}`);
        toast('Order cancelled.');
      } catch (e) {
        ui.closing.delete(`o:${id}`);
        toastError(e);
      }
      ctx.paint();
    }, signal);
  },
};
