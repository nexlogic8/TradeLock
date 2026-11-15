// Power Scalper: price levels on a chart, TradingView style.
//   Hover the chart: a round "+" follows the cursor at the right edge, at the crosshair's price. Click it for
//   Buy limit / Sell limit (this ticket's lots) or Alert at that price.
//   Pending limit orders and price alerts of this contract are drawn as level markers: a dashed line and a pill
//   ("BUY LMT 7 @ 2,750.00 │ ✕", "🔔 2,750.00 │ ✕"). Drag a marker to move the order / alert; ✕ cancels it.
import { pauseScroll, resumeScroll } from './scalper-chart-draw.js';

const BUY = '#5AB8FF', SELL = '#FFBA52', ALERT = '#B48CFF', INK = '#05121a';
const PLUS = '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M10 4v12M4 10h12"/></svg>';
const BELL = '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 14V9a5 5 0 0110 0v5l1.5 1.5h-13z"/><path d="M8.5 17.5a1.7 1.7 0 003 0"/></svg>';
const UP = '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 16V4M5 9l5-5 5 5"/></svg>';
const DOWN = '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 4v12M5 11l5 5 5-5"/></svg>';

/** Round to the contract's tick (0.05 by default). */
export const toTick = (p, tick = 0.05) => Math.round(Math.round(p / tick) * tick * 100) / 100;

export class LevelOverlay {
  /**
   * opts.contract()  → { securityId, segment, symbol, ltp } of this chart, or null
   * opts.size()      → { lots, qty } for an order from this chart, or null (index chart: alerts only)
   * opts.act(kind, payload) → Promise: 'buy' | 'sell' {price} · 'move-order' {id, price} · 'cancel-order' {id}
   *                     · 'alert' {price} · 'move-alert' {id, price} · 'delete-alert' {id}
   */
  constructor(view, opts) {
    this.view = view; this.chart = view.chart; this.series = view.candles; this.host = view.host; this.opts = opts;
    this.orders = []; this.alerts = []; this.hits = []; this.drag = null; this.busy = new Set();
    this.paneView = { zOrder: () => 'top', renderer: () => ({ draw: target => this.draw(target) }) };
    this.series.attachPrimitive(this);
    this.buildUi(); this.bind();
  }
  attached({ requestUpdate }) { this.requestUpdate = requestUpdate; }
  detached() { this.requestUpdate = null; }
  updateAllViews() {}
  paneViews() { return [this.paneView]; }
  priceAxisViews() {
    const out = [], add = (p, bg) => out.push({ coordinate: () => this.series.priceToCoordinate(p) ?? -100, text: () => this.fmt(p), textColor: () => INK, backColor: () => bg, visible: () => true, tickVisible: () => true });
    for (const o of this.orders) add(this.priceOf('order', o), o.side === 'BUY' ? BUY : SELL);
    for (const a of this.alerts) add(this.priceOf('alert', a), ALERT);
    return out;
  }
  fmt(p) { try { return this.series.priceFormatter().format(p); } catch { return Number(p).toFixed(2); } }
  priceOf(kind, x) { return this.drag && this.drag.kind === kind && this.drag.id === x.id ? this.drag.price : x.price; }

  /** orders: pending LIMIT orders of this contract [{ id, side, qty, price }]; alerts: [{ id, price, dir }] */
  set({ orders, alerts }) {
    this.orders = orders || []; this.alerts = alerts || [];
    if (this.drag && ![...this.orders.map(o => `order:${o.id}`), ...this.alerts.map(a => `alert:${a.id}`)].includes(`${this.drag.kind}:${this.drag.id}`)) { this.drag = null; this.unlock(); }
    this.requestUpdate?.();
  }

  // ---- the "+" at the crosshair and its menu ----
  buildUi() {
    const plus = this.plus = document.createElement('button');
    plus.type = 'button'; plus.className = 'sc-lvl-plus'; plus.hidden = true; plus.innerHTML = PLUS;
    plus.title = 'Order or alert at this price'; plus.setAttribute('aria-label', 'Order or alert at this price');
    const menu = this.menu = document.createElement('div');
    menu.className = 'sc-lvl-menu'; menu.hidden = true; menu.setAttribute('role', 'menu');
    this.host.append(plus, menu);
    this.onCross = param => {
      if (this.drag || !this.menu.hidden) return;
      const y = param?.point?.y, w = this.chart.timeScale().width();
      if (y == null || !param.point || param.point.x > w || this.series.coordinateToPrice(y) == null) { this.plus.hidden = true; return; }
      this.plusY = y;
      this.plus.style.top = `${y - 13}px`; this.plus.style.left = `${w - 32}px`; this.plus.hidden = false;
    };
    this.chart.subscribeCrosshairMove(this.onCross);
  }
  openMenu() {
    const price = this.series.coordinateToPrice(this.plusY);
    if (price == null) return;
    const p = toTick(price), size = this.opts.size?.(), c = this.opts.contract?.(), fmt = this.fmt(p);
    const ltp = c?.ltp, rel = ltp > 0 ? (p > ltp ? 'above' : p < ltp ? 'below' : 'at') : '';
    this.menuPrice = p;
    this.menu.innerHTML = `<div class="sc-lvl-head"><b>${fmt}</b>${rel ? `<small>${rel} LTP ${this.fmt(ltp)}</small>` : ''}</div>
      ${size ? `<button type="button" role="menuitem" data-lvl="buy" class="buy">${UP}<span>Buy limit</span><em>${size.lots} lot${size.lots === 1 ? '' : 's'} @ ${fmt}</em></button>
      <button type="button" role="menuitem" data-lvl="sell" class="sell">${DOWN}<span>Sell limit</span><em>${size.lots} lot${size.lots === 1 ? '' : 's'} @ ${fmt}</em></button>` : ''}
      <button type="button" role="menuitem" data-lvl="alert" class="alert">${BELL}<span>Alert</span><em>when ${c?.ltp > 0 && p < c.ltp ? 'falls to' : 'reaches'} ${fmt}</em></button>`;
    const w = this.chart.timeScale().width(), top = Math.max(4, Math.min(this.plusY - 20, this.host.clientHeight - 170));
    this.menu.style.top = `${top}px`; this.menu.style.left = `${Math.max(4, w - 236)}px`;
    this.menu.hidden = false; this.plus.hidden = true;
    this.menu.querySelector('button')?.focus();
  }
  closeMenu() { this.menu.hidden = true; }
  async run(kind, payload, key) {
    if (key) { if (this.busy.has(key)) return; this.busy.add(key); }
    try { await this.opts.act(kind, payload); } finally { if (key) this.busy.delete(key); }
  }

  lock() { if (!this.locked) { this.saved = pauseScroll(this.chart); this.locked = true; } }
  unlock() { if (this.locked) { resumeScroll(this.chart, this.saved); this.locked = false; } }
  bind() {
    const host = this.host, local = e => { const r = host.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const tol = () => (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches ? 12 : 6);
    const lineAt = y => {
      for (const o of this.orders) { const yy = this.series.priceToCoordinate(this.priceOf('order', o)); if (yy != null && Math.abs(yy - y) <= tol()) return { kind: 'order', id: o.id, price: o.price, from: o.price }; }
      for (const a of this.alerts) { const yy = this.series.priceToCoordinate(this.priceOf('alert', a)); if (yy != null && Math.abs(yy - y) <= tol()) return { kind: 'alert', id: a.id, price: a.price, from: a.price }; }
      return null;
    };
    this.on = {
      plus: e => { e.preventDefault(); e.stopPropagation(); this.openMenu(); },
      menu: e => {
        const b = e.target.closest('[data-lvl]');
        if (!b) return;
        const kind = b.dataset.lvl, price = this.menuPrice;
        this.closeMenu();
        this.run(kind, { price });
      },
      outside: e => { if (!this.menu.hidden && !this.menu.contains(e.target) && e.target !== this.plus && !this.plus.contains(e.target)) this.closeMenu(); },
      down: e => {
        if ((e.button != null && e.button > 0) || e.target.closest?.('.sc-lvl-plus, .sc-lvl-menu, .sc-draw-rail, .sc-draw-sel, .sc-draw-edit')) return;
        const { x, y } = local(e), hit = this.hits.find(h => x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1);
        if (hit) {
          e.stopImmediatePropagation(); e.preventDefault();
          if (hit.act === 'cancel-order') this.run('cancel-order', { id: hit.id }, `o${hit.id}`);
          else if (hit.act === 'delete-alert') this.run('delete-alert', { id: hit.id }, `a${hit.id}`);
          return;
        }
        if (x > this.chart.timeScale().width()) return;
        const line = lineAt(y);
        if (!line) return;
        e.stopImmediatePropagation(); e.preventDefault();
        this.lock(); this.drag = line; this.plus.hidden = true;
        try { host.setPointerCapture(e.pointerId); } catch { /* ok */ }
        this.requestUpdate?.();
      },
      move: e => {
        const { y } = local(e);
        if (this.drag) { const p = this.series.coordinateToPrice(y); if (p != null && p > 0) { this.drag.price = toTick(p); this.requestUpdate?.(); } return; }
        const over = this.hits.some(h => { const { x } = local(e); return x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1; }) ? 'pointer' : lineAt(y) ? 'ns-resize' : '';
        if (host.dataset.lvlCursor !== over) host.dataset.lvlCursor = over;
      },
      up: e => {
        if (!this.drag) return;
        const d = this.drag;
        try { host.releasePointerCapture(e.pointerId); } catch { /* ok */ }
        this.unlock();
        if (d.price === d.from) { this.drag = null; this.requestUpdate?.(); return; }
        // Keep the line where it was dropped until the broker / server confirms (the next sync replaces it).
        const keep = d.kind === 'order' ? this.orders.find(o => o.id === d.id) : this.alerts.find(a => a.id === d.id);
        if (keep) keep.price = d.price;
        this.drag = null; this.requestUpdate?.();
        this.run(d.kind === 'order' ? 'move-order' : 'move-alert', { id: d.id, price: d.price }, `${d.kind[0]}${d.id}`).catch(() => { if (keep) keep.price = d.from; this.requestUpdate?.(); });
      },
      leave: () => { if (!this.drag && this.menu.hidden) this.plus.hidden = true; },
      key: e => {
        if (!host.isConnected) { this.destroy(); return; }
        if (e.key === 'Escape') { if (!this.menu.hidden) this.closeMenu(); if (this.drag) { this.drag = null; this.unlock(); this.requestUpdate?.(); } }
      },
    };
    this.plus.addEventListener('click', this.on.plus);
    this.plus.addEventListener('pointerdown', e => e.stopPropagation(), true);
    this.menu.addEventListener('click', this.on.menu);
    this.menu.addEventListener('pointerdown', e => e.stopPropagation(), true);
    document.addEventListener('pointerdown', this.on.outside, true);
    host.addEventListener('pointerdown', this.on.down, true);
    host.addEventListener('pointermove', this.on.move, true);
    host.addEventListener('pointerup', this.on.up, true);
    host.addEventListener('pointercancel', this.on.up, true);
    host.addEventListener('pointerleave', this.on.leave);
    document.addEventListener('keydown', this.on.key);
  }
  destroy() {
    if (!this.on) return;
    const host = this.host;
    try { this.chart.unsubscribeCrosshairMove(this.onCross); } catch { /* chart already removed */ }
    document.removeEventListener('pointerdown', this.on.outside, true); document.removeEventListener('keydown', this.on.key);
    host.removeEventListener('pointerdown', this.on.down, true); host.removeEventListener('pointermove', this.on.move, true);
    host.removeEventListener('pointerup', this.on.up, true); host.removeEventListener('pointercancel', this.on.up, true);
    host.removeEventListener('pointerleave', this.on.leave);
    this.plus.remove(); this.menu.remove(); this.unlock(); this.on = null;
  }

  draw(target) {
    this.hits = [];
    if (!this.orders.length && !this.alerts.length) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const W = Math.min(mediaSize.width, this.chart.timeScale().width());
      ctx.textBaseline = 'middle';
      ctx.font = "600 11px Inter, system-ui, -apple-system, 'Segoe UI', sans-serif";
      const rr = (x, y, w, h, r) => { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); };
      // A marker: dashed line across the pane, a pill on the LEFT (the right side belongs to positions / TP / SL),
      // with ✕ inside; the line thicker while it is being dragged.
      const marker = (y, color, text, act, id, dragging, dash) => {
        ctx.strokeStyle = color; ctx.lineWidth = dragging ? 2 : 1.2; ctx.setLineDash(dash);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); ctx.setLineDash([]);
        const tw = ctx.measureText(text).width, xw = dragging ? 0 : 20, w = tw + 16 + xw, x = 30;
        rr(x, y - 11, w, 22, 6); ctx.fillStyle = color; ctx.fill();
        ctx.fillStyle = INK; ctx.fillText(text, x + 8, y);
        if (!dragging) {
          ctx.fillStyle = 'rgba(5, 18, 26, 0.35)'; ctx.fillRect(x + tw + 12, y - 7, 1, 14);
          ctx.fillStyle = INK; ctx.fillText('✕', x + tw + 17, y);
          this.hits.push({ act, id, x0: x + tw + 10, x1: x + w + 2, y0: y - 13, y1: y + 13 });
        }
        // Grip at the far left: drag handle.
        ctx.fillStyle = color; rr(6, y - 4, 18, 8, 4); ctx.fill();
        ctx.fillStyle = INK; for (const gx of [11, 15, 19]) { ctx.beginPath(); ctx.arc(gx, y, 1, 0, Math.PI * 2); ctx.fill(); }
      };
      for (const o of this.orders) {
        const p = this.priceOf('order', o), y = this.series.priceToCoordinate(p);
        if (y == null) continue;
        const dragging = this.drag?.kind === 'order' && this.drag.id === o.id;
        marker(y, o.side === 'BUY' ? BUY : SELL, `${o.side} LMT ${o.lots ?? o.qty}${o.lots != null ? (o.lots === 1 ? ' lot' : ' lots') : ''} @ ${this.fmt(p)}${this.busy.has(`o${o.id}`) ? '  …' : ''}`, 'cancel-order', o.id, dragging, [6, 4]);
      }
      for (const a of this.alerts) {
        const p = this.priceOf('alert', a), y = this.series.priceToCoordinate(p);
        if (y == null) continue;
        const dragging = this.drag?.kind === 'alert' && this.drag.id === a.id;
        marker(y, ALERT, `🔔 ${a.dir === 'below' ? '≤' : '≥'} ${this.fmt(p)}${this.busy.has(`a${a.id}`) ? '  …' : ''}`, 'delete-alert', a.id, dragging, [2, 3]);
      }
    });
  }
}
