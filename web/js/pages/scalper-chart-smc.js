import { chartPalette } from './chart-palette.js';
// Smart Money Concepts and Fair Value Gaps for the Power Scalper charts (Indicators: "SMC", "FVG").
//   FVG: a three-candle imbalance. Bullish when candle 3's low is above candle 1's high (the gap between them),
//        bearish when candle 3's high is below candle 1's low. Shaded until price trades back through it (filled).
//   SMC: swing highs / lows (a pivot with SWING_LEN bars either side). A close beyond the last swing high / low is
//        a break of structure: BOS when it continues the trend, CHoCH (change of character) when it turns it.
//        The order block is the last opposite candle before that break (for a bullish break: the last down candle),
//        shown until price closes through it.
// Pure maths first (tested in server/test), then the chart primitive that draws them.

export const SWING_LEN = 5;
const FVG_MIN = 0.25;          // a gap smaller than 25% of the average candle range is noise
const MAX_FVG = 24, MAX_OB = 3, MAX_EVENTS = 12, LOOKBACK = 400;

const avgRange = (bars, from, to) => {
  let sum = 0, n = 0;
  for (let i = from; i <= to; i++) { const r = bars[i].high - bars[i].low; if (r > 0) { sum += r; n++; } }
  return n ? sum / n : 0;
};

/** Fair value gaps in bars[from..to]: { kind:'bull'|'bear', top, bottom, start (middle candle), end (fill bar or null) }. */
export function fairValueGaps(bars, from = 0, to = bars.length - 1) {
  const out = [], min = avgRange(bars, from, to) * FVG_MIN;
  for (let i = Math.max(from + 2, 2); i <= to; i++) {
    const a = bars[i - 2], c = bars[i];
    let gap = null;
    if (c.low > a.high && c.low - a.high >= min) gap = { kind:'bull', top:c.low, bottom:a.high, start:i - 1, end:null };
    else if (c.high < a.low && a.low - c.high >= min) gap = { kind:'bear', top:a.low, bottom:c.high, start:i - 1, end:null };
    if (!gap) continue;
    // Filled once price trades through the far side of the gap.
    for (let j = i + 1; j <= to; j++) {
      if (gap.kind === 'bull' ? bars[j].low <= gap.bottom : bars[j].high >= gap.top) { gap.end = j; break; }
    }
    out.push(gap);
  }
  return out;
}

/**
 * Market structure in bars[from..to]: { events: [{ kind:'BOS'|'CHoCH', dir:'up'|'down', price, from (swing bar), at (break bar) }],
 * blocks: [{ dir:'up'|'down', top, bottom, start, end (broken bar or null) }], trend }.
 * A swing is only known SWING_LEN bars after it (no look-ahead): breaks are checked against confirmed swings.
 */
export function marketStructure(bars, from = 0, to = bars.length - 1, len = SWING_LEN) {
  const events = [], blocks = [];
  let high = null, low = null, trend = null;
  // p is a swing high (low) when no bar within `len` either side is higher (lower); a later equal bar wins the tie.
  // Called with p - len >= from and p + len = j <= to.
  const pivot = (p, side) => {
    const ref = side === 'high' ? bars[p].high : bars[p].low;
    for (let k = p - len; k <= p + len; k++) {
      if (k === p) continue;
      const v = side === 'high' ? bars[k].high : bars[k].low;
      if (side === 'high' ? v > ref || (k > p && v === ref) : v < ref || (k > p && v === ref)) return false;
    }
    return true;
  };
  for (let j = from; j <= to; j++) {
    const p = j - len;
    if (p - len >= from) {
      if (pivot(p, 'high')) high = { price:bars[p].high, at:p, broken:false };
      if (pivot(p, 'low')) low = { price:bars[p].low, at:p, broken:false };
    }
    const close = bars[j].close;
    for (const [swing, dir] of [[high, 'up'], [low, 'down']]) {
      if (!swing || swing.broken || (dir === 'up' ? close <= swing.price : close >= swing.price)) continue;
      swing.broken = true;
      events.push({ kind: trend && trend !== dir ? 'CHoCH' : 'BOS', dir, price:swing.price, from:swing.at, at:j });
      trend = dir;
      // Order block: the last opposite candle between the swing and the break.
      for (let k = j - 1; k >= Math.max(from, swing.at - len); k--) {
        const b = bars[k];
        if (dir === 'up' ? b.close < b.open : b.close > b.open) { blocks.push({ dir, top:b.high, bottom:b.low, start:k, end:null }); break; }
      }
    }
  }
  // An order block ends once a later close goes through it.
  for (const ob of blocks) {
    for (let j = ob.start + 1; j <= to; j++) {
      if (ob.dir === 'up' ? bars[j].close < ob.bottom : bars[j].close > ob.top) { ob.end = j; break; }
    }
  }
  return { events, blocks, trend };
}

/** Confirmed swing points in bars[from..to]: { side:'high'|'low', price, at (swing bar), known (bar it is confirmed at) }. */
export function swingPoints(bars, from = 0, to = bars.length - 1, len = SWING_LEN) {
  const out = [];
  for (let p = from + len; p + len <= to; p++) {
    for (const side of ['high', 'low']) {
      const ref = side === 'high' ? bars[p].high : bars[p].low;
      let ok = true;
      for (let k = p - len; k <= p + len && ok; k++) {
        if (k === p) continue;
        const v = side === 'high' ? bars[k].high : bars[k].low;
        if (side === 'high' ? v > ref || (k > p && v === ref) : v < ref || (k > p && v === ref)) ok = false;
      }
      if (ok) out.push({ side, price:ref, at:p, known:p + len });
    }
  }
  return out;
}

/**
 * ICT concepts in bars[from..to]:
 *   liquidity: resting buy-side (above swing highs, BSL) and sell-side (below swing lows, SSL) liquidity:
 *     { side, price, at, equal (an equal high / low: EQH / EQL), taken (bar or null), sweep (taken by a wick that closed back) }
 *   range: the dealing range from the last confirmed swing high and low: { high, low, eq (50%), at } (premium above eq, discount below)
 *   ote: the optimal trade entry zone, 62% to 79% back into the last swing leg: { dir:'up'|'down', top, bottom, at }
 */
export function ictLevels(bars, from = 0, to = bars.length - 1, len = SWING_LEN) {
  const swings = swingPoints(bars, from, to, len), tol = avgRange(bars, from, to) * 0.1;
  const liquidity = [];
  for (const s of swings) {
    const prev = [...liquidity].reverse().find(l => l.side === s.side);
    const level = { side:s.side, price:s.price, at:s.at, equal: !!prev && Math.abs(prev.price - s.price) <= tol, taken:null, sweep:false };
    for (let j = s.known + 1; j <= to; j++) {
      const b = bars[j];
      if (s.side === 'high' ? b.high > s.price : b.low < s.price) { level.taken = j; level.sweep = s.side === 'high' ? b.close < s.price : b.close > s.price; break; }
    }
    liquidity.push(level);
  }
  const lastHigh = swings.filter(s => s.side === 'high').at(-1), lastLow = swings.filter(s => s.side === 'low').at(-1);
  let range = null, ote = null;
  if (lastHigh && lastLow && lastHigh.price > lastLow.price) {
    const hi = lastHigh.price, lo = lastLow.price, size = hi - lo;
    range = { high:hi, low:lo, eq:(hi + lo) / 2, at:Math.min(lastHigh.at, lastLow.at) };
    // The leg runs from the older swing to the newer one: low → high is an up leg (buy back in the OTE), high → low a down leg.
    ote = lastHigh.at > lastLow.at
      ? { dir:'up', top:hi - 0.62 * size, bottom:hi - 0.79 * size, at:lastHigh.at }
      : { dir:'down', top:lo + 0.79 * size, bottom:lo + 0.62 * size, at:lastLow.at };
  }
  return { liquidity, range, ote };
}

/** Draws SMC (BOS / CHoCH lines, live order blocks), FVG boxes and ICT levels for the bars in view (plus some history before it). */
export class SmcPrimitive {
  constructor() { this.bars = []; this.show = { smc:true, fvg:true, ict:true }; this.paneView = { zOrder: () => 'bottom', renderer: () => ({ draw: target => this.draw(target) }) }; }
  attached({ chart, series, requestUpdate }) { this.chart = chart; this.series = series; this.requestUpdate = requestUpdate; }
  detached() { this.chart = this.series = this.requestUpdate = null; }
  setData(bars) { this.bars = bars || []; this.cache = null; this.requestUpdate?.(); }
  setVisible({ smc, fvg, ict }) { this.show = { smc:!!smc, fvg:!!fvg, ict:!!ict }; this.requestUpdate?.(); }
  updateAllViews() {}
  paneViews() { return [this.paneView]; }
  compute(from, to) {
    const key = `${from}:${to}:${this.bars.length}:${this.bars.at(-1)?.close}`;
    if (this.cache?.key !== key) this.cache = { key, fvg:fairValueGaps(this.bars, from, to), smc:marketStructure(this.bars, from, to), ict:ictLevels(this.bars, from, to) };
    return this.cache;
  }
  draw(target) {
    if ((!this.show.smc && !this.show.fvg && !this.show.ict) || !this.series || this.bars.length < 3) return;
    const ts = this.chart.timeScale(), range = ts.getVisibleLogicalRange(), last = this.bars.length - 1;
    const viewFrom = range ? Math.max(0, Math.floor(range.from)) : 0, to = range ? Math.min(last, Math.ceil(range.to)) : last;
    if (viewFrom > to) return;
    const { fvg, smc, ict } = this.compute(Math.max(0, viewFrom - LOOKBACK), to), pal = chartPalette();
    const y = p => this.series.priceToCoordinate(p), x = i => ts.logicalToCoordinate(i);
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      ctx.font = `${Math.round(9 * vr)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      ctx.textBaseline = 'middle';
      const box = (startIdx, endIdx, top, bottom, rgb, alpha, label) => {
        const x0 = x(startIdx), x1 = endIdx == null ? bitmapSize.width / hr : x(endIdx), yt = y(top), yb = y(bottom);
        if (x0 == null || x1 == null || yt == null || yb == null || x1 < 0) return;
        const left = Math.round(Math.max(0, x0) * hr), w = Math.max(1, Math.round(x1 * hr) - left), t = Math.round(yt * vr), h = Math.max(1, Math.round((yb - yt) * vr));
        ctx.fillStyle = `rgba(${rgb}, ${alpha})`; ctx.fillRect(left, t, w, h);
        if (label && endIdx == null) { ctx.fillStyle = `rgba(${rgb}, 0.9)`; ctx.fillText(label, left + Math.round(3 * hr), t + h / 2); }
      };
      if (this.show.ict) {
        // Premium / discount of the dealing range (faint, behind everything) with its 50% line; the OTE box.
        if (ict.range) {
          box(ict.range.at, null, ict.range.high, ict.range.eq, pal.downRgb, 0.05, null);
          box(ict.range.at, null, ict.range.eq, ict.range.low, pal.upRgb, 0.05, null);
          const ye = y(ict.range.eq), x0 = x(ict.range.at);
          if (ye != null && x0 != null) {
            const yy = Math.round(ye * vr) + 0.5;
            ctx.strokeStyle = 'rgba(148, 163, 184, 0.7)'; ctx.lineWidth = Math.max(1, Math.round(hr)); ctx.setLineDash([Math.round(2 * hr), Math.round(3 * hr)]);
            ctx.beginPath(); ctx.moveTo(Math.round(Math.max(0, x0) * hr), yy); ctx.lineTo(bitmapSize.width, yy); ctx.stroke(); ctx.setLineDash([]);
            ctx.fillStyle = 'rgba(148, 163, 184, 0.9)';
            const lx = bitmapSize.width - Math.round(150 * hr);
            ctx.fillText('EQ', lx, yy - 6 * vr);
            const yh = y(ict.range.high), yl = y(ict.range.low);
            if (yh != null) ctx.fillText('Premium', lx, Math.round(yh * vr) + 8 * vr);
            if (yl != null) ctx.fillText('Discount', lx, Math.round(yl * vr) - 8 * vr);
          }
        }
        if (ict.ote) box(ict.ote.at, null, ict.ote.top, ict.ote.bottom, '192, 132, 252', 0.14, ict.ote.dir === 'up' ? 'OTE buy 62–79%' : 'OTE sell 62–79%');
        // Resting liquidity: dotted lines from the swing to the right edge until taken; sweeps marked where they happened.
        ctx.lineWidth = Math.max(1, Math.round(hr));
        const resting = side => ict.liquidity.filter(l => l.side === side && l.taken == null).slice(-4);
        for (const l of [...resting('high'), ...resting('low')]) {
          const x0 = x(l.at), py = y(l.price);
          if (x0 == null || py == null) continue;
          const yy = Math.round(py * vr) + 0.5, rgb = l.side === 'high' ? pal.downRgb : pal.upRgb;
          ctx.strokeStyle = `rgba(${rgb}, 0.75)`; ctx.setLineDash([Math.round(1 * hr), Math.round(3 * hr)]);
          ctx.beginPath(); ctx.moveTo(Math.round(Math.max(0, x0) * hr), yy); ctx.lineTo(bitmapSize.width, yy); ctx.stroke(); ctx.setLineDash([]);
          ctx.fillStyle = `rgba(${rgb}, 0.95)`;
          const text = l.side === 'high' ? (l.equal ? 'EQH · BSL' : 'BSL') : (l.equal ? 'EQL · SSL' : 'SSL');
          ctx.fillText(text, Math.round(Math.max(0, x0) * hr) + Math.round(4 * hr), yy + (l.side === 'high' ? -6 : 6) * vr);
        }
        for (const l of ict.liquidity.filter(l => l.sweep && l.taken >= viewFrom).slice(-6)) {
          const x0 = x(l.at), x1 = x(l.taken), py = y(l.price);
          if (x0 == null || x1 == null || py == null) continue;
          const yy = Math.round(py * vr) + 0.5, rgb = l.side === 'high' ? pal.downRgb : pal.upRgb;
          ctx.strokeStyle = `rgba(${rgb}, 0.5)`; ctx.setLineDash([Math.round(1 * hr), Math.round(3 * hr)]);
          ctx.beginPath(); ctx.moveTo(Math.round(x0 * hr), yy); ctx.lineTo(Math.round(x1 * hr), yy); ctx.stroke(); ctx.setLineDash([]);
          ctx.fillStyle = `rgb(${rgb})`;
          ctx.fillText(l.side === 'high' ? '✕ BSL sweep' : '✕ SSL sweep', Math.round(x1 * hr) + Math.round(3 * hr), yy + (l.side === 'high' ? -6 : 6) * vr);
        }
      }
      if (this.show.fvg) {
        // Open gaps run to the right edge; filled ones stop at the fill bar, fainter. Only those reaching the view.
        for (const g of fvg.filter(g => (g.end ?? last) >= viewFrom).slice(-MAX_FVG)) {
          box(g.start, g.end, g.top, g.bottom, g.kind === 'bull' ? pal.upRgb : pal.downRgb, g.end == null ? 0.2 : 0.07, 'FVG');
        }
      }
      if (this.show.smc) {
        const live = side => smc.blocks.filter(b => b.dir === side && b.end == null).slice(-MAX_OB);
        for (const ob of [...live('up'), ...live('down')]) box(ob.start, null, ob.top, ob.bottom, ob.dir === 'up' ? '93, 169, 255' : '245, 185, 66', 0.16, ob.dir === 'up' ? 'Bull OB' : 'Bear OB');
        ctx.lineWidth = Math.max(1, Math.round(hr));
        for (const e of smc.events.filter(e => e.at >= viewFrom).slice(-MAX_EVENTS)) {
          const x0 = x(e.from), x1 = x(e.at), py = y(e.price);
          if (x0 == null || x1 == null || py == null) continue;
          const color = `rgb(${e.dir === 'up' ? pal.upRgb : pal.downRgb})`, yy = Math.round(py * vr) + 0.5;
          ctx.strokeStyle = color; ctx.setLineDash(e.kind === 'CHoCH' ? [] : [Math.round(4 * hr), Math.round(3 * hr)]);
          ctx.beginPath(); ctx.moveTo(Math.round(x0 * hr), yy); ctx.lineTo(Math.round(x1 * hr), yy); ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = color;
          const text = e.kind, tw = ctx.measureText(text).width;
          ctx.fillText(text, Math.round(((x0 + x1) / 2) * hr - tw / 2), yy + (e.dir === 'up' ? -6 : 6) * vr);
        }
      }
    });
  }
}
