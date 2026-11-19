// Power Scalper: the open position on its own chart. Entry line with live P&L, and draggable take-profit / stop-loss
// lines (each showing the P&L at that price). Dropping a line saves it: the stop-loss becomes a stop-loss order at
// the broker, the target is watched by TradeLock (server/src/modules/brackets). "+ TP" / "+ SL" on the entry label
// add one; ✕ on a line removes it.
import { pauseScroll, resumeScroll } from './scalper-chart-draw.js';

const GREEN = '#38EBB4', RED = '#FF5E7B', INK = '#05121a', AMBER = '#F7A600', BLUE = '#2962FF';
// P&L as on a broker's chart: "+9.75 INR" (two decimals, sign first).
const inr = v => `${v < 0 ? '−' : '+'}${Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} INR`;

/** P&L of a position if the price were `price`: (price − avg) × qty × rupees per point (MCX minis 10). */
export const pnlAt = (pos, price, pointValue = 1) => (price - pos.avg) * pos.qty * pointValue;
/** First TP / SL when added from the entry label: 10% of the price away from the current price, on the right side. */
export function defaultLevel(kind, { long, ltp }) {
  const away = Math.max(0.05, Math.round(ltp * 0.10 * 20) / 20);
  const up = (kind === 'tp') === long;
  return Math.round((up ? ltp + away : ltp - away) * 20) / 20;
}

export class PositionOverlay {
  constructor(view, { onSave, onError, onExit }) {
    this.view = view; this.chart = view.chart; this.series = view.candles; this.host = view.host;
    this.onSave = onSave; this.onError = onError; this.onExit = onExit; this.exitArmed = 0;
    this.pos = null; this.bracket = null; this.ltp = null; this.pointValue = 1; this.drag = null; this.saving = null; this.hits = [];
    this.paneView = { zOrder: () => 'top', renderer: () => ({ draw: target => this.draw(target) }) };
    this.series.attachPrimitive(this);
    this.bind();
  }
  attached({ requestUpdate }) { this.requestUpdate = requestUpdate; }
  detached() { this.requestUpdate = null; }
  updateAllViews() {}
  paneViews() { return [this.paneView]; }
  // The price scale always takes in the position's entry, target and stop (a Super Order's legs are often well away
  // from the candles in view): otherwise they would sit off the chart, out of sight and out of reach for dragging.
  autoscaleInfo() {
    if (!this.pos) return null;
    const lv = this.levels(), prices = [this.pos.avg, lv.tp, lv.sl].filter(p => Number.isFinite(p) && p > 0);
    return prices.length ? { priceRange: { minValue: Math.min(...prices), maxValue: Math.max(...prices) } } : null;
  }
  priceAxisViews() {
    if (!this.pos) return [];
    const out = [], add = (p, bg, fg = INK) => p != null && out.push({ coordinate: () => this.series.priceToCoordinate(p) ?? -100, text: () => this.fmt(p), textColor: () => fg, backColor: () => bg, visible: () => true, tickVisible: () => true });
    const lv = this.levels();
    add(this.pos.avg, BLUE, '#fff'); add(lv.tp, GREEN); add(lv.sl, AMBER);
    return out;
  }
  fmt(p) { try { return this.series.priceFormatter().format(p); } catch { return Number(p).toFixed(2); } }

  /** pos: { qty, avg, securityId } or null; bracket: { tp, sl, slAtBroker } or null; ltp; pointValue (MCX 10). */
  set({ pos, bracket, ltp, pointValue }) {
    const key = pos ? `${pos.securityId}:${pos.qty}:${pos.avg}` : '';
    if (key !== this.key) { this.key = key; if (!this.drag) this.saving = null; }
    this.pos = pos && pos.qty ? pos : null; this.ltp = ltp > 0 ? ltp : this.ltp; this.pointValue = pointValue || 1;
    // The server's copy wins once it has caught up with what this screen saved.
    if (!this.saving || (bracket && bracket.tp === this.saving.tp && bracket.sl === this.saving.sl) || (!bracket && this.saving.tp == null && this.saving.sl == null)) { this.bracket = bracket || null; this.saving = null; }
    if (!this.pos) { this.drag = null; this.unlock(); }
    this.requestUpdate?.();
  }
  /** A live tick (WebSocket) for this chart's contract: the entry P&L moves with every tick, not with the 2 s sync. */
  setLtp(ltp) {
    if (!(ltp > 0) || ltp === this.ltp) return;
    this.ltp = ltp;
    if (this.pos) this.requestUpdate?.();
  }
  /** What is on screen: a drag in progress, else what is being saved, else the saved bracket. */
  levels() {
    const b = this.saving || this.bracket || {};
    return { tp: this.drag?.kind === 'tp' ? this.drag.price : b.tp ?? null, sl: this.drag?.kind === 'sl' ? this.drag.price : b.sl ?? null };
  }
  save(tp, sl) {
    if (!this.pos) return;
    this.saving = { tp, sl, slAtBroker: false };
    this.requestUpdate?.();
    Promise.resolve(this.onSave({ securityId: this.pos.securityId, tp, sl })).catch(e => { this.saving = null; this.requestUpdate?.(); this.onError?.(e); });
  }

  lock() { if (!this.locked) { this.saved = pauseScroll(this.chart); this.locked = true; } }
  unlock() { if (this.locked) { resumeScroll(this.chart, this.saved); this.locked = false; } }
  bind() {
    const host = this.host, local = e => { const r = host.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const coarse = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    this.on = {
      down: e => {
        if (!this.pos || (e.button != null && e.button > 0) || e.target.closest?.('.sc-draw-rail, .sc-draw-sel, .sc-draw-edit')) return;
        const { x, y } = local(e), hit = this.hits.find(h => x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1);
        const lv = this.levels(), tol = coarse() ? 12 : 6;
        if (hit) {
          e.stopImmediatePropagation(); e.preventDefault();
          if (hit.act === 'add-tp' || hit.act === 'add-sl') {
            const kind = hit.act.slice(4), lvl = defaultLevel(kind, { long: this.pos.qty > 0, ltp: this.ltp || this.pos.avg });
            this.save(kind === 'tp' ? lvl : lv.tp, kind === 'sl' ? lvl : lv.sl);
          } else if (hit.act === 'del-tp') this.save(null, lv.sl);
          else if (hit.act === 'del-sl') this.save(lv.tp, null);
          else if (hit.act === 'exit') {
            // ✕ on the entry closes the position at market: the first click arms it ("Exit?"), a second within 4 s sends it.
            if (Date.now() - this.exitArmed > 4000) { this.exitArmed = Date.now(); setTimeout(() => this.requestUpdate?.(), 4100); }
            else { this.exitArmed = 0; Promise.resolve(this.onExit?.(this.pos)).catch(err => this.onError?.(err)); }
            this.requestUpdate?.();
          }
          return;
        }
        const yt = lv.tp != null ? this.series.priceToCoordinate(lv.tp) : null, ys = lv.sl != null ? this.series.priceToCoordinate(lv.sl) : null;
        const kind = yt != null && Math.abs(y - yt) <= tol ? 'tp' : ys != null && Math.abs(y - ys) <= tol ? 'sl' : null;
        if (!kind || x > this.chart.timeScale().width()) return;
        e.stopImmediatePropagation(); e.preventDefault();
        this.lock();
        this.drag = { kind, price: kind === 'tp' ? lv.tp : lv.sl, from: kind === 'tp' ? lv.tp : lv.sl };
        try { host.setPointerCapture(e.pointerId); } catch { /* ok */ }
        this.requestUpdate?.();
      },
      move: e => {
        const { x, y } = local(e);
        if (this.drag) {
          const p = this.series.coordinateToPrice(y);
          if (p != null && p > 0) { this.drag.price = Math.round(p * 20) / 20; this.requestUpdate?.(); }
          return;
        }
        if (!this.pos) return;
        const lv = this.levels(), over = this.hits.some(h => x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1) ? 'pointer'
          : [lv.tp, lv.sl].some(p => p != null && Math.abs(this.series.priceToCoordinate(p) - y) <= 6) ? 'ns-resize' : '';
        if (host.dataset.posCursor !== over) host.dataset.posCursor = over;
      },
      up: e => {
        if (!this.drag) return;
        const d = this.drag; this.drag = null;
        try { host.releasePointerCapture(e.pointerId); } catch { /* ok */ }
        this.unlock();
        if (d.price === d.from) { this.requestUpdate?.(); return; }
        const lv = this.levels();
        this.save(d.kind === 'tp' ? d.price : lv.tp, d.kind === 'sl' ? d.price : lv.sl);
      },
      key: e => {
        if (!host.isConnected) { this.destroy(); return; }
        if (e.key === 'Escape' && this.drag) { this.drag = null; this.unlock(); this.requestUpdate?.(); }
      },
    };
    // Registered before the drawing layer's listeners on the same element: a TP / SL line wins over a drawing.
    host.addEventListener('pointerdown', this.on.down, true);
    host.addEventListener('pointermove', this.on.move, true);
    host.addEventListener('pointerup', this.on.up, true);
    host.addEventListener('pointercancel', this.on.up, true);
    document.addEventListener('keydown', this.on.key);
  }
  destroy() {
    if (!this.on) return;
    const host = this.host;
    host.removeEventListener('pointerdown', this.on.down, true); host.removeEventListener('pointermove', this.on.move, true);
    host.removeEventListener('pointerup', this.on.up, true); host.removeEventListener('pointercancel', this.on.up, true);
    document.removeEventListener('keydown', this.on.key);
    this.unlock(); this.on = null;
  }

  draw(target) {
    this.hits = [];
    const pos = this.pos;
    if (!pos) return;
    const yE = this.series.priceToCoordinate(pos.avg);
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const W = Math.min(mediaSize.width, this.chart.timeScale().width());
      ctx.textBaseline = 'middle';
      const font = (s, w = 600) => { ctx.font = `${w} ${s}px Inter, system-ui, -apple-system, 'Segoe UI', sans-serif`; };
      const rr = (x, y, w, h, r) => { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); };
      const line = (y, color, dash, width = 1.5) => { ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); ctx.setLineDash([]); };
      // A label pill at the right of the pane, with optional chip buttons after it (drawn right to left).
      const label = (y, parts, chips = []) => {
        font(11);
        let x = W - 8;
        for (const c of [...chips].reverse()) {
          const w = ctx.measureText(c.text).width + 12;
          // A solid base under the tint: the entry line must not show through the button text.
          x -= w; rr(x, y - 10, w, 20, 5); ctx.fillStyle = 'rgb(8, 13, 21)'; ctx.fill(); ctx.fillStyle = c.bg; ctx.fill();
          ctx.fillStyle = c.fg; ctx.fillText(c.text, x + 6, y);
          this.hits.push({ act: c.act, x0: x - 2, x1: x + w + 2, y0: y - 12, y1: y + 12 });
          x -= 4;
        }
        // A part with `act` is a button inside the pill (the ✕): a hairline divider before it and a wider hit area.
        const widths = parts.map(p => ctx.measureText(p.text).width + (p.act ? 16 : 0));
        const tw = widths.reduce((a, w) => a + w, 0) + 14;
        x -= tw; rr(x, y - 11, tw, 22, 6); ctx.fillStyle = parts.bg; ctx.fill();
        if (parts.ring) { ctx.strokeStyle = parts.ring; ctx.lineWidth = 1; ctx.stroke(); }
        let tx = x + 7;
        parts.forEach((p, i) => {
          if (p.act) {
            ctx.fillStyle = p.divider || 'rgba(5, 18, 26, 0.35)'; ctx.fillRect(tx + 4, y - 7, 1, 14);
            ctx.fillStyle = p.color; ctx.fillText(p.text, tx + 11, y);
            this.hits.push({ act: p.act, x0: tx + 2, x1: x + tw + 2, y0: y - 13, y1: y + 13 });
          } else { ctx.fillStyle = p.color; ctx.fillText(p.text, tx, y); }
          tx += widths[i];
        });
      };
      // A broker-style order label at the right of the pane: cells side by side in one bordered box, e.g.
      // [TP][SL][ 65 ][ +9.75 INR ][ ✕ ]. Cells: { text, fg, bg?, act?, bold? }; drawn right to left from the pane edge.
      const box = (y, cells, ring) => {
        font(11, 700);
        const pad = 7, h = 20, ws = cells.map(c => ctx.measureText(c.text).width + pad * 2);
        let x = W - 8 - ws.reduce((a, w) => a + w, 0);
        const x0 = x;
        rr(x0, y - h / 2, W - 8 - x0, h, 4); ctx.fillStyle = 'rgb(8, 13, 21)'; ctx.fill();
        cells.forEach((c, i) => {
          const w = ws[i];
          if (c.bg) { ctx.fillStyle = c.bg; ctx.fillRect(x, y - h / 2, w, h); }
          if (i) { ctx.fillStyle = ring; ctx.globalAlpha = 0.45; ctx.fillRect(x, y - h / 2 + 3, 1, h - 6); ctx.globalAlpha = 1; }
          ctx.fillStyle = c.fg; ctx.fillText(c.text, x + pad, y + 0.5);
          if (c.act) this.hits.push({ act: c.act, x0: x, x1: x + w, y0: y - 13, y1: y + 13 });
          x += w;
        });
        rr(x0, y - h / 2, W - 8 - x0, h, 4); ctx.strokeStyle = ring; ctx.lineWidth = 1; ctx.stroke();
      };
      const long = pos.qty > 0, ltp = this.ltp, live = ltp ? pnlAt(pos, ltp, this.pointValue) : null, lv = this.levels();
      const qtyText = String(Math.abs(pos.qty));
      // Entry: TP / SL (tap to add one while it is not set) · quantity · live P&L · ✕ close the position.
      if (yE != null) {
        line(yE, BLUE, [5, 4], 1.2);
        const armed = Date.now() - this.exitArmed <= 4000;
        // A Dhan Super Order position: a leg removed at Dhan cannot be added back, so its chip stays dim.
        // TP / SL buttons only while that level can still be added (a set level has its own line; dim chips read as extra orders).
        const canAdd = k => lv[k] == null && !this.bracket?.super;
        box(yE, [
          ...(canAdd('tp') ? [{ text: 'TP', fg: GREEN, act: 'add-tp' }] : []),
          ...(canAdd('sl') ? [{ text: 'SL', fg: AMBER, act: 'add-sl' }] : []),
          { text: qtyText, fg: '#fff', bg: BLUE },
          { text: live == null ? '—' : inr(live), fg: live == null ? '#E8EEF7' : live >= 0 ? GREEN : RED },
          armed ? { text: 'Exit?', fg: '#fff', bg: RED, act: 'exit' } : { text: '✕', fg: '#E8EEF7', act: 'exit' },
        ], BLUE);
      }
      for (const kind of ['tp', 'sl']) {
        const price = lv[kind];
        if (price == null) continue;
        const y = this.series.priceToCoordinate(price);
        if (y == null) continue;
        const color = kind === 'tp' ? GREEN : AMBER, dragging = this.drag?.kind === kind, pnl = pnlAt(pos, price, this.pointValue);
        if (yE != null) { ctx.fillStyle = kind === 'tp' ? 'rgba(56, 235, 180, 0.07)' : 'rgba(247, 166, 0, 0.07)'; ctx.fillRect(0, Math.min(y, yE), W, Math.abs(y - yE)); }
        line(y, color, [], dragging ? 2.2 : 1.4);
        const pending = this.saving && !dragging;
        // TP / SL: the kind (coloured cell) · quantity · P&L at that price · ✕ remove (not while dragging / saving).
        const cells = [{ text: kind === 'tp' ? 'TP' : 'SL', fg: INK, bg: color }, { text: qtyText, fg: '#fff', bg: BLUE },
          { text: pending ? 'saving…' : inr(pnl), fg: pnl >= 0 ? GREEN : RED }];
        if (!dragging && !pending) cells.push({ text: '✕', fg: '#E8EEF7', act: `del-${kind}` });
        box(y, cells, color);
        // Grip: a small handle at the left shows the line can be dragged.
        ctx.fillStyle = color; rr(6, y - 4, 18, 8, 4); ctx.fill();
        ctx.fillStyle = INK; for (const gx of [11, 15, 19]) { ctx.beginPath(); ctx.arc(gx, y, 1, 0, Math.PI * 2); ctx.fill(); }
      }
    });
  }
}
