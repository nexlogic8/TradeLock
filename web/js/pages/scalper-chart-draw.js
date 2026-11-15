// Power Scalper: TradingView-style drawing tools on the lightweight-charts candles (one layer per chart).
// Trend line, ray, extended line, arrow, horizontal line / ray, vertical line, rectangle, Fibonacci retracement,
// long / short position (risk : reward), measure and text. Select, drag handles, move, recolour, delete, undo,
// magnet (snap to the candle's open / high / low / close). Drawings are kept per contract in this browser.
// Points are stored as { t: unix seconds, p: price }: they stay on the same candle at any interval and zoom.
import { chartPalette } from './chart-palette.js';

const svg = body => `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICONS = {
  cursor: svg('<path d="M5 3l11 6.2-4.6 1.4L9.6 15z"/>'),
  trend: svg('<path d="M4 16L16 4"/><circle cx="4" cy="16" r="1.8"/><circle cx="16" cy="4" r="1.8"/>'),
  ray: svg('<circle cx="4" cy="15" r="1.8"/><path d="M5.5 13.8L17.5 4.2M17.5 4.2l-4 .5M17.5 4.2l-.6 3.9"/>'),
  ext: svg('<path d="M2 17.5L18 2.5"/><circle cx="7" cy="12.8" r="1.6"/><circle cx="13" cy="7.2" r="1.6"/>'),
  arrow: svg('<path d="M4 16L16 4M16 4h-6M16 4v6"/>'),
  hline: svg('<path d="M2 10h16"/><circle cx="10" cy="10" r="1.8"/>'),
  hray: svg('<circle cx="4" cy="10" r="1.8"/><path d="M5.8 10H18"/>'),
  vline: svg('<path d="M10 2v16"/><circle cx="10" cy="10" r="1.8"/>'),
  rect: svg('<rect x="3.5" y="5" width="13" height="10" rx="1.2"/>'),
  fib: svg('<path d="M3 4h14M3 8h10M3 12h12M3 16h14"/>'),
  long: svg('<rect x="4" y="3" width="12" height="7" rx="1" fill="rgba(56,235,180,.25)"/><rect x="4" y="10" width="12" height="7" rx="1" fill="rgba(255,94,123,.25)"/><path d="M4 10h12"/>'),
  short: svg('<rect x="4" y="3" width="12" height="7" rx="1" fill="rgba(255,94,123,.25)"/><rect x="4" y="10" width="12" height="7" rx="1" fill="rgba(56,235,180,.25)"/><path d="M4 10h12"/>'),
  measure: svg('<path d="M10 3v14M7 6l3-3 3 3M7 14l3 3 3-3"/><path d="M4 3h12M4 17h12" opacity=".5"/>'),
  text: svg('<path d="M5 5h10M10 5v11M7.5 16h5"/>'),
  magnet: svg('<path d="M5 3v7a5 5 0 0010 0V3"/><path d="M5 6h3M12 6h3"/>'),
  eye: svg('<path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10z"/><circle cx="10" cy="10" r="2.4"/>'),
  eyeOff: svg('<path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10z"/><path d="M3 17L17 3"/>'),
  undo: svg('<path d="M7 6L3.5 9.5 7 13"/><path d="M4 9.5h7.5a4.5 4.5 0 010 9H9"/>'),
  trash: svg('<path d="M4 6h12M8 6V4h4v2M6 6l.8 10.5h6.4L14 6"/>'),
  pencil: svg('<path d="M13.5 3.5l3 3L7 16H4v-3z"/><path d="M11.5 5.5l3 3"/>'),
  close: svg('<path d="M5 5l10 10M15 5L5 15"/>'),
};

export const DRAW_TOOLS = [
  ['cursor', 'Select and move (Esc)'],
  ['trend', 'Trend line'], ['ray', 'Ray'], ['ext', 'Extended line'], ['arrow', 'Arrow'],
  ['hline', 'Horizontal line'], ['hray', 'Horizontal ray'], ['vline', 'Vertical line'],
  ['rect', 'Rectangle'], ['fib', 'Fib retracement'],
  ['long', 'Long position (risk : reward)'], ['short', 'Short position (risk : reward)'],
  ['measure', 'Measure (price, %, bars, time)'], ['text', 'Text'],
];
const POINTS = { trend:2, ray:2, ext:2, arrow:2, rect:2, fib:2, measure:2, hline:1, hray:1, vline:1, long:1, short:1, text:1 };
export const DRAW_COLORS = ['#5AB8FF', '#38EBB4', '#FF5E7B', '#FFBA52', '#B48CFF', '#E8EEF7'];
const DEFAULT_COLOR = { hline:'#FFBA52', hray:'#FFBA52', vline:'#94A3B8', rect:'#B48CFF', fib:'#FFBA52', measure:'#5AB8FF', text:'#E8EEF7' };
export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const STORE = 'tradelock.scalper.draw.v1.';
const pref = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v === '1'; } catch { return d; } };
const savePref = (k, v) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch { /* private window */ } };
const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`; };
const clone = o => JSON.parse(JSON.stringify(o));
const uid = () => Math.random().toString(36).slice(2, 10);

/** Distance from (px, py) to segment a-b (or the whole line / ray when extended). */
export function distToLine(px, py, ax, ay, bx, by, mode = 'segment') {
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  if (!len2) return Math.hypot(px - ax, py - ay);
  let u = ((px - ax) * dx + (py - ay) * dy) / len2;
  if (mode === 'segment') u = Math.max(0, Math.min(1, u)); else if (mode === 'ray') u = Math.max(0, u);
  return Math.hypot(px - (ax + u * dx), py - (ay + u * dy));
}

/** Long / short position numbers: reward, risk, ratio and % moves from the entry. */
export function positionStats(d) {
  const e = d.pts[0].p, long = d.type === 'long', reward = long ? d.target - e : e - d.target, risk = long ? e - d.stop : d.stop - e;
  return { reward, risk, rr: risk > 0 ? reward / risk : 0, targetPct: (d.target - e) / e * 100, stopPct: (d.stop - e) / e * 100 };
}

/** Bar index (fractional, beyond the ends by the bar step) of a time, and back: keeps points on their candle. */
export function logicalOfTime(times, step, t) {
  const n = times.length;
  if (!n) return null;
  if (t <= times[0]) return (t - times[0]) / step;
  if (t >= times[n - 1]) return n - 1 + (t - times[n - 1]) / step;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (times[m] <= t) lo = m; else hi = m; }
  return lo + (t - times[lo]) / (times[hi] - times[lo]);
}
export function timeOfLogical(times, step, l) {
  const n = times.length;
  if (!n) return null;
  if (l <= 0) return times[0] + l * step;
  if (l >= n - 1) return times[n - 1] + (l - (n - 1)) * step;
  const i = Math.floor(l);
  return times[i] + (l - i) * (times[i + 1] - times[i]);
}

export class DrawingLayer {
  constructor(view) {
    this.view = view; this.chart = view.chart; this.series = view.candles; this.host = view.host;
    this.items = []; this.sel = null; this.tool = 'cursor'; this.creating = null; this.drag = null; this.history = [];
    this.times = []; this.step = 60; this.key = null;
    this.magnet = pref('tradelock.scalper.draw.magnet', false); this.hidden = false;
    this.paneView = { zOrder: () => 'top', renderer: () => ({ draw: target => this.draw(target) }) };
    this.series.attachPrimitive(this);
    this.buildBar(); this.bind();
  }
  // ---- lightweight-charts primitive ----
  attached({ requestUpdate }) { this.requestUpdate = requestUpdate; }
  detached() { this.requestUpdate = null; }
  updateAllViews() {}
  paneViews() { return [this.paneView]; }
  priceAxisViews() {
    if (this.hidden) return [];
    const out = [], label = (p, color) => out.push({ coordinate: () => this.series.priceToCoordinate(p) ?? -100, text: () => this.fmt(p), textColor: () => '#05121a', backColor: () => color, visible: () => true, tickVisible: () => true });
    for (const d of this.items) {
      if (d.type === 'hline' || d.type === 'hray') label(d.pts[0].p, d.color);
      else if (d === this.sel) {
        if (d.type === 'long' || d.type === 'short') { label(d.pts[0].p, '#94A3B8'); label(d.target, '#38EBB4'); label(d.stop, '#FF5E7B'); }
        else if (d.type !== 'vline') for (const pt of d.pts) label(pt.p, d.color);
      }
    }
    return out;
  }
  update() { this.requestUpdate?.(); this.paintSelBar(); }
  fmt(p) { try { return this.series.priceFormatter().format(p); } catch { return Number(p).toFixed(2); } }

  // ---- data, storage ----
  setBars(bars) {
    this.bars = bars || []; this.times = this.bars.map(b => b.time);
    const n = this.times.length, diffs = [];
    for (let i = Math.max(1, n - 60); i < n; i++) diffs.push(this.times[i] - this.times[i - 1]);
    diffs.sort((a, b) => a - b);
    this.step = diffs.length ? diffs[diffs.length >> 1] || 60 : 60;
    this.requestUpdate?.();
  }
  setKey(id) {
    const key = id ? STORE + id : null;
    if (key === this.key) return;
    this.key = key; this.sel = null; this.creating = null; this.history = [];
    try { this.items = key ? JSON.parse(localStorage.getItem(key) || '[]') : []; } catch { this.items = []; }
    if (!Array.isArray(this.items)) this.items = [];
    this.update();
  }
  save() {
    if (!this.key) return;
    try { if (this.items.length) localStorage.setItem(this.key, JSON.stringify(this.items)); else localStorage.removeItem(this.key); } catch { /* storage full or blocked */ }
  }
  snapshot() { this.history.push(JSON.stringify(this.items)); if (this.history.length > 40) this.history.shift(); }
  undo() {
    const prev = this.history.pop();
    if (prev == null) return;
    this.items = JSON.parse(prev); this.sel = null; this.save(); this.update();
  }

  // ---- coordinates (CSS pixels in the main pane) ----
  x(t) { const l = logicalOfTime(this.times, this.step, t); return l == null ? null : this.chart.timeScale().logicalToCoordinate(l); }
  y(p) { return this.series.priceToCoordinate(p); }
  paneSize() {
    const w = this.chart.timeScale().width();
    let h = this.host.clientHeight - 28;
    try { h = this.chart.panes()[0].getHeight(); } catch { /* older API */ }
    return { w, h };
  }
  fromXY(x, y, snap = this.magnet) {
    const l = this.chart.timeScale().coordinateToLogical(x), p = this.series.coordinateToPrice(y);
    if (l == null || p == null) return null;
    if (snap && this.bars?.length) {
      const i = Math.max(0, Math.min(this.bars.length - 1, Math.round(l))), b = this.bars[i];
      let best = null, gap = 28;
      for (const v of [b.open, b.high, b.low, b.close]) { const yy = this.y(v); if (yy != null && Math.abs(yy - y) < gap) { gap = Math.abs(yy - y); best = v; } }
      if (best != null) return { t: b.time, p: best };
    }
    return { t: Math.round(timeOfLogical(this.times, this.step, l)), p };
  }

  // ---- toolbar ----
  buildBar() {
    const bar = this.bar = document.createElement('div');
    bar.className = 'sc-draw'; bar.dataset.open = pref('tradelock.scalper.draw.open', false) ? '1' : '0';
    bar.innerHTML = `<button type="button" class="sc-draw-toggle" data-draw-toggle title="Drawing tools" aria-label="Drawing tools">${ICONS.pencil}</button>
      <div class="sc-draw-tools" role="toolbar" aria-label="Drawing tools">
        ${DRAW_TOOLS.map(([k, t]) => `<button type="button" data-draw-tool="${k}" title="${t}" aria-label="${t}" aria-pressed="${k === 'cursor'}">${ICONS[k]}</button>`).join('')}
        <i class="sc-draw-sep"></i>
        <button type="button" data-draw-act="magnet" title="Magnet: snap to open / high / low / close" aria-pressed="${this.magnet}">${ICONS.magnet}</button>
        <button type="button" data-draw-act="hide" title="Hide drawings" aria-pressed="false">${ICONS.eye}</button>
        <button type="button" data-draw-act="undo" title="Undo (Ctrl+Z)">${ICONS.undo}</button>
        <button type="button" data-draw-act="clear" title="Remove all drawings on this chart">${ICONS.trash}</button>
      </div>`;
    const sel = this.selBar = document.createElement('div');
    sel.className = 'sc-draw-sel'; sel.hidden = true;
    sel.innerHTML = `${DRAW_COLORS.map(c => `<button type="button" class="sc-draw-swatch" data-draw-color="${c}" style="--c:${c}" title="Colour" aria-label="Colour ${c}"></button>`).join('')}
      <i class="sc-draw-sep"></i>
      ${[1, 2, 3].map(w => `<button type="button" class="sc-draw-width" data-draw-width="${w}" title="Line width ${w}" aria-label="Line width ${w}"><i style="height:${w + 0.5}px"></i></button>`).join('')}
      <i class="sc-draw-sep"></i>
      <button type="button" data-draw-act="delete" title="Delete (Del)" aria-label="Delete drawing">${ICONS.trash}</button>`;
    this.host.append(bar, sel);
  }
  setTool(tool) {
    this.cancelCreate();
    this.tool = tool;
    for (const b of this.bar.querySelectorAll('[data-draw-tool]')) b.setAttribute('aria-pressed', String(b.dataset.drawTool === tool));
    this.host.classList.toggle('sc-drawing', tool !== 'cursor');
    if (tool === 'cursor') this.unlock(); else { this.lock(); this.sel = null; this.update(); }
  }
  paintSelBar() {
    const d = this.sel;
    this.selBar.hidden = !d || this.hidden;
    if (!d) return;
    for (const b of this.selBar.querySelectorAll('[data-draw-color]')) b.setAttribute('aria-pressed', String(b.dataset.drawColor === d.color));
    for (const b of this.selBar.querySelectorAll('[data-draw-width]')) { b.setAttribute('aria-pressed', String(Number(b.dataset.drawWidth) === (d.width || 2))); b.hidden = d.type === 'text'; }
  }

  // ---- chart scrolling is paused while drawing or dragging, so the pointer moves the drawing ----
  lock() {
    if (this.locked) return;
    const o = this.chart.options();
    this.saved = { handleScroll: o.handleScroll, handleScale: o.handleScale };
    this.chart.applyOptions({ handleScroll: false, handleScale: false });
    this.locked = true;
  }
  unlock() {
    if (!this.locked || this.tool !== 'cursor' || this.drag || this.creating) return;
    this.chart.applyOptions(this.saved);
    this.locked = false;
  }

  // ---- pointer and keyboard ----
  bind() {
    const host = this.host, local = e => { const r = host.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const onUi = e => e.target.closest?.('.sc-draw, .sc-draw-sel, .sc-draw-edit');
    this.on = {
      down: e => {
        if (onUi(e) || this.hidden || (e.button != null && e.button > 0)) return;
        const { x, y } = local(e), { w, h } = this.paneSize();
        if (x < 0 || y < 0 || x > w || y > h) return;
        this.downAt = { x, y };
        if (this.tool !== 'cursor') { e.stopPropagation(); e.preventDefault(); this.press(x, y, e); return; }
        const handle = this.sel && this.hitHandle(this.sel, x, y);
        const item = handle ? this.sel : this.hitItem(x, y);
        if (!item) { if (this.sel) { this.sel = null; this.update(); } return; }
        e.stopPropagation();
        this.lock(); this.snapshot(); this.sel = item;
        this.drag = handle ? { handle } : { item, orig: clone(item), l0: this.chart.timeScale().coordinateToLogical(x), p0: this.series.coordinateToPrice(y) };
        try { host.setPointerCapture(e.pointerId); } catch { /* not all pointers */ }
        this.update();
      },
      move: e => {
        if (!this.creating && !this.drag) { if (this.tool === 'cursor' && !this.hidden) this.hover(e); return; }
        const { x, y } = local(e);
        if (this.creating) { const pt = this.fromXY(x, y); if (pt) { this.creating.item.pts[1] = pt; this.creating.moved ||= Math.hypot(x - this.downAt.x, y - this.downAt.y) > 6; this.update(); } return; }
        if (this.drag.handle) { const pt = this.fromXY(x, y); if (pt) { this.drag.handle.apply(pt); this.update(); } return; }
        const l = this.chart.timeScale().coordinateToLogical(x), p = this.series.coordinateToPrice(y);
        if (l == null || p == null || this.drag.l0 == null || this.drag.p0 == null) return;
        this.moveFrom(this.drag.item, this.drag.orig, l - this.drag.l0, p - this.drag.p0); this.update();
      },
      up: e => {
        if (this.creating?.moved) { this.finish(); return; }
        if (this.drag) { this.drag = null; this.save(); this.unlock(); this.update(); try { host.releasePointerCapture(e.pointerId); } catch { /* ok */ } }
      },
      dbl: e => {
        if (this.tool !== 'cursor' || onUi(e)) return;
        const { x, y } = local(e), d = this.hitItem(x, y);
        if (d?.type === 'text') { e.stopPropagation(); this.editText(d); }
      },
      key: e => {
        if (!host.isConnected) { this.destroy(); return; }
        if (e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
        if (e.key === 'Escape' && (this.creating || this.tool !== 'cursor' || this.sel)) { this.setTool('cursor'); this.sel = null; this.update(); }
        else if ((e.key === 'Delete' || e.key === 'Backspace') && this.sel) { e.preventDefault(); this.remove(this.sel); }
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && this.history.length && (this.sel || host.matches(':hover'))) { e.preventDefault(); this.undo(); }
      },
      click: e => {
        const tool = e.target.closest('[data-draw-tool]'), act = e.target.closest('[data-draw-act]'), color = e.target.closest('[data-draw-color]'), width = e.target.closest('[data-draw-width]');
        if (e.target.closest('[data-draw-toggle]')) { const open = this.bar.dataset.open !== '1'; this.bar.dataset.open = open ? '1' : '0'; savePref('tradelock.scalper.draw.open', open); if (!open) this.setTool('cursor'); return; }
        if (tool) { this.setTool(tool.dataset.drawTool === this.tool ? 'cursor' : tool.dataset.drawTool); return; }
        if (color && this.sel) { this.snapshot(); this.sel.color = color.dataset.drawColor; this.save(); this.update(); return; }
        if (width && this.sel) { this.snapshot(); this.sel.width = Number(width.dataset.drawWidth); this.save(); this.update(); return; }
        if (!act) return;
        const a = act.dataset.drawAct;
        if (a === 'magnet') { this.magnet = !this.magnet; savePref('tradelock.scalper.draw.magnet', this.magnet); act.setAttribute('aria-pressed', String(this.magnet)); }
        else if (a === 'hide') { this.hidden = !this.hidden; act.setAttribute('aria-pressed', String(this.hidden)); act.innerHTML = this.hidden ? ICONS.eyeOff : ICONS.eye; act.title = this.hidden ? 'Show drawings' : 'Hide drawings'; if (this.hidden) this.setTool('cursor'); this.update(); }
        else if (a === 'undo') this.undo();
        else if (a === 'delete' && this.sel) this.remove(this.sel);
        else if (a === 'clear' && this.items.length) {
          // Two taps: the first arms it (red), the second removes everything on this chart.
          if (act.dataset.armed !== '1') { act.dataset.armed = '1'; act.title = 'Tap again to remove all'; clearTimeout(this.armTimer); this.armTimer = setTimeout(() => { act.dataset.armed = '0'; act.title = 'Remove all drawings on this chart'; }, 2500); return; }
          act.dataset.armed = '0'; this.snapshot(); this.items = []; this.sel = null; this.save(); this.update();
        }
      },
    };
    host.addEventListener('pointerdown', this.on.down, true);
    host.addEventListener('pointermove', this.on.move, true);
    host.addEventListener('pointerup', this.on.up, true);
    host.addEventListener('pointercancel', this.on.up, true);
    host.addEventListener('dblclick', this.on.dbl, true);
    this.bar.addEventListener('click', this.on.click);
    this.selBar.addEventListener('click', this.on.click);
    document.addEventListener('keydown', this.on.key);
  }
  destroy() {
    if (!this.on) return;
    const host = this.host;
    host.removeEventListener('pointerdown', this.on.down, true); host.removeEventListener('pointermove', this.on.move, true);
    host.removeEventListener('pointerup', this.on.up, true); host.removeEventListener('pointercancel', this.on.up, true);
    host.removeEventListener('dblclick', this.on.dbl, true); document.removeEventListener('keydown', this.on.key);
    this.bar.remove(); this.selBar.remove(); this.edit?.remove(); this.on = null;
  }
  hover(e) {
    const r = this.host.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const over = (this.sel && this.hitHandle(this.sel, x, y)) ? 'grab' : this.hitItem(x, y) ? 'move' : '';
    if (this.host.dataset.drawCursor !== over) this.host.dataset.drawCursor = over;
  }

  // ---- create ----
  press(x, y) {
    const pt = this.fromXY(x, y);
    if (!pt) return;
    if (this.creating) { this.creating.item.pts[1] = pt; this.finish(); return; }   // second click of a two-point tool
    const type = this.tool, d = { id: uid(), type, color: DEFAULT_COLOR[type] || '#5AB8FF', width: 2, pts: [pt] };
    this.snapshot();
    if (POINTS[type] === 2) { d.pts.push({ ...pt }); this.items.push(d); this.creating = { item: d, moved: false }; this.update(); return; }
    if (type === 'long' || type === 'short') {
      // Default box: risk 40 px of price below (long) / above (short) the entry, reward twice that, 15 bars wide.
      const risk = Math.abs((this.series.coordinateToPrice(y + 40) ?? pt.p * 0.99) - pt.p) || pt.p * 0.01, s = type === 'long' ? 1 : -1;
      Object.assign(d, { stop: pt.p - s * risk, target: pt.p + s * 2 * risk, t2: Math.round(timeOfLogical(this.times, this.step, logicalOfTime(this.times, this.step, pt.t) + 15)) });
    }
    if (type === 'text') d.text = '';
    this.items.push(d); this.sel = d;
    this.setTool('cursor'); this.save(); this.update();
    if (type === 'text') this.editText(d);
  }
  finish() {
    const d = this.creating?.item;
    this.creating = null;
    if (d) {
      const [a, b] = d.pts, xa = this.x(a.t), xb = this.x(b.t), ya = this.y(a.p), yb = this.y(b.p);
      if (xa != null && xb != null && ya != null && yb != null && Math.hypot(xb - xa, yb - ya) < 4) this.items = this.items.filter(i => i !== d);   // a stray tap
      else this.sel = d;
    }
    this.setTool('cursor'); this.save(); this.update();
  }
  cancelCreate() {
    if (!this.creating) return;
    this.items = this.items.filter(i => i !== this.creating.item); this.creating = null; this.history.pop(); this.update();
  }
  remove(d) { this.snapshot(); this.items = this.items.filter(i => i !== d); if (this.sel === d) this.sel = null; this.save(); this.update(); }
  editText(d) {
    this.edit?.remove();
    const x = this.x(d.pts[0].t), y = this.y(d.pts[0].p);
    if (x == null || y == null) return;
    const input = this.edit = document.createElement('input');
    input.className = 'sc-draw-edit'; input.value = d.text || ''; input.placeholder = 'Text'; input.maxLength = 120;
    input.style.left = `${Math.max(4, x)}px`; input.style.top = `${Math.max(4, y - 14)}px`;
    let done = false;
    const commit = keep => {
      if (done) return; done = true;
      const text = input.value.trim(); input.remove(); this.edit = null;
      if (!keep && !d.text) { this.items = this.items.filter(i => i !== d); this.sel = null; }
      else if (keep) { if (text) d.text = text; else { this.items = this.items.filter(i => i !== d); this.sel = null; } }
      this.save(); this.update();
    };
    input.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') commit(true); else if (e.key === 'Escape') commit(false); });
    input.addEventListener('blur', () => commit(true));
    this.host.append(input); input.focus(); input.select();
  }

  // ---- edit ----
  moveFrom(d, orig, dl, dp) {
    const shift = t => Math.round(timeOfLogical(this.times, this.step, logicalOfTime(this.times, this.step, t) + dl));
    d.pts = orig.pts.map(pt => ({ t: d.type === 'hline' ? pt.t : shift(pt.t), p: d.type === 'vline' ? pt.p : pt.p + dp }));
    if (orig.t2 != null) d.t2 = shift(orig.t2);
    if (orig.stop != null) { d.stop = orig.stop + dp; d.target = orig.target + dp; }
  }
  handles(d) {
    const P = d.pts, { w, h } = this.paneSize(), at = (t, p) => ({ x: this.x(t), y: this.y(p) });
    const H = (pos, apply) => ({ ...pos, apply });
    switch (d.type) {
      case 'hline': return [H({ x: w / 2, y: this.y(P[0].p) }, pt => { P[0].p = pt.p; })];
      case 'vline': return [H({ x: this.x(P[0].t), y: h / 2 }, pt => { P[0].t = pt.t; })];
      case 'hray': case 'text': return [H(at(P[0].t, P[0].p), pt => { P[0] = pt; })];
      case 'rect': return [
        H(at(P[0].t, P[0].p), pt => { P[0] = pt; }), H(at(P[1].t, P[1].p), pt => { P[1] = pt; }),
        H(at(P[0].t, P[1].p), pt => { P[0].t = pt.t; P[1].p = pt.p; }), H(at(P[1].t, P[0].p), pt => { P[1].t = pt.t; P[0].p = pt.p; }),
      ];
      case 'long': case 'short': return [
        H(at(P[0].t, P[0].p), pt => { P[0] = pt; }),
        H(at(P[0].t, d.target), pt => { d.target = pt.p; }), H(at(P[0].t, d.stop), pt => { d.stop = pt.p; }),
        H(at(d.t2, P[0].p), pt => { d.t2 = pt.t; }),
      ];
      default: return P.map((p, i) => H(at(p.t, p.p), pt => { P[i] = pt; }));
    }
  }
  hitHandle(d, x, y) {
    const r = matchMedia?.('(pointer: coarse)').matches ? 16 : 9;
    return this.handles(d).find(hd => hd.x != null && hd.y != null && Math.hypot(hd.x - x, hd.y - y) <= r) || null;
  }
  hitItem(x, y) {
    for (let i = this.items.length - 1; i >= 0; i--) if (this.hit(this.items[i], x, y)) return this.items[i];
    return null;
  }
  hit(d, x, y) {
    const tol = matchMedia?.('(pointer: coarse)').matches ? 12 : 6, P = d.pts, xs = P.map(p => this.x(p.t)), ys = P.map(p => this.y(p.p));
    if (xs.some(v => v == null) && d.type !== 'hline') return false;
    if (ys.some(v => v == null) && d.type !== 'vline') return false;
    const inBox = (x0, x1, y0, y1) => x >= Math.min(x0, x1) - tol && x <= Math.max(x0, x1) + tol && y >= Math.min(y0, y1) - tol && y <= Math.max(y0, y1) + tol;
    switch (d.type) {
      case 'hline': return Math.abs(y - ys[0]) <= tol;
      case 'hray': return x >= xs[0] - tol && Math.abs(y - ys[0]) <= tol;
      case 'vline': return Math.abs(x - xs[0]) <= tol;
      case 'trend': case 'arrow': return distToLine(x, y, xs[0], ys[0], xs[1], ys[1]) <= tol;
      case 'ray': return distToLine(x, y, xs[0], ys[0], xs[1], ys[1], 'ray') <= tol;
      case 'ext': return distToLine(x, y, xs[0], ys[0], xs[1], ys[1], 'line') <= tol;
      case 'rect': case 'measure': case 'fib': return inBox(xs[0], xs[1], ys[0], ys[1]);
      case 'long': case 'short': { const x2 = this.x(d.t2), yt = this.y(d.target), ysl = this.y(d.stop); return x2 != null && yt != null && ysl != null && inBox(xs[0], x2, yt, ysl); }
      case 'text': return inBox(xs[0], xs[0] + (d._w || 40), ys[0] - 10, ys[0] + 10);
      default: return false;
    }
  }

  // ---- render ----
  draw(target) {
    if (this.hidden || !this.items.length || !this.times.length) return;
    const pal = chartPalette();
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const W = mediaSize.width, H = mediaSize.height;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.textBaseline = 'middle';
      const font = (size, weight = 500) => { ctx.font = `${weight} ${size}px Inter, system-ui, -apple-system, 'Segoe UI', sans-serif`; };
      const line = (ax, ay, bx, by, color, width, dash = []) => { ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash); ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.setLineDash([]); };
      const extend = (ax, ay, bx, by) => { const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1, k = (W + H) * 2 / len; return [ax + dx * k, ay + dy * k]; };
      const pill = (text, cx, cy, bg, fg = '#05121a', size = 11, align = 'center') => {
        font(size, 600);
        const tw = ctx.measureText(text).width, pw = tw + 12, ph = size + 8, left = align === 'center' ? cx - pw / 2 : align === 'left' ? cx : cx - pw;
        ctx.fillStyle = bg; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(left, cy - ph / 2, pw, ph, 5) : ctx.rect(left, cy - ph / 2, pw, ph); ctx.fill();
        ctx.fillStyle = fg; ctx.fillText(text, left + 6, cy);
        return pw;
      };
      for (const d of this.items) {
        const P = d.pts, xs = P.map(p => this.x(p.t)), ys = P.map(p => this.y(p.p)), c = d.color, w = d.width || 2, sel = d === this.sel;
        if (d.type !== 'hline' && xs.some(v => v == null)) continue;
        if (d.type !== 'vline' && ys.some(v => v == null)) continue;
        if (sel) { ctx.shadowColor = rgba(c, 0.55); ctx.shadowBlur = 6; }
        switch (d.type) {
          case 'trend': line(xs[0], ys[0], xs[1], ys[1], c, w); break;
          case 'ray': { const [ex, ey] = extend(xs[0], ys[0], xs[1], ys[1]); line(xs[0], ys[0], ex, ey, c, w); break; }
          case 'ext': { const [ex, ey] = extend(xs[0], ys[0], xs[1], ys[1]), [sx, sy] = extend(xs[1], ys[1], xs[0], ys[0]); line(sx, sy, ex, ey, c, w); break; }
          case 'arrow': {
            line(xs[0], ys[0], xs[1], ys[1], c, w);
            const ang = Math.atan2(ys[1] - ys[0], xs[1] - xs[0]), L = 9 + w * 2;
            ctx.fillStyle = c; ctx.beginPath(); ctx.moveTo(xs[1], ys[1]);
            ctx.lineTo(xs[1] - L * Math.cos(ang - 0.42), ys[1] - L * Math.sin(ang - 0.42)); ctx.lineTo(xs[1] - L * Math.cos(ang + 0.42), ys[1] - L * Math.sin(ang + 0.42)); ctx.closePath(); ctx.fill();
            break;
          }
          case 'hline': line(0, ys[0], W, ys[0], c, w, [6, 4]); break;
          case 'hray': line(xs[0], ys[0], W, ys[0], c, w); ctx.fillStyle = c; ctx.beginPath(); ctx.arc(xs[0], ys[0], 2.5, 0, Math.PI * 2); ctx.fill(); break;
          case 'vline': line(xs[0], 0, xs[0], H, c, w, [6, 4]); break;
          case 'rect': {
            ctx.fillStyle = rgba(c, 0.12); ctx.fillRect(Math.min(xs[0], xs[1]), Math.min(ys[0], ys[1]), Math.abs(xs[1] - xs[0]), Math.abs(ys[1] - ys[0]));
            ctx.strokeStyle = c; ctx.lineWidth = w; ctx.strokeRect(Math.min(xs[0], xs[1]), Math.min(ys[0], ys[1]), Math.abs(xs[1] - xs[0]), Math.abs(ys[1] - ys[0]));
            break;
          }
          case 'fib': {
            const left = Math.min(xs[0], xs[1]), right = Math.max(xs[0], xs[1]), span = P[0].p - P[1].p;
            const ly = FIB_LEVELS.map(r => this.y(P[1].p + span * r));
            const tints = ['#FF5E7B', '#FFBA52', '#38EBB4', '#5AB8FF', '#B48CFF', '#94A3B8'];
            for (let i = 0; i < FIB_LEVELS.length - 1; i++) if (ly[i] != null && ly[i + 1] != null) { ctx.fillStyle = rgba(tints[i], 0.08); ctx.fillRect(left, Math.min(ly[i], ly[i + 1]), right - left, Math.abs(ly[i + 1] - ly[i])); }
            font(10, 600);
            FIB_LEVELS.forEach((r, i) => {
              if (ly[i] == null) return;
              const col = r === 0.5 || r === 0.618 ? c : rgba(c, 0.65);
              line(left, ly[i], right, ly[i], col, r === 0.5 || r === 0.618 ? w : 1);
              ctx.fillStyle = col; ctx.fillText(`${r} (${this.fmt(P[1].p + span * r)})`, left + 4, ly[i] - 7);
            });
            line(xs[0], ys[0], xs[1], ys[1], rgba(c, 0.35), 1, [3, 4]);
            break;
          }
          case 'measure': {
            const up = P[1].p >= P[0].p, col = up ? '#38EBB4' : '#FF5E7B', x0 = Math.min(xs[0], xs[1]), y0 = Math.min(ys[0], ys[1]);
            ctx.fillStyle = rgba(col, 0.13); ctx.fillRect(x0, y0, Math.abs(xs[1] - xs[0]), Math.abs(ys[1] - ys[0]));
            const mx = (xs[0] + xs[1]) / 2;
            line(mx, ys[0], mx, ys[1], col, 1.5);
            const ang = up ? -Math.PI / 2 : Math.PI / 2;
            ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(mx, ys[1]); ctx.lineTo(mx - 6 * Math.cos(ang - 0.5), ys[1] - 6 * Math.sin(ang - 0.5)); ctx.lineTo(mx - 6 * Math.cos(ang + 0.5), ys[1] - 6 * Math.sin(ang + 0.5)); ctx.closePath(); ctx.fill();
            const dp = P[1].p - P[0].p, pct = P[0].p ? dp / P[0].p * 100 : 0;
            const bars = Math.round(Math.abs(logicalOfTime(this.times, this.step, P[1].t) - logicalOfTime(this.times, this.step, P[0].t)));
            const secs = Math.abs(P[1].t - P[0].t), dur = secs >= 86400 ? `${Math.round(secs / 86400)}d` : secs >= 3600 ? `${Math.floor(secs / 3600)}h ${String(Math.round(secs % 3600 / 60)).padStart(2, '0')}m` : `${Math.round(secs / 60)}m`;
            pill(`${dp >= 0 ? '+' : ''}${this.fmt(dp)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%) · ${bars} bars · ${dur}`, mx, up ? y0 - 14 : Math.max(ys[0], ys[1]) + 14, col);
            break;
          }
          case 'long': case 'short': {
            const x2 = this.x(d.t2), yt = this.y(d.target), ysl = this.y(d.stop);
            if (x2 == null || yt == null || ysl == null) break;
            const x0 = Math.min(xs[0], x2), bw = Math.abs(x2 - xs[0]), ye = ys[0];
            ctx.fillStyle = 'rgba(56, 235, 180, 0.16)'; ctx.fillRect(x0, Math.min(ye, yt), bw, Math.abs(yt - ye));
            ctx.fillStyle = 'rgba(255, 94, 123, 0.16)'; ctx.fillRect(x0, Math.min(ye, ysl), bw, Math.abs(ysl - ye));
            line(x0, ye, x0 + bw, ye, pal.text || '#E8EEF7', 1.5);
            line(x0, yt, x0 + bw, yt, 'rgba(56, 235, 180, 0.8)', 1); line(x0, ysl, x0 + bw, ysl, 'rgba(255, 94, 123, 0.8)', 1);
            const s = positionStats(d), cx = x0 + bw / 2;
            pill(`Target ${this.fmt(d.target)} · ${s.targetPct >= 0 ? '+' : ''}${s.targetPct.toFixed(2)}% · ${this.fmt(Math.abs(d.target - P[0].p))} pts`, cx, yt + (yt < ye ? -13 : 13), '#38EBB4');
            pill(`Stop ${this.fmt(d.stop)} · ${s.stopPct >= 0 ? '+' : ''}${s.stopPct.toFixed(2)}% · ${this.fmt(Math.abs(d.stop - P[0].p))} pts`, cx, ysl + (ysl > ye ? 13 : -13), '#FF5E7B');
            pill(`${d.type === 'long' ? 'Long' : 'Short'} · R:R ${s.rr.toFixed(2)}`, cx, ye, s.rr >= 1 ? '#E8EEF7' : '#FFBA52');
            break;
          }
          case 'text': {
            font(13, 600);
            const text = d.text || 'Text', tw = ctx.measureText(text).width;
            d._w = tw + 12;
            ctx.fillStyle = 'rgba(8, 13, 21, 0.72)'; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(xs[0], ys[0] - 11, tw + 12, 22, 5) : ctx.rect(xs[0], ys[0] - 11, tw + 12, 22); ctx.fill();
            ctx.fillStyle = c; ctx.fillText(text, xs[0] + 6, ys[0]);
            break;
          }
          default: break;
        }
        ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
        if (sel || this.creating?.item === d) {
          for (const hd of this.handles(d)) {
            if (hd.x == null || hd.y == null) continue;
            ctx.fillStyle = '#ffffff'; ctx.strokeStyle = c; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc(hd.x, hd.y, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          }
        }
      }
    });
  }
}
