// Small SVG charts sized to their container. Colors come from CSS tokens.
const NS = 'http://www.w3.org/2000/svg';
const token = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
let gid = 0;

function el(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  parent?.appendChild(e);
  return e;
}
function text(parent, x, y, str, { anchor = 'start', color, weight } = {}) {
  const t = el('text', { x, y, 'text-anchor': anchor }, parent);
  t.textContent = str;
  if (color) t.style.fill = color;
  if (weight) t.style.fontWeight = weight;
  return t;
}

/** Round axis bounds and evenly spaced ticks. */
export function niceScale(min, max, count = 4) {
  if (min === max) { min -= 1; max += 1; }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 1e6; v += step) ticks.push(+v.toFixed(6));
  return { lo, hi, ticks };
}

/**
 * opts: xDomain, yDomain, yTicks, fmtY, xTicks [[value, label]], vlines [{x, color, label}],
 *       hlines [{y, color, label}] (day levels such as the stop-loss),
 *       notes [{text, color, at: 'top' | 'bottom'}] (e.g. "No profit limit" when a level is switched off),
 *       low [x, y, label], endLabel, bare (sparkline mode)
 */
export function lineChart(svg, pts, o) {
  svg.replaceChildren();
  const W = svg.clientWidth || 600, H = svg.clientHeight || 240;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  if (!pts.length) return;
  const mint = token('--mint'), line = token('--line'), line2 = token('--line-2');
  // Phones: slimmer gutters so the plot gets the width (axis labels are short, e.g. "−₹20k").
  const m = o.bare ? { l: 2, r: 2, t: 4, b: 2 } : W < 520 ? { l: 40, r: 34, t: 12, b: 24 } : { l: 50, r: 64, t: 14, b: 26 };
  const [x0, x1] = o.xDomain || [pts[0][0], pts.at(-1)[0]];
  const [y0, y1] = o.yDomain;
  const X = v => m.l + ((v - x0) / (x1 - x0 || 1)) * (W - m.l - m.r);
  const Y = v => m.t + (1 - (v - y0) / (y1 - y0)) * (H - m.t - m.b);

  const id = `cg${++gid}`;
  const grad = el('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 }, el('defs', {}, svg));
  el('stop', { offset: '0%', 'stop-color': mint, 'stop-opacity': o.bare ? 0.28 : 0.22 }, grad);
  el('stop', { offset: '100%', 'stop-color': mint, 'stop-opacity': 0 }, grad);

  if (!o.bare) {
    for (const t of o.yTicks || []) {
      el('line', { x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t), stroke: t === 0 ? line2 : line, 'stroke-dasharray': t === 0 ? '' : '2 4' }, svg);
      text(svg, m.l - (W < 520 ? 5 : 10), Y(t) + 3.5, o.fmtY(t), { anchor: 'end' });
    }
    for (const [v, label] of o.xTicks || []) text(svg, X(v), H - 6, label, { anchor: 'middle' });
    for (const h of o.hlines || []) {
      el('line', { x1: m.l, x2: W - m.r, y1: Y(h.y), y2: Y(h.y), stroke: h.color, 'stroke-width': 1.5, 'stroke-dasharray': '6 4', 'stroke-opacity': 0.9 }, svg);
      // Label just inside the plot, above the line (below it when the line is at the very top).
      const ly = Y(h.y) - 6 < m.t + 10 ? Y(h.y) + 14 : Y(h.y) - 6;
      if (h.label) text(svg, m.l + 8, ly, h.label, { color: h.color, weight: 600 });
    }
    for (const n of o.notes || []) {
      text(svg, m.l + 8, n.at === 'bottom' ? H - m.b - 8 : m.t + 12, n.text, { color: n.color, weight: 600 });
    }
    for (const v of o.vlines || []) {
      el('line', { x1: X(v.x), x2: X(v.x), y1: m.t, y2: H - m.b, stroke: v.color, 'stroke-dasharray': '4 4', 'stroke-opacity': 0.8 }, svg);
      // Sit below a top note (e.g. "No profit limit") so the two never overlap.
      const vy = m.t + 10 + ((o.notes || []).some(n => n.at !== 'bottom') ? 18 : 0);
      if (v.label) text(svg, X(v.x) - 6, vy, v.label, { anchor: 'end', color: v.color });
    }
  }

  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)} ${Y(p[1]).toFixed(1)}`).join(' ');
  const base = o.bare ? H : Y(Math.max(y0, Math.min(0, y1)));
  el('path', { d: `${d} L${X(pts.at(-1)[0]).toFixed(1)} ${base} L${X(pts[0][0]).toFixed(1)} ${base} Z`, fill: `url(#${id})` }, svg);
  const path = el('path', { d, fill: 'none', stroke: mint, 'stroke-width': o.bare ? 1.6 : 2.2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
  if (!o.bare) path.style.filter = `drop-shadow(0 0 6px ${token('--mint-glow')})`;

  if (o.low) {
    const red = token('--red');
    el('circle', { cx: X(o.low[0]), cy: Y(o.low[1]), r: 3.5, fill: red }, svg);
    text(svg, X(o.low[0]) + 8, Y(o.low[1]) + 4, o.low[2], { color: red });
  }
  const e = pts.at(-1);
  if (o.bare) {
    el('circle', { cx: X(e[0]), cy: Y(e[1]), r: 3, fill: mint }, svg);
  } else {
    el('circle', { cx: X(e[0]), cy: Y(e[1]), r: 8, fill: mint, 'fill-opacity': 0.18 }, svg);
    el('circle', { cx: X(e[0]), cy: Y(e[1]), r: 4, fill: mint }, svg);
    // The value sits right of the dot, or above-left of it when it would run off the edge.
    if (o.endLabel) {
      const fits = X(e[0]) + 12 + String(o.endLabel).length * 6.5 <= W;
      text(svg, fits ? X(e[0]) + 12 : X(e[0]) - 8, fits ? Y(e[1]) + 4 : Y(e[1]) - 10, o.endLabel, { color: mint, weight: 600, anchor: fits ? 'start' : 'end' });
    }
  }
}

/** opts: yDomain, fmtY, labels[], xTicks [indexes] */
export function barChart(svg, vals, o) {
  svg.replaceChildren();
  const W = svg.clientWidth || 600, H = svg.clientHeight || 120;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  if (!vals.length) return;
  const m = { l: 50, r: 64, t: 6, b: 22 };
  const [y0, y1] = o.yDomain;
  const Y = v => m.t + (1 - (v - y0) / (y1 - y0)) * (H - m.t - m.b);
  const bw = (W - m.l - m.r) / vals.length;
  const mint = token('--mint'), red = token('--red');
  el('line', { x1: m.l, x2: W - m.r, y1: Y(0), y2: Y(0), stroke: token('--line-2') }, svg);
  for (const t of [y1, y0]) text(svg, m.l - 10, Y(t) + 3.5, o.fmtY(t), { anchor: 'end' });
  vals.forEach((v, i) => {
    const r = el('rect', {
      x: m.l + i * bw + bw * 0.2, y: Math.min(Y(v), Y(0)), width: bw * 0.6, height: Math.max(1, Math.abs(Y(v) - Y(0))),
      rx: 2, fill: v >= 0 ? mint : red, 'fill-opacity': i === vals.length - 1 ? 1 : 0.7,
    }, svg);
    el('title', {}, r).textContent = `${o.labels[i]}: ${o.fmtTip ? o.fmtTip(v) : v}`;
  });
  for (const i of o.xTicks) text(svg, m.l + i * bw + bw / 2, H - 6, o.labels[i], { anchor: 'middle' });
}

export function ring(box, fraction, color = token('--amber')) {
  const svg = box.querySelector('svg');
  const c = 2 * Math.PI * 42;
  const f = Math.max(0, Math.min(1, fraction));
  svg.innerHTML = `<circle cx="50" cy="50" r="42" fill="none" stroke="${token('--line-2')}" stroke-width="8"/>
    <circle cx="50" cy="50" r="42" fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round" stroke-dasharray="${c * f} ${c}"/>`;
}
