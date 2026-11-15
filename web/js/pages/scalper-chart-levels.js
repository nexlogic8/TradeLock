// Power Scalper: price levels on a chart, TradingView style.
//   Hover the chart: a round "+" follows the cursor at the right edge, at the crosshair's price. Click it for
//   Buy limit / Sell limit (this ticket's lots) or Alert at that price.
//   Pending limit orders and price alerts of this contract are drawn as level markers: a dashed line and a pill
//   ("BUY LMT 7 @ 2,750.00 │ ✕", "🔔 2,750.00 │ ✕"). Drag a marker to move the order / alert; ✕ cancels it.
import { pauseScroll, resumeScroll } from './scalper-chart-draw.js';

const BUY = '#5AB8FF', SELL = '#FFBA52', ALERT = '#B48CFF', SELECT = '#2DE0C0', INK = '#05121a';
const PLUS = '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M10 4v12M4 10h12"/></svg>';
const BELL = '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 14V9a5 5 0 0110 0v5l1.5 1.5h-13z"/><path d="M8.5 17.5a1.7 1.7 0 003 0"/></svg>';
const UP = '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 16V4M5 9l5-5 5 5"/></svg>';
const HLINE = '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M2 10h16"/><circle cx="10" cy="10" r="2" fill="currentColor"/></svg>';
const DOWN = '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 4v12M5 11l5 5 5-5"/></svg>';
let activeSelection = null;

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
    this.orders = []; this.alerts = []; this.hits = []; this.drag = null; this.busy = new Set(); this.alertHandles = new Map();
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
  clearSelection() {
    this.plus.hidden = true; this.dragPoint.hidden = true; delete this.host.dataset.lvlTouchSelected;
    if (activeSelection === this) activeSelection = null;
    this.requestUpdate?.();
  }

  /** orders: pending LIMIT orders of this contract [{ id, side, qty, price }]; alerts: [{ id, price, dir }] */
  set({ orders, alerts }) {
    this.orders = orders || []; this.alerts = alerts || [];
    this.syncAlertHandles();
    if (this.drag && ![...this.orders.map(o => `order:${o.id}`), ...this.alerts.map(a => `alert:${a.id}`)].includes(`${this.drag.kind}:${this.drag.id}`)) { this.drag = null; this.unlock(); }
    this.requestUpdate?.();
  }
  syncAlertHandles() {
    const wanted = new Set(this.alerts.map(a => String(a.id)));
    for (const [id, handle] of this.alertHandles) if (!wanted.has(id)) { handle.remove(); this.alertHandles.delete(id); }
    for (const alert of this.alerts) {
      const id = String(alert.id);
      if (this.alertHandles.has(id)) continue;
      const handle = document.createElement('button');
      handle.type = 'button'; handle.className = 'sc-lvl-alert-drag'; handle.dataset.alertId = id;
      handle.setAttribute('aria-label', `Drag alert ${this.fmt(alert.price)}`); handle.tabIndex = -1;
      handle.innerHTML = '<svg viewBox="0 0 18 10" width="18" height="10" aria-hidden="true"><circle cx="4" cy="5" r="1.5"/><circle cx="9" cy="5" r="1.5"/><circle cx="14" cy="5" r="1.5"/></svg>';
      this.host.append(handle); this.alertHandles.set(id, handle);
    }
  }

  // ---- the "+" at the crosshair and its menu ----
  buildUi() {
    const dragPoint = this.dragPoint = document.createElement('button');
    dragPoint.type = 'button'; dragPoint.className = 'sc-lvl-drag-point'; dragPoint.hidden = true; dragPoint.tabIndex = -1;
    dragPoint.setAttribute('aria-label', 'Drag selected price');
    dragPoint.innerHTML = '<svg viewBox="0 0 18 10" width="18" height="10" aria-hidden="true"><circle cx="4" cy="5" r="1.5"/><circle cx="9" cy="5" r="1.5"/><circle cx="14" cy="5" r="1.5"/></svg>';
    const plus = this.plus = document.createElement('button');
    plus.type = 'button'; plus.className = 'sc-lvl-plus'; plus.hidden = true; plus.innerHTML = PLUS;
    plus.title = 'Order or alert at this price'; plus.setAttribute('aria-label', 'Order or alert at this price');
    const menu = this.menu = document.createElement('div');
    menu.className = 'sc-lvl-menu'; menu.hidden = true; menu.setAttribute('role', 'menu');
    this.host.append(dragPoint); this.host.append(plus);
    document.body.append(menu); // chart panes clip overflow; the menu must escape the pane
    // Android WebView does not consistently report `(pointer: coarse)`. The
    // native bridge and maxTouchPoints are more reliable signals for the app.
    this.coarseInput = !!globalThis.TradeLockApp
      || (typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || ''))
      || (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0)
      || (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);
    this.placePlus = y => {
      if (this.series.coordinateToPrice(y) == null) return;
      this.plusY = y;
      this.plus.hidden = false;
      this.plus.style.top = `${y - this.plus.offsetHeight / 2}px`;
      this.plus.style.left = `${this.chart.timeScale().width() - 32}px`;
    };
    this.placeTouch = (x, y) => {
      const price = this.series.coordinateToPrice(y);
      const time = this.chart.timeScale().coordinateToTime(x);
      if (price == null || time == null) return;
      if (activeSelection && activeSelection !== this) activeSelection.clearSelection();
      activeSelection = this;
      this.host.dataset.lvlTouchSelected = '1';
      this.placePlus(y);
      this.dragPoint.hidden = false;
      this.dragPoint.style.top = `${y - this.dragPoint.offsetHeight / 2}px`;
      this.dragPoint.style.left = '50%';
      // Only one pointer is visible at a time: the held-price action line
      // replaces the ordinary crosshair until normal chart interaction resumes.
      this.chart.clearCrosshairPosition?.();
      this.requestUpdate?.();
    };
    this.onCross = param => {
      if (this.coarseInput) return; // programmatic crosshair moves must not reveal or reposition it on phones
      if (this.drag || !this.menu.hidden || this.plusHover) return; // pointer is on the "+": keep it still
      const y = param?.point?.y, w = this.chart.timeScale().width();
      if (y == null || !param.point || param.point.x > w || this.series.coordinateToPrice(y) == null) {
        // Touch has no hover: retain the last price so the next tap can open its menu.
        if (!this.touchInput) this.plus.hidden = true;
        return;
      }
      this.placePlus(y);
    };
    this.chart.subscribeCrosshairMove(this.onCross);
  }
  openMenu() {
    this.plusHover = false; if (this.hoverLine) this.hoverLine.hidden = true;
    const price = this.series.coordinateToPrice(this.plusY);
    if (price == null) return;
    const p = toTick(price), size = this.opts.size?.(), c = this.opts.contract?.(), fmt = this.fmt(p);
    const ltp = c?.ltp, rel = ltp > 0 ? (p > ltp ? 'above' : p < ltp ? 'below' : 'at') : '';
    this.menuPrice = p;
    this.menu.innerHTML = `<div class="sc-lvl-head"><b>${fmt}</b>${rel ? `<small>${rel} LTP ${this.fmt(ltp)}</small>` : ''}</div>
      ${size ? `<button type="button" role="menuitem" data-lvl="buy" class="buy">${UP}<span>Buy limit</span><em>${size.lots} lot${size.lots === 1 ? '' : 's'} @ ${fmt}</em></button>
      <button type="button" role="menuitem" data-lvl="sell" class="sell">${DOWN}<span>Sell limit</span><em>${size.lots} lot${size.lots === 1 ? '' : 's'} @ ${fmt}</em></button>` : ''}
      <button type="button" role="menuitem" data-lvl="alert" class="alert">${BELL}<span>Alert</span><em>when ${c?.ltp > 0 && p < c.ltp ? 'falls to' : 'reaches'} ${fmt}</em></button>
      <button type="button" role="menuitem" data-lvl="hline" class="hline">${HLINE}<span>Horizontal line</span><em>draw at ${fmt}</em></button>`;
    const box = this.host.getBoundingClientRect(), screenHeight = window.innerHeight;
    this.menu.style.position = 'fixed';
    this.menu.style.left = `${Math.max(4, Math.min(box.right - 236, window.innerWidth - 232))}px`;
    this.menu.style.maxHeight = `${Math.max(120, screenHeight - 16)}px`;
    this.menu.style.overflowY = 'auto';
    this.menu.hidden = false;
    const top = Math.max(4, Math.min(box.top + this.plusY - 20, screenHeight - this.menu.offsetHeight - 4));
    this.menu.style.top = `${top}px`; this.plus.hidden = true; this.dragPoint.hidden = true;
    this.menu.querySelector('button')?.focus();
  }
  closeMenu() { this.menu.hidden = true; this.clearSelection(); }
  async run(kind, payload, key) {
    if (key) { if (this.busy.has(key)) return; this.busy.add(key); }
    try { await this.opts.act(kind, payload); } finally { if (key) this.busy.delete(key); }
  }

  lock() { if (!this.locked) { this.saved = pauseScroll(this.chart); this.locked = true; } }
  unlock() { if (this.locked) { resumeScroll(this.chart, this.saved); this.locked = false; } }
  bind() {
    const host = this.host, local = e => { const r = host.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const tol = () => this.coarseInput ? 18 : 6;
    const lineAt = y => {
      for (const o of this.orders) { const yy = this.series.priceToCoordinate(this.priceOf('order', o)); if (yy != null && Math.abs(yy - y) <= tol()) return { kind: 'order', id: o.id, price: o.price, from: o.price }; }
      for (const a of this.alerts) { const yy = this.series.priceToCoordinate(this.priceOf('alert', a)); if (yy != null && Math.abs(yy - y) <= tol()) return { kind: 'alert', id: a.id, price: a.price, from: a.price }; }
      return null;
    };
    this.on = {
      plus: e => { e.preventDefault(); e.stopPropagation(); if (this.menu.hidden) this.openMenu(); },
      menu: e => {
        const b = e.target.closest('[data-lvl]');
        if (!b) return;
        const kind = b.dataset.lvl, price = this.menuPrice;
        this.closeMenu();
        // A horizontal line is a drawing (the drawing layer), not an order or alert.
        if (kind === 'hline') { this.view.draw?.addHorizontal(price); return; }
        this.run(kind, { price }).catch(() => { /* the caller showed the error */ });
      },
      outside: e => {
        // Capture the plus before Lightweight Charts sees pointer-down. On a
        // moving crosshair the button can shift between hit-test and target
        // dispatch, so also accept its current screen rectangle.
        if (this.menu.hidden && !this.plus.hidden) {
          const r = this.plus.getBoundingClientRect?.();
          const plusHit = e.target === this.plus || this.plus.contains(e.target)
            || (r && e.clientX >= r.left - 6 && e.clientX <= r.right + 6 && e.clientY >= r.top - 6 && e.clientY <= r.bottom + 6);
          if (plusHit) {
            e.preventDefault(); e.stopImmediatePropagation(); this.openMenu(); return;
          }
        }
        if (!this.menu.hidden && !this.menu.contains(e.target) && e.target !== this.plus && !this.plus.contains(e.target)) this.closeMenu();
      },
      down: e => {
        this.touchInput = e.pointerType === 'touch';
        if ((e.button != null && e.button > 0) || e.target.closest?.('.sc-lvl-plus, .sc-lvl-menu, .sc-draw-rail, .sc-draw-sel, .sc-draw-edit')) return;
        const { x, y } = local(e), hit = this.hits.find(h => x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1);
        const alertHandle = e.target.closest?.('.sc-lvl-alert-drag');
        if (alertHandle) {
          const alert = this.alerts.find(a => String(a.id) === alertHandle.dataset.alertId);
          if (!alert) return;
          if (this.priceTouch?.holdTimer) clearTimeout(this.priceTouch.holdTimer);
          this.priceTouch = null; this.drag = { kind: 'alert', id: alert.id, price: alert.price, from: alert.price };
          this.lock(); this.plus.hidden = true; this.dragPoint.hidden = true;
          e.preventDefault(); e.stopImmediatePropagation();
          try { host.setPointerCapture(e.pointerId); } catch { /* ok */ }
          this.requestUpdate?.();
          return;
        }
        if (e.pointerType === 'touch' && e.isPrimary === false) {
          if (this.priceTouch?.holdTimer) clearTimeout(this.priceTouch.holdTimer);
          if (this.priceTouch?.selecting) this.unlock();
          this.priceTouch = null;
          return; // keep pinch zoom entirely owned by the chart
        }
        const selectedLine = e.pointerType === 'touch'
          && host.dataset.lvlTouchSelected === '1'
          && Math.abs(y - this.plusY) <= 20
          && x >= 0 && x <= this.chart.timeScale().width();
        if (selectedLine) {
          // Once marked, the mint line can be grabbed and adjusted immediately.
          this.priceTouch = { id: e.pointerId, x, y, selecting: true, moved: true };
          this.lock(); this.chart.clearCrosshairPosition?.();
          e.preventDefault(); e.stopImmediatePropagation();
          try { host.setPointerCapture(e.pointerId); } catch { /* ok */ }
          return;
        }
        if (e.pointerType === 'touch' && !hit && this.view.draw?.tool === 'cursor' && x >= 0 && x <= this.chart.timeScale().width()) {
          this.clearSelection();
          // A normal tap/swipe belongs to the chart. Claim the gesture only
          // after the finger has stayed still long enough to be a deliberate hold.
          const touch = this.priceTouch = { id: e.pointerId, x, y, selecting: false };
          touch.holdTimer = setTimeout(() => {
            if (this.priceTouch !== touch) return;
            touch.selecting = true; touch.moved = true; touch.holdTimer = null;
            this.lock();
            try { host.setPointerCapture(touch.id); } catch { /* ok */ }
            this.placeTouch(touch.x, touch.y);
          }, 700);
        }
        if (hit) {
          e.stopImmediatePropagation(); e.preventDefault();
          if (hit.act === 'cancel-order') this.run('cancel-order', { id: hit.id }, `o${hit.id}`);
          else if (hit.act === 'delete-alert') this.run('delete-alert', { id: hit.id }, `a${hit.id}`);
          return;
        }
        if (x > this.chart.timeScale().width()) return;
        const line = lineAt(y);
        if (!line) return;
        if (this.priceTouch?.holdTimer) clearTimeout(this.priceTouch.holdTimer);
        this.priceTouch = null;
        e.stopImmediatePropagation(); e.preventDefault();
        this.lock(); this.drag = line; this.plus.hidden = true; this.dragPoint.hidden = true;
        try { host.setPointerCapture(e.pointerId); } catch { /* ok */ }
        this.requestUpdate?.();
      },
      move: e => {
        const { y } = local(e);
        if (this.priceTouch && e.pointerId === this.priceTouch.id && !this.drag) {
          const { x } = local(e);
          const dx = x - this.priceTouch.x, dy = y - this.priceTouch.y;
          if (!this.priceTouch.selecting) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) <= 6) return;
            if (this.priceTouch.holdTimer) clearTimeout(this.priceTouch.holdTimer);
            this.priceTouch = null;
            return; // movement before the hold delay is ordinary chart interaction
          }
          e.preventDefault(); e.stopImmediatePropagation();
          this.priceTouch.moved = true;
          this.placeTouch(x, y);
          return;
        }
        if (this.drag) {
          e.preventDefault(); e.stopImmediatePropagation();
          const p = this.series.coordinateToPrice(y);
          if (p != null && p > 0) { this.drag.price = toTick(p); this.requestUpdate?.(); }
          return;
        }
        const over = this.hits.some(h => { const { x } = local(e); return x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1; }) ? 'pointer' : lineAt(y) ? 'ns-resize' : '';
        if (host.dataset.lvlCursor !== over) host.dataset.lvlCursor = over;
      },
      up: e => {
        if (this.priceTouch && e.pointerId === this.priceTouch.id) {
          if (this.priceTouch.holdTimer) clearTimeout(this.priceTouch.holdTimer);
          const selecting = this.priceTouch.selecting;
          if (selecting) { e.preventDefault(); e.stopImmediatePropagation(); }
          if (selecting) try { host.releasePointerCapture(e.pointerId); } catch { /* ok */ }
          this.priceTouch = null; this.unlock();
          // Lightweight Charts can restore its crosshair during pointerup.
          // Clear that delayed redraw while the mint action line is active.
          if (selecting) requestAnimationFrame(() => this.chart.clearCrosshairPosition?.());
        }
        if (!this.drag) return;
        e.preventDefault(); e.stopImmediatePropagation();
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
      leave: e => { if (this.plusHover) return; if (!this.coarseInput && e.pointerType !== 'touch' && !this.drag && this.menu.hidden) this.plus.hidden = true; },
      key: e => {
        if (!host.isConnected) { this.destroy(); return; }
        if (e.key === 'Escape') { if (!this.menu.hidden) this.closeMenu(); if (this.drag) { this.drag = null; this.unlock(); this.requestUpdate?.(); } }
      },
    };
    // Open on pointer-down so the chart cannot consume the first press and
    // move the crosshair/button before the browser emits a click.
    this.plus.addEventListener('pointerdown', this.on.plus, true);
    this.plus.addEventListener('click', this.on.plus); // keyboard activation
    // Hovering the "+" takes the pointer off the chart canvas; without this the chart hides it and the click misses.
    // While hovered, a dotted green line marks the price across the chart.
    const hoverLine = this.hoverLine = document.createElement('div');
    hoverLine.className = 'sc-lvl-hoverline'; hoverLine.hidden = true; this.host.append(hoverLine);
    this.plus.addEventListener('pointerenter', () => {
      this.plusHover = true;
      hoverLine.style.top = `${Math.round(this.plusY)}px`;
      hoverLine.style.width = `${this.chart.timeScale().width()}px`;
      hoverLine.hidden = false;
    });
    this.plus.addEventListener('pointerleave', () => { this.plusHover = false; hoverLine.hidden = true; });
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
    if (this.priceTouch?.holdTimer) clearTimeout(this.priceTouch.holdTimer);
    if (activeSelection === this) activeSelection = null;
    const host = this.host;
    try { this.chart.unsubscribeCrosshairMove(this.onCross); } catch { /* chart already removed */ }
    document.removeEventListener('pointerdown', this.on.outside, true); document.removeEventListener('keydown', this.on.key);
    host.removeEventListener('pointerdown', this.on.down, true); host.removeEventListener('pointermove', this.on.move, true);
    host.removeEventListener('pointerup', this.on.up, true); host.removeEventListener('pointercancel', this.on.up, true);
    host.removeEventListener('pointerleave', this.on.leave);
    this.plus.remove(); this.hoverLine?.remove(); this.dragPoint.remove(); this.menu.remove(); this.unlock(); this.on = null;
    for (const handle of this.alertHandles.values()) handle.remove();
    this.alertHandles.clear();
  }

  draw(target) {
    this.hits = [];
    const selectedY = this.host.dataset.lvlTouchSelected === '1' ? this.plusY : null;
    if (!this.orders.length && !this.alerts.length && selectedY == null) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const W = Math.min(mediaSize.width, this.chart.timeScale().width());
      ctx.textBaseline = 'middle';
      ctx.font = "600 11px Inter, system-ui, -apple-system, 'Segoe UI', sans-serif";
      const rr = (x, y, w, h, r) => { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); };
      if (selectedY != null) {
        ctx.save(); ctx.strokeStyle = SELECT; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
        ctx.beginPath(); ctx.moveTo(0, selectedY); ctx.lineTo(W, selectedY); ctx.stroke(); ctx.restore();
      }
      // A marker: dashed line across the pane, a pill on the LEFT (the right side belongs to positions / TP / SL),
      // with ✕ inside; the line thicker while it is being dragged.
      // A bell drawn on the canvas (an emoji would depend on the device's fonts).
      const bell = (cx, cy, color) => {
        ctx.save(); ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.5; ctx.lineJoin = 'round';
        ctx.beginPath(); ctx.moveTo(cx - 4.5, cy + 3); ctx.lineTo(cx - 4.5, cy - 1); ctx.arc(cx, cy - 1, 4.5, Math.PI, 0); ctx.lineTo(cx + 4.5, cy + 3);
        ctx.lineTo(cx + 6, cy + 4.5); ctx.lineTo(cx - 6, cy + 4.5); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.arc(cx, cy + 6, 1.6, 0, Math.PI); ctx.fill();
        ctx.restore();
      };
      const marker = (y, color, text, act, id, dragging, dash, withBell = false) => {
        ctx.strokeStyle = color; ctx.lineWidth = dragging ? 2.2 : withBell ? 1.6 : 1.2; ctx.setLineDash(dash);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); ctx.setLineDash([]);
        const iw = withBell ? 16 : 0, tw = ctx.measureText(text).width, xw = dragging ? 0 : 20, w = iw + tw + 16 + xw, x = 30;
        rr(x, y - 11, w, 22, 6); ctx.fillStyle = color; ctx.fill();
        if (withBell) bell(x + 13, y - 1, INK);
        ctx.fillStyle = INK; ctx.fillText(text, x + 8 + iw, y);
        if (!dragging) {
          const sx = x + iw + tw + 12;
          ctx.fillStyle = 'rgba(5, 18, 26, 0.35)'; ctx.fillRect(sx, y - 7, 1, 14);
          ctx.fillStyle = INK; ctx.fillText('✕', sx + 5, y);
          this.hits.push({ act, id, x0: sx - 2, x1: x + w + 2, y0: y - 13, y1: y + 13 });
        }
        // Alerts have a real DOM touch handle (touch-action:none); retain the
        // painted grip only for order lines so alerts never show two handles.
        if (!withBell) {
          ctx.fillStyle = color; rr(6, y - 4, 18, 8, 4); ctx.fill();
          ctx.fillStyle = INK; for (const gx of [11, 15, 19]) { ctx.beginPath(); ctx.arc(gx, y, 1, 0, Math.PI * 2); ctx.fill(); }
        }
      };
      for (const o of this.orders) {
        const p = this.priceOf('order', o), y = this.series.priceToCoordinate(p);
        if (y == null) continue;
        const dragging = this.drag?.kind === 'order' && this.drag.id === o.id;
        marker(y, o.side === 'BUY' ? BUY : SELL, `${o.side} LMT ${o.lots ?? o.qty}${o.lots != null ? (o.lots === 1 ? ' lot' : ' lots') : ''} @ ${this.fmt(p)}${this.busy.has(`o${o.id}`) ? '  …' : ''}`, 'cancel-order', o.id, dragging, [6, 4]);
      }
      for (const a of this.alerts) {
        const p = this.priceOf('alert', a), y = this.series.priceToCoordinate(p);
        const handle = this.alertHandles.get(String(a.id));
        if (handle) {
          handle.hidden = y == null;
          if (y != null) handle.style.top = `${y - handle.offsetHeight / 2}px`;
        }
        if (y == null) continue;
        const dragging = this.drag?.kind === 'alert' && this.drag.id === a.id;
        // Purple line with a bell: an alert is set here (✕ removes it).
        marker(y, ALERT, `ALERT ${a.dir === 'below' ? '≤' : '≥'} ${this.fmt(p)}${this.busy.has(`a${a.id}`) ? '  …' : ''}`, 'delete-alert', a.id, dragging, [8, 4], true);
      }
    });
  }
}
