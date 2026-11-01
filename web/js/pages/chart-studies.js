// Chart indicators for Power Scalper (TradingView-style "Indicators"): definitions, defaults and maths.
// Pure functions on candles [{time (s), open, high, low, close, volume}], oldest first, so they are unit
// tested on the server. These only draw on the charts; the Algo Trading rules have their own fixed maths.

const IST_DAY = t => new Date(t * 1000 + 19_800_000).toISOString().slice(0, 10);
const SOURCES = [['close', 'Close'], ['open', 'Open'], ['high', 'High'], ['low', 'Low'], ['hl2', '(H+L)/2'], ['hlc3', '(H+L+C)/3']];
const source = (c, s) => s === 'open' ? c.open : s === 'high' ? c.high : s === 'low' ? c.low
  : s === 'hl2' ? (c.high + c.low) / 2 : s === 'hlc3' ? (c.high + c.low + c.close) / 3 : c.close;

/** Every study: label, where it draws (price chart or its own pane), parameters and line colours. */
export const STUDIES = {
  ema: { label: 'EMA', name: 'Exponential moving average', pane: false, params: [['length', 'Length', 9, 1, 500], ['source', 'Source', 'close', SOURCES]],
    lines: [['value', 'EMA', '#4ea1ff']], title: p => `EMA ${p.length}` },
  sma: { label: 'SMA', name: 'Simple moving average', pane: false, params: [['length', 'Length', 20, 1, 500], ['source', 'Source', 'close', SOURCES]],
    lines: [['value', 'SMA', '#e879f9']], title: p => `SMA ${p.length}` },
  vwap: { label: 'VWAP', name: 'Volume-weighted average price (resets each session)', pane: false, params: [['source', 'Source', 'hlc3', SOURCES]],
    lines: [['value', 'VWAP', '#f59e0b']], title: () => 'VWAP' },
  bb: { label: 'BB', name: 'Bollinger Bands', pane: false, params: [['length', 'Length', 20, 2, 500], ['mult', 'Std dev', 2, 0.1, 10]],
    lines: [['upper', 'Upper', '#7c9cff'], ['middle', 'Basis', '#f59e0b'], ['lower', 'Lower', '#7c9cff']], title: p => `BB ${p.length} ${p.mult}` },
  supertrend: { label: 'Supertrend', name: 'Supertrend', pane: false, params: [['length', 'ATR length', 10, 1, 200], ['factor', 'Factor', 3, 0.1, 20]],
    lines: [['up', 'Up trend', '#22c55e'], ['down', 'Down trend', '#ef4444']], title: p => `Supertrend ${p.length} ${p.factor}` },
  rsi: { label: 'RSI', name: 'Relative strength index', pane: true, params: [['length', 'Length', 14, 2, 200], ['upper', 'Upper band', 70, 50, 100], ['lower', 'Lower band', 30, 0, 50]],
    lines: [['value', 'RSI', '#a78bfa']], title: p => `RSI ${p.length}` },
  macd: { label: 'MACD', name: 'Moving average convergence divergence', pane: true, params: [['fast', 'Fast length', 12, 1, 200], ['slow', 'Slow length', 26, 2, 400], ['signal', 'Signal length', 9, 1, 100]],
    lines: [['macd', 'MACD', '#4ea1ff'], ['signal', 'Signal', '#f59e0b'], ['hist', 'Histogram', '#22c55e']], title: p => `MACD ${p.fast} ${p.slow} ${p.signal}` },
};

let seq = 0;
/** A new study with its default parameters (colours null = theme default). */
export function newStudy(type, overrides = {}) {
  const def = STUDIES[type];
  const params = Object.fromEntries(def.params.map(([k, , d]) => [k, d]));
  return { id: `${type}-${Date.now().toString(36)}-${(seq++).toString(36)}`, type, params: { ...params, ...overrides }, colors: {}, width: 2, visible: true };
}
/** What a chart shows the first time: EMA 9 and EMA 21, as before. */
export const defaultStudies = () => [newStudy('ema', { length: 9 }), newStudy('ema', { length: 21 })].map((s, i) => ({ ...s, id: `ema-default-${i}` }));

/** Clean a saved list (unknown types dropped, parameters clamped to their ranges). */
export function sanitizeStudies(list) {
  if (!Array.isArray(list)) return null;
  return list.filter(s => s && STUDIES[s.type]).slice(0, 12).map(s => {
    const def = STUDIES[s.type], params = {};
    for (const [k, , d, min, max] of def.params) {
      const v = s.params?.[k];
      if (Array.isArray(min)) params[k] = min.some(([o]) => o === v) ? v : d;
      else { const n = Number(v); params[k] = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; }
    }
    const colors = {};
    for (const [k] of def.lines) if (/^#[0-9a-f]{6}$/i.test(s.colors?.[k] || '')) colors[k] = s.colors[k];
    return { id: String(s.id || newStudy(s.type).id), type: s.type, params, colors, width: [1, 2, 3, 4].includes(Number(s.width)) ? Number(s.width) : 2, visible: s.visible !== false };
  });
}

// ---- maths -------------------------------------------------------------------------------------------
export function emaOf(values, n) {
  const k = 2 / (n + 1); let v = null;
  return values.map(x => (v = v === null ? x : x * k + v * (1 - k)));   // seeded with the first value, as the chart always was
}
export function smaOf(values, n) {
  let sum = 0;
  return values.map((x, i) => { sum += x; if (i >= n) sum -= values[i - n]; return i >= n - 1 ? sum / n : null; });
}
function rmaOf(values, n) {   // Wilder's smoothing
  let v = null, sum = 0;
  return values.map((x, i) => {
    if (v === null) { sum += x; if (i === n - 1) v = sum / n; return v; }
    return (v = (v * (n - 1) + x) / n);
  });
}
const pts = (data, values) => data.map((c, i) => values[i] == null || !Number.isFinite(values[i]) ? null : { time: c.time, value: values[i] }).filter(Boolean);

/** Lines for one study: { key: [{time, value, color?}] }. */
export function computeStudy(study, data) {
  const p = study.params, src = data.map(c => source(c, p.source));
  switch (study.type) {
    case 'ema': return { value: pts(data, emaOf(src, p.length)) };
    case 'sma': return { value: pts(data, smaOf(src, p.length)) };
    case 'vwap': {
      let day = '', pv = 0, vol = 0;
      return { value: pts(data, data.map((c, i) => {
        const d = IST_DAY(c.time); if (d !== day) { day = d; pv = 0; vol = 0; }
        const v = Number(c.volume) || 0; pv += src[i] * v; vol += v;
        return vol > 0 ? pv / vol : src[i];
      })) };
    }
    case 'bb': {
      const mid = smaOf(data.map(c => c.close), p.length);
      const dev = data.map((_, i) => {
        if (mid[i] == null) return null;
        let s = 0; for (let j = i - p.length + 1; j <= i; j++) s += (data[j].close - mid[i]) ** 2;
        return Math.sqrt(s / p.length);
      });
      return { upper: pts(data, mid.map((m, i) => m == null ? null : m + p.mult * dev[i])), middle: pts(data, mid),
        lower: pts(data, mid.map((m, i) => m == null ? null : m - p.mult * dev[i])) };
    }
    case 'supertrend': {
      const tr = data.map((c, i) => i ? Math.max(c.high - c.low, Math.abs(c.high - data[i - 1].close), Math.abs(c.low - data[i - 1].close)) : c.high - c.low);
      const atr = rmaOf(tr, p.length), up = [], down = [];
      let fu = null, fl = null, dir = 1;
      data.forEach((c, i) => {
        if (atr[i] == null) { up.push(null); down.push(null); return; }
        const hl2 = (c.high + c.low) / 2, bu = hl2 + p.factor * atr[i], bl = hl2 - p.factor * atr[i], prev = data[i - 1]?.close ?? c.close;
        fu = fu === null || bu < fu || prev > fu ? bu : fu;
        fl = fl === null || bl > fl || prev < fl ? bl : fl;
        if (dir === 1 && c.close < fl) dir = -1; else if (dir === -1 && c.close > fu) dir = 1;
        up.push(dir === 1 ? fl : null); down.push(dir === -1 ? fu : null);
      });
      return { up: pts(data, up), down: pts(data, down) };
    }
    case 'rsi': {
      const ch = data.map((c, i) => i ? c.close - data[i - 1].close : 0);
      const g = rmaOf(ch.slice(1).map(x => Math.max(0, x)), p.length), l = rmaOf(ch.slice(1).map(x => Math.max(0, -x)), p.length);
      return { value: pts(data, [null, ...g.map((x, i) => x == null ? null : l[i] === 0 ? 100 : 100 - 100 / (1 + x / l[i]))]) };
    }
    case 'macd': {
      const close = data.map(c => c.close), slow = emaOf(close, p.slow), macd = emaOf(close, p.fast).map((f, i) => f - slow[i]);
      const signal = emaOf(macd, p.signal);
      return { macd: pts(data, macd), signal: pts(data, signal), hist: pts(data, macd.map((m, i) => m - signal[i])) };
    }
    default: return {};
  }
}
