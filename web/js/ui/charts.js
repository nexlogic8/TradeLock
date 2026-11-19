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
 *       series [{pts, color}] (extra lines drawn under the main one),
 *       low [x, y, label], endLabel, bare (sparkline mode),
 *       smooth (a curve instead of straight segments), hover (i → { title, value, sub?, color? }: crosshair card)
 * Full charts are two-tone: green above zero, red below it.
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

  const red = token('--red');
  const id = `cg${++gid}`, lid = `cl${gid}`, defs = el('defs', {}, svg);
  // Two-tone around zero (full charts): green above the zero line, red below it, for the line and the area under it.
  const zeroY = Math.max(m.t, Math.min(H - m.b, Y(0)));
  // Just below the zero line, so a flat ₹0 stretch stays green and only real losses turn red.
  const zf = `${(Math.min(1, (zeroY + 1.5 - m.t) / (H - m.t - m.b || 1)) * 100).toFixed(2)}%`;
  const vgrad = gid => el('linearGradient', { id: gid, gradientUnits: 'userSpaceOnUse', x1: 0, y1: m.t, x2: 0, y2: H - m.b }, defs);
  if (o.bare) {
    const grad = el('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    el('stop', { offset: '0%', 'stop-color': mint, 'stop-opacity': 0.28 }, grad);
    el('stop', { offset: '100%', 'stop-color': mint, 'stop-opacity': 0 }, grad);
  } else {
    const area = vgrad(id);
    el('stop', { offset: '0%', 'stop-color': mint, 'stop-opacity': 0.3 }, area);
    el('stop', { offset: zf, 'stop-color': mint, 'stop-opacity': 0.03 }, area);
    el('stop', { offset: zf, 'stop-color': red, 'stop-opacity': 0.03 }, area);
    el('stop', { offset: '100%', 'stop-color': red, 'stop-opacity': 0.3 }, area);
    const stroke = vgrad(lid);
    for (const [off, c] of [['0%', mint], [zf, mint], [zf, red], ['100%', red]]) el('stop', { offset: off, 'stop-color': c }, stroke);
  }
  const toneOf = v => (o.bare || v >= 0 ? mint : red);

  if (!o.bare) {
    for (const t of o.yTicks || []) {
      el('line', { x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t), stroke: t === 0 ? line2 : line, 'stroke-dasharray': t === 0 ? '' : '2 4' }, svg);
      text(svg, m.l - (W < 520 ? 5 : 10), Y(t) + 3.5, o.fmtY(t), { anchor: 'end' });
    }
    for (const [v, label] of o.xTicks || []) text(svg, X(v), H - 6, label, { anchor: 'middle' });
    for (const h of o.hlines || []) {
      el('line', { x1: m.l, x2: W - m.r, y1: Y(h.y), y2: Y(h.y), stroke: h.color, 'stroke-width': 1.5, 'stroke-dasharray': h.dash || '6 4', 'stroke-opacity': h.opacity ?? 0.9 }, svg);
      // Label just inside the plot, above the line (below it when the line is at the very top).
      const ly = Y(h.y) - 6 < m.t + 10 ? Y(h.y) + 14 : Y(h.y) - 6;
      // h.end: the label at the right end (a second level close to the first keeps both readable).
      if (h.label) text(svg, h.end ? W - m.r - 8 : m.l + 8, ly, h.label, { color: h.color, weight: 600, ...(h.end ? { anchor: 'end' } : {}) });
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

  const P = pts.map(p => [X(p[0]), Y(p[1])]);
  const d = o.smooth ? smoothPath(P) : straightPath(P);
  const base = o.bare ? H : zeroY;
  el('path', { d: `${d} L${P.at(-1)[0].toFixed(1)} ${base} L${P[0][0].toFixed(1)} ${base} Z`, fill: `url(#${id})` }, svg);
  // Extra lines under the main one (e.g. the Algo and Manual parts of the day's P&L), each with a dot at its end.
  for (const s of o.series || []) {
    if (!s.pts?.length) continue;
    const sd = s.pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)} ${Y(p[1]).toFixed(1)}`).join(' ');
    el('path', { d: sd, fill: 'none', stroke: s.color, 'stroke-width': 1.6, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'stroke-opacity': 0.95 }, svg);
    const se = s.pts.at(-1);
    el('circle', { cx: X(se[0]), cy: Y(se[1]), r: 3, fill: s.color }, svg);
  }
  const path = el('path', { d, fill: 'none', stroke: o.bare ? mint : `url(#${lid})`, 'stroke-width': o.bare ? 1.6 : 2.2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
  const e = pts.at(-1), endTone = toneOf(e[1]);
  if (!o.bare) path.style.filter = `drop-shadow(0 0 6px color-mix(in srgb, ${endTone} 40%, transparent))`;

  if (o.low) {
    el('circle', { cx: X(o.low[0]), cy: Y(o.low[1]), r: 3.5, fill: red }, svg);
    text(svg, X(o.low[0]) + 8, Y(o.low[1]) + 4, o.low[2], { color: red });
  }
  if (o.bare) {
    el('circle', { cx: X(e[0]), cy: Y(e[1]), r: 3, fill: mint }, svg);
  } else {
    el('circle', { cx: X(e[0]), cy: Y(e[1]), r: 8, fill: endTone, 'fill-opacity': 0.18 }, svg);
    el('circle', { cx: X(e[0]), cy: Y(e[1]), r: 4, fill: endTone }, svg);
    // The value sits right of the dot, or above-left of it when it would run off the edge.
    if (o.endLabel) {
      const fits = X(e[0]) + 12 + String(o.endLabel).length * 6.5 <= W;
      text(svg, fits ? X(e[0]) + 12 : X(e[0]) - 8, fits ? Y(e[1]) + 4 : Y(e[1]) - 10, o.endLabel, { color: endTone, weight: 600, anchor: fits ? 'start' : 'end' });
    }
    if (o.hover) crosshair(svg, { W, H, m, P, pts, toneOf, hover: o.hover });
  }
}

const straightPath = P => P.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');

/** A smooth curve through every point that never overshoots them (monotone cubic), so the zero crossing stays true. */
function smoothPath(P) {
  const n = P.length;
  if (n < 3) return straightPath(P);
  const dx = [], s = [];
  for (let i = 0; i < n - 1; i++) { dx[i] = P[i + 1][0] - P[i][0]; s[i] = dx[i] ? (P[i + 1][1] - P[i][1]) / dx[i] : 0; }
  const t = [s[0]];
  for (let i = 1; i < n - 1; i++) {
    t[i] = s[i - 1] * s[i] <= 0 ? 0 : 3 * (dx[i - 1] + dx[i]) / ((2 * dx[i] + dx[i - 1]) / s[i - 1] + (dx[i] + 2 * dx[i - 1]) / s[i]);
  }
  t[n - 1] = s[n - 2];
  let d = `M${P[0][0].toFixed(1)} ${P[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += ` C${(P[i][0] + h).toFixed(1)} ${(P[i][1] + t[i] * h).toFixed(1)} ${(P[i + 1][0] - h).toFixed(1)} ${(P[i + 1][1] - t[i + 1] * h).toFixed(1)} ${P[i + 1][0].toFixed(1)} ${P[i + 1][1].toFixed(1)}`;
  }
  return d;
}

/**
 * Hover / touch: a vertical line snaps to the nearest point, with a glowing dot and a card showing that point.
 * hover(i) → { title, value, sub? } for pts[i].
 */
function crosshair(svg, { W, H, m, P, pts, toneOf, hover }) {
  const g = el('g', { class: 'chart-hover' }, svg);
  const vline = el('line', { y1: m.t, y2: H - m.b, 'stroke-width': 1, 'stroke-dasharray': '3 3' }, g);
  const halo = el('circle', { r: 10, 'fill-opacity': 0.18 }, g);
  const dot = el('circle', { r: 4.5, stroke: token('--bg'), 'stroke-width': 2 }, g);
  const card = el('g', { class: 'chart-tip' }, g);
  const box = el('rect', { rx: 10, ry: 10, fill: token('--panel-2'), stroke: token('--line-2') }, card);
  const accent = el('rect', { x: 0, y: 10, width: 3, rx: 1.5 }, card);
  const t1 = text(card, 14, 19, ''), t2 = text(card, 14, 39, '', { weight: 700 }), t3 = text(card, 14, 56, '');
  t2.classList.add('chart-tip-value');
  const hit = el('rect', { x: m.l, y: m.t, width: Math.max(0, W - m.l - m.r), height: Math.max(0, H - m.t - m.b), fill: 'transparent', class: 'chart-hit' }, svg);
  let last = -1;
  const show = i => {
    if (i === last) return;
    last = i;
    const [x, y] = P[i], c = toneOf(pts[i][1]), info = hover(i) || {};
    vline.setAttribute('x1', x); vline.setAttribute('x2', x); vline.setAttribute('stroke', c);
    for (const k of [halo, dot]) { k.setAttribute('cx', x); k.setAttribute('cy', y); k.setAttribute('fill', c); }
    t1.textContent = info.title || ''; t2.textContent = info.value || ''; t3.textContent = info.sub || '';
    t2.style.fill = info.color || c;
    accent.setAttribute('fill', c);
    const w = Math.ceil(Math.max(t1.getComputedTextLength(), t2.getComputedTextLength(), t3.getComputedTextLength())) + 28;
    const h = info.sub ? 66 : 50;
    box.setAttribute('width', w); box.setAttribute('height', h); accent.setAttribute('height', h - 20);
    // Beside the line (right, or left near the right edge), level with the point but inside the plot.
    const cx = x + 14 + w <= W - 4 ? x + 14 : x - 14 - w;
    const cy = Math.max(m.t, Math.min(H - m.b - h, y - h / 2));
    card.style.transform = `translate(${cx}px, ${cy}px)`;
  };
  const nearest = ev => {
    const r = svg.getBoundingClientRect(), x = ((ev.clientX - r.left) / (r.width || 1)) * W;
    let lo = 0, hi = P.length - 1;   // points are in x order
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (P[mid][0] < x) lo = mid; else hi = mid; }
    return Math.abs(P[lo][0] - x) <= Math.abs(P[hi][0] - x) ? lo : hi;
  };
  hit.addEventListener('pointermove', ev => { show(nearest(ev)); g.classList.add('on'); });
  hit.addEventListener('pointerdown', ev => { show(nearest(ev)); g.classList.add('on'); });
  hit.addEventListener('pointerleave', () => g.classList.remove('on'));
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
