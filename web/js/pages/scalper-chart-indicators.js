import { chartPalette } from './chart-palette.js';
// Volume profile and open-interest helpers for the Power Scalper charts.

const VP_ROWS = 24, VALUE_AREA = 0.7, VP_WIDTH = 0.22;

/**
 * Traded volume by price for `bars`, in `rows` equal price bands. Each bar's volume is spread evenly
 * over the bands its high-low range touches. Returns the point of control (busiest band) and the
 * value area (bands around it holding 70% of the volume), or null when there is no volume.
 */
export function volumeProfile(bars, rows = VP_ROWS) {
  let low = Infinity, high = -Infinity, total = 0;
  for (const c of bars) {
    if (!(c.volume > 0)) continue;
    low = Math.min(low, c.low); high = Math.max(high, c.high); total += c.volume;
  }
  if (!total || !(high > low)) return null;
  const step = (high - low) / rows, bins = Array(rows).fill(0), up = Array(rows).fill(0);
  const band = price => Math.min(rows - 1, Math.max(0, Math.floor((price - low) / step)));
  for (const c of bars) {
    if (!(c.volume > 0)) continue;
    const from = band(c.low), to = band(c.high), share = c.volume / (to - from + 1);
    for (let i = from; i <= to; i++) { bins[i] += share; if (c.close >= c.open) up[i] += share; }
  }
  let poc = 0;
  bins.forEach((v, i) => { if (v > bins[poc]) poc = i; });
  // Grow the value area from the POC toward whichever neighbouring band traded more.
  let vaLow = poc, vaHigh = poc, inside = bins[poc];
  while (inside < total * VALUE_AREA && (vaLow > 0 || vaHigh < rows - 1)) {
    const below = vaLow > 0 ? bins[vaLow - 1] : -1, above = vaHigh < rows - 1 ? bins[vaHigh + 1] : -1;
    inside += above >= below ? bins[++vaHigh] : bins[--vaLow];
  }
  return { low, high, step, bins, up, poc, vaLow, vaHigh, total };
}

/**
 * Series primitive that draws the volume profile of the bars in view along the left edge of the
 * price pane: green/red split by up/down-bar volume, value area brighter, POC as a full-width line.
 */
export class VolumeProfilePrimitive {
  constructor() { this.bars = []; this.visible = true; this.paneView = { zOrder: () => 'bottom', renderer: () => ({ draw: target => this.draw(target) }) }; }
  attached({ chart, series, requestUpdate }) { this.chart = chart; this.series = series; this.requestUpdate = requestUpdate; }
  detached() { this.chart = this.series = this.requestUpdate = null; }
  setData(bars) { this.bars = bars || []; this.requestUpdate?.(); }
  setVisible(on) { this.visible = !!on; this.requestUpdate?.(); }
  updateAllViews() {}
  paneViews() { return [this.paneView]; }
  draw(target) {
    if (!this.visible || !this.series || !this.bars.length) return;
    const range = this.chart.timeScale().getVisibleLogicalRange();
    const last = this.bars.length - 1;
    const from = range ? Math.max(0, Math.floor(range.from)) : 0, to = range ? Math.min(last, Math.ceil(range.to)) : last;
    if (from > to) return;
    const profile = volumeProfile(this.bars.slice(from, to + 1));
    if (!profile) return;
    const max = profile.bins[profile.poc], pal = chartPalette();
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, verticalPixelRatio: vr }) => {
      const maxWidth = bitmapSize.width * VP_WIDTH;
      for (let i = 0; i < profile.bins.length; i++) {
        const top = this.series.priceToCoordinate(profile.low + (i + 1) * profile.step);
        const bottom = this.series.priceToCoordinate(profile.low + i * profile.step);
        if (top == null || bottom == null) continue;
        const y = Math.round(top * vr), h = Math.max(1, Math.round((bottom - top) * vr) - Math.max(1, Math.round(vr)));
        const w = Math.round(maxWidth * profile.bins[i] / max), upW = Math.round(w * profile.up[i] / (profile.bins[i] || 1));
        const x = 0, alpha = i >= profile.vaLow && i <= profile.vaHigh ? pal.vpAlpha[0] : pal.vpAlpha[1];
        ctx.fillStyle = `rgba(${pal.upRgb}, ${alpha})`; ctx.fillRect(x, y, upW, h);
        ctx.fillStyle = `rgba(${pal.downRgb}, ${alpha})`; ctx.fillRect(x + upW, y, w - upW, h);
        if (i === profile.poc) {
          ctx.fillStyle = pal.poc;
          ctx.fillRect(0, y + Math.floor(h / 2), bitmapSize.width, Math.max(1, Math.round(vr)));
        }
      }
    });
  }
}

/**
 * Series primitive for the index chart: option-chain open interest per strike, drawn at each strike's
 * price along the right edge of the pane. CE OI (call writers, resistance) sits just above the strike
 * level in red, PE OI (put writers, support) just below in green; the biggest of each is labelled.
 */
export class OiProfilePrimitive {
  constructor() { this.strikes = []; this.visible = true; this.paneView = { zOrder: () => 'bottom', renderer: () => ({ draw: target => this.draw(target) }) }; }
  attached({ series, requestUpdate }) { this.series = series; this.requestUpdate = requestUpdate; }
  detached() { this.series = this.requestUpdate = null; }
  setData(strikes) { this.strikes = (strikes || []).filter(r => Number.isFinite(r.strike)).sort((a, b) => a.strike - b.strike); this.requestUpdate?.(); }
  setVisible(on) { this.visible = !!on; this.requestUpdate?.(); }
  updateAllViews() {}
  paneViews() { return [this.paneView]; }
  draw(target) {
    if (!this.visible || !this.series || this.strikes.length < 2) return;
    const oi = (row, side) => Number(row[side]?.oi) || 0;
    const max = Math.max(...this.strikes.map(r => Math.max(oi(r, 'ce'), oi(r, 'pe'))));
    if (!(max > 0)) return;
    const top = (side) => this.strikes.reduce((best, r) => oi(r, side) > oi(best, side) ? r : best, this.strikes[0]);
    const maxCe = top('ce'), maxPe = top('pe'), pal = chartPalette();
    const gap = Math.abs(this.series.priceToCoordinate(this.strikes[1].strike) - this.series.priceToCoordinate(this.strikes[0].strike));
    if (!Number.isFinite(gap)) return;
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      const maxWidth = bitmapSize.width * VP_WIDTH, h = Math.max(1, Math.floor(Math.min(gap * 0.42, 9) * vr));
      ctx.font = `${Math.round(9 * vr)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      ctx.textBaseline = 'middle';
      for (const row of this.strikes) {
        const yMedia = this.series.priceToCoordinate(row.strike);
        if (yMedia == null || yMedia < -gap || yMedia * vr > bitmapSize.height + gap * vr) continue;
        const y = Math.round(yMedia * vr);
        for (const [side, y0, rgb, best] of [['ce', y - h, pal.downRgb, maxCe], ['pe', y + 1, pal.upRgb, maxPe]]) {
          const value = oi(row, side);
          if (!value) continue;
          const w = Math.max(1, Math.round(maxWidth * value / max)), x = bitmapSize.width - w;
          ctx.fillStyle = `rgba(${rgb}, ${row === best ? 0.8 : 0.4})`;
          ctx.fillRect(x, y0, w, h);
          if (row === best) {
            const text = `${side.toUpperCase()} ${row.strike} ${formatOi(value)}`;
            ctx.fillStyle = `rgb(${rgb})`;
            ctx.fillText(text, x - ctx.measureText(text).width - Math.round(4 * hr), y0 + h / 2);
          }
        }
      }
    });
  }
}

/** Put-call ratio of the chain's open interest, e.g. "0.87". */
export function putCallRatio(strikes) {
  let ce = 0, pe = 0;
  for (const r of strikes || []) { ce += Number(r.ce?.oi) || 0; pe += Number(r.pe?.oi) || 0; }
  return ce > 0 ? (pe / ce).toFixed(2) : '--';
}

/** Open interest in lakh / crore contracts, e.g. 12.40L. */
export function formatOi(n) {
  const v = Number(n) || 0;
  if (v >= 1e7) return `${(v / 1e7).toFixed(2)}Cr`;
  if (v >= 1e5) return `${(v / 1e5).toFixed(2)}L`;
  return v.toLocaleString('en-IN');
}

/** Latest OI and its change since the first bar of the latest session (bar times in seconds). */
export function oiSummary(bars) {
  const withOi = (bars || []).filter(c => c.oi > 0);
  const last = withOi.at(-1);
  if (!last) return '--';
  const day = t => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
  const open = withOi.find(c => day(c.time) === day(last.time));
  const change = open && open.oi ? (last.oi - open.oi) / open.oi * 100 : 0;
  return `${formatOi(last.oi)} (${change >= 0 ? '+' : ''}${change.toFixed(1)}%)`;
}
