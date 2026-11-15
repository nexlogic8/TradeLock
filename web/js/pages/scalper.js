import { html, $, on, $$ } from '../core/dom.js';
import { get, post, put, del } from '../core/api.js';
import { icon } from '../ui/icons.js';
import { toast, toastError } from '../ui/toast.js';
import { createChart, CandlestickSeries, HistogramSeries, LineSeries, CrosshairMode, createSeriesMarkers } from '../vendor/lightweight-charts.standalone.production.mjs';
import { emaRejectionMarkers, openingRangeChartSignals, openingRangeMarkers, alignMarkersToBars, emaCrossSignals, emaCrossMarkers, emaScalpSignals, emaScalpMarkers, EMA_SCALP_35 } from './scalper-chart-signals.js';
import { store } from '../core/store.js';
import { chartPalette } from './chart-palette.js';
import { STUDIES, computeStudy, newStudy, defaultStudies, sanitizeStudies } from './chart-studies.js';
import { VolumeProfilePrimitive, OiProfilePrimitive, oiSummary, putCallRatio } from './scalper-chart-indicators.js';
import { SmcPrimitive, gapSignals, gapByDay, regroup, GAP_SIGNAL } from './scalper-chart-smc.js';
import { DrawingLayer, mountDrawRail } from './scalper-chart-draw.js';
import { PositionOverlay } from './scalper-chart-position.js';
import { LevelOverlay } from './scalper-chart-levels.js?v=20261115-plus-hover1';

const money = n => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// EMA pair by chart interval: 1-minute charts use 45/105 (the EMA45 hammer strategy), every other
// interval 9/21. The hammer markers belong to the 1-minute strategy, so they only show there.
export const emaPeriods = interval => String(interval) === '1' ? { fast:45, slow:105 } : { fast:9, slow:21 };
const showsHammerMarkers = interval => String(interval) === '1';
const time = n => n ? new Date(n).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }) : '—';
// Index being traded (server: scalper/underlyings.js). The page keys everything off the loaded chain.
// Dhan has short market-data outages (HTTP 5xx, timeouts). Retry those quietly before showing an error;
// account problems (reconnect, Data APIs subscription) and bad requests fail at once.
const RETRYABLE = new Set([0, 502, 503, 504]);
// Snapshots of each index (chain + charts) so switching index paints at once; the other indices are
// preloaded in the background and kept fresh, and the live feed updates prices after the switch.
const snapshots = new Map(), inflight = new Map();
const SNAPSHOT_FRESH_MS = 120_000, SNAPSHOT_MAX_MS = 15 * 60_000;
function fetchSnapshot(underlying, interval) {
  const key = `${underlying}|${interval}`;
  if (inflight.has(key)) return inflight.get(key);
  const request = loadChain(`/scalper?interval=${interval}&underlying=${underlying}`)
    .then(data => { snapshots.set(key, { data, at: Date.now() }); return data; })
    .finally(() => inflight.delete(key));
  inflight.set(key, request);
  return request;
}
function applySnapshot(ui, data) {
  const atm = data.strikes.reduce((best, row) => !best || Math.abs(row.strike - data.underlying.ltp) < Math.abs(best.strike - data.underlying.ltp) ? row : best, null);
  ui.ceId = atm?.ce?.securityId;
  ui.peId = atm?.pe?.securityId;
  ui.selectedStrike = atm?.strike;
  ui.ceCandles = data.selectedCharts.ce;
  ui.peCandles = data.selectedCharts.pe;
  ui.ceOpeningRange = data.selectedOpeningRanges?.ce;
  ui.peOpeningRange = data.selectedOpeningRanges?.pe;
  ui.error = data.historyWarning || '';
}
async function loadChain(url, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    try { return await get(url); }
    catch (e) {
      if (attempt >= tries || !RETRYABLE.has(e?.status) || e?.code === 'DHAN_DATA_API_REQUIRED') throw e;
      await new Promise(resolve => setTimeout(resolve, attempt * 2500));
    }
  }
}
// Chart intervals offered. The 1-minute chart is switched off for now; Power Scalper starts at 5 minutes.
export const INTERVALS = [['1','1 min'],['5','5 min'],['15','15 min'],['25','25 min'],['60','1 hour']];
/**
 * One trade at a time: while a position is open, an order is pending at the broker, or the last order
 * is still being confirmed, new entries are blocked. Returns the reason, or '' when a trade can be taken.
 */
export function runningTrade(state, ui = {}) {
  const d = state?.dash, open = (d?.positions || []).find(p => Number(p.qty) !== 0);
  // Manual trading is always allowed, also while Algo Trading is on; one trade at a time.
  if (open) return `A trade is running (${open.symbol}). Exit it from Positions before taking the next one.`;
  if ((d?.orders || []).length) return 'An order is pending at the broker. Cancel it or let it fill before the next trade.';
  if (ui.orderInFlight && Date.now() - ui.orderInFlight < 20_000) return 'Your last order is being confirmed by the broker…';
  return '';
}
const INDICES = [['NIFTY','NIFTY 50'],['BANKNIFTY','BANK NIFTY'],['SENSEX','SENSEX']];
// MCX commodity options (server: scalper/underlyings.js MCX_UNDERLYINGS), shown when the MCX switch is on.
const MCX_LIST = [['CRUDEOILM','CRUDE OIL MINI'],['GOLDM','GOLD MINI']];
const ALL_UNDERLYINGS = [...INDICES, ...MCX_LIST];
const isMcxKey = key => MCX_LIST.some(([k]) => k === key);
// The market switch at the start of the toolbar: NIFTY (the indices) | MCX (the commodities). Each side shows only its
// own instruments and reopens the one last used on it.
const lastOf = mcx => { try { const v = localStorage.getItem(mcx ? 'tradelock.scalper.lastMcx' : 'tradelock.scalper.lastIndex'); return (mcx ? MCX_LIST : INDICES).some(([k]) => k === v) ? v : (mcx ? 'CRUDEOILM' : 'NIFTY'); } catch { return mcx ? 'CRUDEOILM' : 'NIFTY'; } };
const underlyingsFor = current => (isMcxKey(current) ? MCX_LIST : INDICES);
const marketSwitch = current => html`<div class="seg sc-market" role="group" aria-label="Market">${[[false, 'NIFTY', 'Indices: NIFTY 50, BANK NIFTY, SENSEX'], [true, 'MCX', 'MCX commodity options: Crude Oil Mini and Gold Mini (09:00 to 23:30 / 23:55)']].map(([mcx, label, hint]) =>
  html`<button type="button" data-underlying="${isMcxKey(current) === mcx ? current : lastOf(mcx)}" aria-pressed="${String(isMcxKey(current) === mcx)}" title="${hint}" class="${mcx ? 'sc-mcx' : ''}">${label}</button>`)}</div>`;
// Phones show one pane at a time: a chart or the option chain.
export const MOBILE_PANES = [['spot', 'Index'], ['ce', 'CE'], ['pe', 'PE'], ['chain', 'Chain']];
export const LAYOUTS = [['classic', 'Classic', 'layoutClassic', 'Classic: 3 charts, option chain and order tickets'], ['split', 'Split', 'layoutSplit', 'Split: index chart left, Call over Put right, one-tap orders on each chart']];
// Right-hand strip (desktop): opens the side panel on a section; the active one again closes it.
const RAIL = [['chain', 'Option chain', 'optionChain'], ['positions', 'Positions', 'briefcase'], ['both', 'Both', 'panelBoth']];
const SIDE_PANELS = [['chain','Option chain'],['positions','Positions'],['both','Both']];
const spotId = d => String(d?.underlying?.securityId || '13');
const optionSegment = d => d?.optionSegment || 'NSE_FNO';
// The spot chart's segment: IDX_I for an index, MCX_COMM for the future an MCX chain sits on.
const spotSegment = d => d?.underlying?.exchangeSegment || 'IDX_I';
const pref = (key, allowed, fallback) => { try { const v = localStorage.getItem(key); return allowed.includes(v) ? v : fallback; } catch { return fallback; } };
// Chart strategies: each can be switched on or off; the choice is remembered in this browser.
export const STRATEGIES = [
  ['orb', 'ORB 5m', 'Opening-range (09:15-09:20) breakout with next-candle confirmation · 1- and 5-minute charts'],
  ['hammer', 'Hammer 1m', 'EMA45 wick-touch hammer with breakout confirmation · 1-minute chart'],
  ['emaCross', 'EMA 9/21', 'EMA 9 / EMA 21 crossover arrows · 5-minute chart. Chart only (Algo Trading now trades EMA 5/9 on 1 minute); Algo Trading entries have their own switch on the AI Algo Trading page'],
  ['ema25', 'EMA 5/9 1m', 'Scalp: EMA 5 / EMA 9 crossover on the 1-minute chart (up: CE, down: PE); the opposite crossover is the exit. Chart signal only'],
  ['ema35', 'EMA 3/5 1m', 'Scalp: EMA 3 / EMA 5 crossover on the 1-minute chart (up: CE, down: PE); the opposite crossover is the exit. Chart signal and backtest'],
];
// Chart strategy signals are for administrators only; other users get clean charts (server: lib/access.js).
const isAdmin = () => !!store.get().user?.admin;
const strategyPrefs = () => {
  const out = Object.fromEntries(STRATEGIES.map(([key]) => [key, isAdmin()]));
  if (!isAdmin()) return out;
  try { Object.assign(out, JSON.parse(localStorage.getItem('tradelock.scalper.strategies') || '{}')); } catch { /* defaults */ }
  return out;
};
const hammerOff = key => key === 'hammer' && !INTERVALS.some(([v]) => v === '1');
/** Full screen pick-one menu (index, interval, session), styled like the Strategy dropdown.
 *  options: [value, menu label, short button label?] */
function scmMenu(key, label, current, options) {
  const short = ([v, l, s]) => s || l, now = options.find(([v]) => String(v) === String(current)) || options[0];
  return html`<div class="scm-menu scm-menu-${key}"><button type="button" class="scm-tool scm-menu-btn" data-scm-menu="${key}" aria-haspopup="menu" aria-expanded="false" aria-label="${label}"><b data-scm-menu-label="${key}">${short(now)}</b><span aria-hidden="true">▾</span></button>
    <div class="scm-strat-pop scm-menu-pop" data-scm-menu-pop="${key}" role="menu" aria-label="${label}" hidden>${options.map(o => html`<button type="button" class="scm-check scm-radio" role="menuitemradio" data-scm-pick="${key}" data-value="${o[0]}" data-short="${short(o)}" aria-checked="${String(String(o[0]) === String(current))}"><i aria-hidden="true"></i><b>${o[1]}</b></button>`)}</div></div>`;
}
/** Full screen "Strategy" dropdown: the same chart strategies as checkboxes. */
function strategyChecks(ui) {
  const on = ui.strategies || {};
  return STRATEGIES.map(([key, label, hint]) => html`<button type="button" class="scm-check" role="menuitemcheckbox" data-strategy="${key}" aria-checked="${String(on[key] !== false && !hammerOff(key))}" title="${hammerOff(key) ? 'Needs the 1-minute chart, which is switched off for now' : hint}" ${hammerOff(key) ? 'disabled' : ''}><i aria-hidden="true"></i><b>${label}</b></button>`);
}
/** Manual lots switch: off = auto lots from the risk rules (locked boxes), on = lots typed or set with − / +. */
function lotModeSwitch(ui, compact = false) {
  const on = !!ui.manualMode, hint = 'Manual lots: on = type the lots or use − / + (remembered per instrument); off = auto from your risk rules';
  return compact
    ? html`<button type="button" class="sc-lotmode-m" role="switch" data-lot-mode-toggle aria-checked="${String(on)}" aria-label="Manual lots" title="${hint}"><span class="lm-auto">Auto</span><i aria-hidden="true"></i><span class="lm-manual">Manual</span></button>`
    : html`<button type="button" class="sc-strategy sc-lotmode" role="switch" data-lot-mode-toggle aria-checked="${String(on)}" title="${hint}"><i aria-hidden="true"></i>Manual lots</button>`;
}
function strategySwitches(ui) {
  if (!isAdmin()) return '';
  const on = ui.strategies || {};
  return html`<div class="scalper-control sc-strategies"><small>Strategies</small><div class="sc-strategy-list" role="group" aria-label="Chart strategies">${STRATEGIES.map(([key, label, hint]) =>
    html`<button type="button" class="sc-strategy" role="switch" data-strategy="${key}" aria-checked="${String(on[key] !== false && (key !== 'hammer' || INTERVALS.some(([v]) => v === '1')))}" title="${key === 'hammer' && !INTERVALS.some(([v]) => v === '1') ? 'Needs the 1-minute chart, which is switched off for now' : hint}" ${key === 'hammer' && !INTERVALS.some(([v]) => v === '1') ? 'disabled' : ''}><i aria-hidden="true"></i>${label}</button>`)}</div></div>`;
}
// Built-in chart overlays, switched in the Indicators panel (all three charts): volume profile, open interest
// and the previous session's high / low lines.
const INDICATORS = [
  ['vp', 'Volume profile', 'Volume profile of the candles in view · brighter band = 70% value area · line = point of control'],
  ['oi', 'Open interest', 'Open interest · index chart: option-chain OI per strike (red CE above, green PE below) · option charts: OI line'],
  ['prev', 'Prev day H/L', 'Previous session high and low lines on each chart (index, CE and PE)'],
  ['sig', 'Gap BUY signals', 'BUY arrows on the CE / PE charts and CE BUY / PE BUY on the index (index options only). CE only on a gap-up day, PE only on a gap-down day; price above VWAP, EMA 9 above EMA 21, then an SMC break up or an ICT sell-side sweep; at most 2 a day; 3-minute candles on the 1-minute chart. Backtest NIFTY ITM1, 25 May – 13 Nov 2026, 1 lot after costs: +₹39,050 over 199 trades (44% won). Not a guarantee: try it on Paper first.'],
  ['smc', 'SMC', 'Smart Money Concepts · BOS (dashed) and CHoCH (solid) where a close breaks the last swing high / low · Bull OB (blue) / Bear OB (orange): the last opposite candle before the break, shown until price closes through it'],
  ['ict', 'ICT', 'ICT concepts · BSL / SSL: resting liquidity above swing highs / below swing lows (EQH / EQL when equal), ✕ sweep where a wick takes it and closes back · Premium / Discount of the dealing range with its 50% EQ line · OTE: the 62–79% retracement of the last swing leg'],
  ['fib', 'Fib 0.5 / 0.66', 'Fibonacci retracement of the last swing leg · gold lines at 0.5 and 0.66 (where a pull-back often holds), faint 0 and 1 at the leg ends · each labelled with its price'],
  ['fvg', 'FVG', 'Fair value gaps · 3-candle imbalances: green = bullish gap, red = bearish gap · bright until price fills it, then faint'],
];
// Default chart setup per market, for a new user and for "Reset to default". Each market keeps its own changes.
//   NIFTY: trend EMA 9 / 21 and VWAP; volume profile, OI, previous-day levels, ICT liquidity and FVG entry zones.
//   MCX:   EMA 9 / 21, VWAP and Supertrend 10 / 3 (crude and gold trend in the evening); volume profile, previous-day
//          levels, ICT liquidity sweeps and Fib 0.5 / 0.66 pull-backs. (No OI profile: MCX options OI is thin.)
export const MARKET_DEFAULTS = {
  nse: { label:'NIFTY', builtin:{ sig:true, vp:true, oi:true, prev:true, smc:false, ict:true, fib:false, fvg:true },
    studies: () => [newStudy('ema', { length:9 }), newStudy('ema', { length:21 }), newStudy('vwap')] },
  mcx: { label:'MCX', builtin:{ sig:false, vp:true, oi:false, prev:true, smc:false, ict:true, fib:true, fvg:false },
    studies: () => [newStudy('ema', { length:9 }), newStudy('ema', { length:21 }), newStudy('vwap'), newStudy('supertrend', { length:10, factor:3 })] },
};
export const marketOf = underlying => (isMcxKey(underlying) ? 'mcx' : 'nse');
// The market the page shows now (set on load and on an instrument switch): which saved setup the charts use.
let currentMarket = 'nse';
const indicatorKey = market => `tradelock.scalper.indicators.${market}`;
const indicatorPrefs = (market = currentMarket) => {
  const out = { ema9:true, ema21:true, volume:true, ...MARKET_DEFAULTS[market].builtin };
  // NIFTY falls back to the single setup saved before markets had their own, so existing users keep theirs.
  const read = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
  const saved = read(indicatorKey(market)) || (market === 'nse' ? read('tradelock.scalper.indicators') : null) || {};
  for (const [key] of INDICATORS) if (typeof saved[key] === 'boolean') out[key] = saved[key];
  return out;
};
const savePref = (key, value) => { try { localStorage.setItem(key, value); } catch { /* private window */ } };
// Lots set by hand: kept for this instrument and side (0 = auto) and saved for the user, so the page opens with them
// again on the web and in the app. Quick − / + taps send one save, half a second after the last.
const lotSaves = {};
function rememberLots(ui, side) {
  const key = ui.underlying, lots = ui.manualLots?.[side] || 0;
  if (!key) return;
  ui.savedLots = { ...ui.savedLots, [key]: { ...(ui.savedLots?.[key] || {}), [side]: lots } };
  if (!lots) delete ui.savedLots[key][side];
  clearTimeout(lotSaves[`${key}|${side}`]);
  lotSaves[`${key}|${side}`] = setTimeout(() => put('/scalper/lots', { underlying:key, side, lots }).catch(() => { /* kept for this visit */ }), 500);
}
// The chosen expiry, remembered per index (NIFTY / BANKNIFTY / SENSEX); '' forgets it.
const savedExpiryFor = underlying => { try { const v = localStorage.getItem(`tradelock.scalper.expiry.${underlying}`) || ''; return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : ''; } catch { return ''; } };
const saveExpiry = (underlying, expiry) => { try { if (expiry) localStorage.setItem(`tradelock.scalper.expiry.${underlying}`, expiry); else localStorage.removeItem(`tradelock.scalper.expiry.${underlying}`); } catch { /* private window */ } };
// How much history the charts show: the last 1 (default), 2 or 5 sessions, or a month (index and option charts
// load a month). Any span can be scrolled back to the oldest loaded candle.
const SPANS = [['1d', '1D', 'Today’s session (last session when the market is closed)'], ['2d', '2D', 'Last 2 sessions'], ['5d', '5D', 'Last 5 sessions'], ['1m', '1M', 'Last month']];
const SPAN_DAYS = { '1d':1, '2d':2, '5d':5, '1m':23 };
let chartSpan = pref('tradelock.scalper.span', SPANS.map(([k]) => k), '1d');
/** Show the chosen span: starts at the first candle of the oldest of the last N sessions in the data. */
function fitSpan(view) {
  const data = view?.data || [], ts = view?.chart?.timeScale();
  if (!ts || !data.length) return;
  view.autoFit = true;   // follows size changes until the user zooms or scrolls this chart
  if (!view.host?.clientWidth) return;   // not laid out yet: the size observer fits it when it is
  // Walk back over the last N trading sessions present in the data (1D / 2D / 5D / 1M).
  let sessions = 1, first = data.length - 1, day = istDay(Number(data.at(-1).time) * 1000);
  while (first > 0) {
    const prev = istDay(Number(data[first - 1].time) * 1000);
    if (prev !== day) { if (sessions >= (SPAN_DAYS[chartSpan] || 1)) break; sessions++; day = prev; }
    first--;
  }
  ts.setVisibleLogicalRange({ from: first - 0.5, to: data.length + 3 });
}
const signedInr = n => `${n > 0 ? '+' : n < 0 ? '−' : ''}₹${Math.abs(Math.round(n || 0)).toLocaleString('en-IN')}`;
/** Strike spacing around the ATM (far strikes can be wider, e.g. BANKNIFTY 500 away from the money). */
function strikeStep(strikes, atm) {
  const near = strikes.map(r => r.strike).filter(k => Math.abs(k - atm) <= 1000).sort((a, b) => a - b);
  const gaps = near.slice(1).map((k, i) => k - near[i]).filter(g => g > 0);
  return gaps.length ? Math.min(...gaps) : 50;
}
// Phone full screen ("scalping window"): top bar, index chart, one option chart (Call/Put), order bar.
const istClock = () => new Date(Date.now() + 19_800_000).toISOString().slice(11, 19);
const optionLabel = (item, option) => {
  const kind = option === 'CE' ? 'Call' : 'Put';
  if (!item) return kind;
  const day = new Date(`${item.expiry}T12:00:00Z`).toLocaleDateString('en-IN', { day:'2-digit', month:'short', timeZone:'UTC' });
  return `${day} ${item.strike} ${kind}`;
};
function scmTop(ctx) {
  const dash = ctx.state?.dash, pnl = Number(Number.isFinite(dash?.netPnl) ? dash.netPnl : dash?.pnl) || 0, open = (dash?.positions || []).filter(p => Number(p.qty) !== 0).length;
  return html`<div class="scm-top">
    <button type="button" class="scm-x" data-exit-focus aria-label="Exit full screen">${icon('x')}</button>
    <span class="scm-clock" data-scm-clock>${istClock()}</span>
    <button type="button" class="scm-chip" data-open-sheet="positions">P&amp;L <b data-scm-pnl class="${pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : ''}">${signedInr(pnl)}</b></button>
    <button type="button" class="scm-chip" data-open-sheet="positions">Positions <i data-scm-poscount>${open}</i></button>
  </div>`;
}
const isFocusPhone = () => typeof window !== 'undefined' && window.innerWidth <= 760 && document.body?.classList.contains('scalper-focus');
const isFocus = () => typeof document !== 'undefined' && document.body?.classList.contains('scalper-focus');

export default {
  title: 'Power Scalper',
  sub: 'Live index charts and option chain (Dhan data) with protected orders at your trading broker',
  layout: 'app', auth: true,

  async load(ctx) {
    ctx.ui.error = '';
    // Opens on the interval and index last chosen in this browser (5-minute NIFTY the first time).
    if (!INTERVALS.some(([v]) => v === ctx.ui.interval)) ctx.ui.interval = pref('tradelock.scalper.interval', INTERVALS.map(([v]) => v), '5');
    ctx.ui.underlying = ctx.ui.underlying || pref('tradelock.scalper.underlying', ALL_UNDERLYINGS.map(([k]) => k), 'NIFTY');
    ctx.ui.strategies = ctx.ui.strategies || strategyPrefs();
    ctx.ui.mSide = ctx.ui.mSide === 'pe' ? 'pe' : 'ce';
    ctx.ui.layout = ctx.ui.layout || pref('tradelock.scalper.layout', LAYOUTS.map(([k]) => k), 'classic');
    ctx.ui.mPane = ctx.ui.mPane || pref('tradelock.scalper.mPane', MOBILE_PANES.map(([k]) => k), 'spot');
    ctx.ui.sidePanel = ctx.ui.sidePanel || pref('tradelock.scalper.sidePanel', SIDE_PANELS.map(([k]) => k), 'chain');
    ctx.ui.panelOpen ??= pref('tradelock.scalper.panelOpen', ['open', 'closed'], 'open') === 'open';
    currentMarket = marketOf(ctx.ui.underlying);
    if (ctx.ui.indicatorsMarket !== currentMarket) { ctx.ui.indicators = indicatorPrefs(); ctx.ui.indicatorsMarket = currentMarket; }
    // The chain comes first (one quick Dhan call) and the three charts load once the page is up
    // (mount → loadPendingCharts), instead of holding the whole page behind Dhan's one-at-a-time history.
    const appFocus = typeof window !== 'undefined' && window.TradeLockApp && window.innerWidth <= 760;
    if (appFocus) document.body.classList.add('scalper-focus');
    let data;
    // The expiry last chosen for this index; once it has expired the server answers with the nearest one.
    const savedExpiry = savedExpiryFor(ctx.ui.underlying), base = `/scalper?interval=${ctx.ui.interval}&charts=0&underlying=${ctx.ui.underlying}`;
    try {
      try { data = await loadChain(savedExpiry ? `${base}&expiry=${encodeURIComponent(savedExpiry)}` : base); }
      catch (e) { if (!savedExpiry || e?.code !== 'INVALID_EXPIRY') throw e; saveExpiry(ctx.ui.underlying, ''); data = await loadChain(base); }
    }
    catch (e) { if (appFocus) document.body.classList.remove('scalper-focus'); throw e; }   // the error page keeps the menu
    if (savedExpiry && data.expiry !== savedExpiry) saveExpiry(ctx.ui.underlying, '');   // it expired: back to the nearest
    data.underlying.candles = [];
    data.selectedCharts = { ...data.selectedCharts, ce: [], pe: [] };
    // Lots set by hand, remembered per instrument and side for this user (web and app); auto when none saved.
    if (!ctx.ui.savedLots) {
      try { const r = await get('/scalper/lots'); ctx.ui.savedLots = r.lots || {}; ctx.ui.manualMode = !!r.manual; }
      catch { ctx.ui.savedLots = {}; ctx.ui.manualMode = false; }
    }
    ctx.ui.manualLots = { ...(ctx.ui.savedLots[ctx.ui.underlying] || {}) };
    applySnapshot(ctx.ui, data);
    ctx.ui.chartsPending = true;
    return data;
  },

  view(ctx) {
    const d = ctx.data, ce = d.strikes.find(x => String(x.ce?.securityId) === String(ctx.ui.ceId))?.ce || null;
    const pe = d.strikes.find(x => String(x.pe?.securityId) === String(ctx.ui.peId))?.pe || null;
    const atmStrike = d.strikes.reduce((best, row) => !best || Math.abs(row.strike - d.underlying.ltp) < Math.abs(best.strike - d.underlying.ltp) ? row : best, null)?.strike;
    const optionRows = d.strikes.filter(row => Math.abs(row.strike - Number(atmStrike)) <= 12 * strikeStep(d.strikes, Number(atmStrike)));
    const indexName = d.underlying.symbol || 'NIFTY 50', focus = isFocus();
    const current = ctx.ui.underlying || d.underlyingKey || 'NIFTY', sidePanel = ctx.ui.sidePanel || 'chain';
    lotsEditable = !!ctx.ui.manualMode;
    return html`
      ${scmTop(ctx)}
      <section class="panel scalper-toolbar">
        <div class="scalper-symbol"><span class="scalper-logo">${icon('chart')}</span><b>Power Scalper</b><span class="pill sm ice">Dhan</span></div>
        ${marketSwitch(current)}
        <div class="seg sc-underlyings" role="group" aria-label="Index">${underlyingsFor(current).map(([key, label]) => html`<button type="button" data-underlying="${key}" aria-pressed="${String(current === key)}" class="${isMcxKey(key) ? 'sc-mcx' : ''}">${label}</button>`)}</div>
        <label class="scalper-control"><small>Expiry</small><select class="input" id="sc-expiry">${d.expiries.map(x => html`<option value="${x}" ${x === d.expiry ? 'selected' : ''}>${x}</option>`)}</select></label>
        <label class="scalper-control"><small>Chart interval</small><select class="input" id="sc-interval">${INTERVALS.map(([v,l]) => html`<option value="${v}" ${v === ctx.ui.interval ? 'selected' : ''}>${l}</option>`)}</select></label>
        <div class="scalper-control sc-span"><small>Session</small><div class="seg" role="group" aria-label="Chart history">${SPANS.map(([k, l, hint]) => html`<button type="button" data-span="${k}" aria-pressed="${String(chartSpan === k)}" title="${hint}">${l}</button>`)}</div></div>
        ${strategySwitches(ctx.ui)}
        ${lotModeSwitch(ctx.ui)}
        <div class="sc-view-tools">
          <button type="button" class="btn btn-ghost btn-sm sc-fullscreen" id="sc-fullscreen" aria-pressed="${String(focus)}" title="${focus ? 'Exit full screen (Esc)' : 'Full screen'}">${icon(focus ? 'shrink' : 'expand')}<span class="sc-fs-text">${focus ? 'Exit full screen' : html`<span class="sc-fs-long">Full screen<span class="sc-fs-trade"> · trade</span></span><span class="sc-fs-short">Trade</span>`}</span></button>
          <div class="seg sc-layout" role="group" aria-label="Layout">${LAYOUTS.map(([key, label, ic, hint]) => html`<button type="button" data-layout="${key}" aria-pressed="${String((ctx.ui.layout || 'classic') === key)}" title="${hint}" aria-label="${label} layout">${icon(ic)}</button>`)}</div>
        </div>
        <div class="scalper-feed"><i></i><span data-feed-label>Connecting live feed</span></div>
      </section>

      <div data-scalper-error>${errorBanner(ctx.ui.error)}</div>
      <div class="seg sc-mpanes" role="tablist" aria-label="Show">${MOBILE_PANES.map(([key, label]) => html`<button type="button" role="tab" data-mpane="${key}" aria-selected="${String((ctx.ui.mPane || 'spot') === key)}">${key === 'ce' || key === 'pe' ? html`<i class="sc-mtag ${key}"></i>` : ''}${label}</button>`)}</div>
      <div class="scalper-workspace mpane-${ctx.ui.mPane || 'spot'} ${ctx.ui.panelOpen === false ? 'panel-closed' : ''}">
        <section class="scalper-chart-grid mside-${ctx.ui.mSide || 'ce'}" aria-label="Live ${indexName} and option charts">
          <div class="scm-bar scm-index">
            ${scmMenu('index', 'Index', current, ALL_UNDERLYINGS.map(([key, label]) => [key, label]))}
            <b class="scm-px" data-spot>${money(d.underlying.ltp)}</b>
            ${isAdmin() ? html`<button type="button" class="scm-tool" data-scm-strats aria-haspopup="menu" aria-expanded="false" title="Chart strategies">Strategy<span aria-hidden="true">▾</span></button>` : ''}
            <button type="button" class="scm-tool scm-fx" data-studies="spot" aria-haspopup="dialog" title="Indicators">ƒx</button>
            ${scmMenu('interval', 'Chart interval', ctx.ui.interval, INTERVALS.map(([v, l]) => [v, l, l.replace(' min', 'm').replace('1 hour', '1h')]))}
            ${scmMenu('span', 'Chart history', chartSpan, SPANS.map(([k, l, hint]) => [k, `${l} · ${hint.replace(' (last session when the market is closed)', '')}`, l]))}
            ${isAdmin() ? html`<div class="scm-strat-pop" data-scm-strat-pop role="menu" aria-label="Chart strategies" hidden>${strategyChecks(ctx.ui)}</div>` : ''}
          </div>
          <div class="scm-bar scm-side">
            <button type="button" class="scm-side-pick" data-open-sheet="chain" title="Option chain: pick another strike"><b class="scm-ce">${optionLabel(ce, 'CE')}</b><b class="scm-pe">${optionLabel(pe, 'PE')}</b><span class="scm-px"><b class="scm-ce" data-ltp="ce">${money(ce?.ltp)}</b><b class="scm-pe" data-ltp="pe">${money(pe?.ltp)}</b></span><span class="scm-caret" aria-hidden="true">▾</span></button>
            <button type="button" class="scm-swap" data-mside-toggle title="Switch between Call and Put" aria-label="Switch between Call and Put">⇅</button>
          </div>
          ${chartPanel('CALL', ce, 'ce', ctx.ui.ceCandles, d.underlying.ltp, ctx.ui.interval, headerOrder(ctx, ce, 'ce'), ctx.ui.indicators)}
          ${chartPanel(indexName, { symbol:indexName, ltp:d.underlying.ltp, change:0, exchangeSegment:spotSegment(d) }, 'spot', d.underlying.candles, d.underlying.ltp, ctx.ui.interval, null, ctx.ui.indicators)}
          ${chartPanel('PUT', pe, 'pe', ctx.ui.peCandles, d.underlying.ltp, ctx.ui.interval, headerOrder(ctx, pe, 'pe'), ctx.ui.indicators)}
        </section>
        <aside class="panel scalper-chain side-${sidePanel} ${ctx.ui.loadingExpiry ? 'is-loading' : ''}" aria-busy="${ctx.ui.loadingExpiry ? 'true' : 'false'}">
          <button type="button" class="scm-grab" data-close-sheet aria-label="Close"></button>
          <div class="sc-panel-head"><div><span class="eyebrow">${indexName} · LIVE</span><h3>${d.expiry}</h3><select class="scm-select scm-expiry" data-scm-expiry aria-label="Expiry">${d.expiries.map(x => html`<option value="${x}" ${x === d.expiry ? 'selected' : ''}>${x}</option>`)}</select></div><button class="btn btn-ghost btn-sm" id="sc-refresh" title="Refresh option-chain snapshot">${icon('refresh')} Refresh</button></div>
          <div class="seg sc-side-toggle" role="group" aria-label="Show in this panel">${SIDE_PANELS.map(([key, label]) => html`<button type="button" data-side-panel="${key}" aria-pressed="${String(sidePanel === key)}">${label}</button>`)}</div>
          <div class="sc-chain-block">
          <div class="sc-chain-head"><span>CE LTP</span><span>CALL</span><span>STRIKE</span><span>PUT</span><span>PE LTP</span></div>
          <div class="sc-chain-body">${optionRows.length ? optionRows.map(row => html`<div class="sc-chain-row ${row.strike === Number(atmStrike) ? 'atm' : ''} ${row.strike === Number(ctx.ui.selectedStrike) ? 'picked' : ''}" data-chain-strike="${row.strike}">
            <button class="sc-chain-price ce" data-select-contract="ce" data-strike="${row.strike}" title="Select ${row.strike} CE">${money(row.ce?.ltp)}</button>
            <span class="sc-chain-greek">${row.ce?.delta ? `Δ ${row.ce.delta.toFixed(2)}` : '—'}</span>
            <b>${row.strike.toLocaleString('en-IN')}</b>
            <span class="sc-chain-greek">${row.pe?.delta ? `Δ ${row.pe.delta.toFixed(2)}` : '—'}</span>
            <button class="sc-chain-price pe" data-select-contract="pe" data-strike="${row.strike}" title="Select ${row.strike} PE">${money(row.pe?.ltp)}</button>
          </div>`) : html`<div class="sc-chain-empty" role="status">No contracts returned for this expiry. Refresh or choose another expiry.</div>`}</div>
          <div class="sc-chain-foot">ATM <b data-chain-atm>${atmStrike?.toLocaleString('en-IN') || '—'}</b><span>Updated ${time(d.asOf)}</span></div>
          </div>
          <div class="sc-positions" data-sc-positions>${positionsBlock(ctx)}</div>
        </aside>
        <nav class="sc-rail" aria-label="Side panel">${RAIL.map(([key, label, ic]) => html`<button type="button" data-rail="${key}" aria-pressed="${String(ctx.ui.panelOpen !== false && sidePanel === key)}" title="${label}">${icon(ic)}<span>${label}</span></button>`)}</nav>
      </div>

      <div class="scm-scrim" data-close-sheet></div>
      <section class="scalper-tickets mside-${ctx.ui.mSide || 'ce'}">
        <div class="scm-ordertype">${lotModeSwitch(ctx.ui, true)}</div>
        ${ticket('CALL', 'CE', ce, d.lotSize, ctx.ui.margins?.ce, ctx.ui.signalRisk, runningTrade(ctx.state, ctx.ui), manualOf(ctx.ui, 'ce'))}
        <div class="panel sc-position-summary"><span class="eyebrow">${indexName}</span><b data-spot>${money(d.underlying.ltp)}</b><div class="sc-range"><span>${money(d.underlying.candles.at(-1)?.low)}</span><i><em></em></i><span>${money(d.underlying.candles.at(-1)?.high)}</span></div><button class="btn btn-ghost btn-sm" data-side-panel="positions">Show positions</button><small>All orders go through TradeLock risk rules and Dhan.</small></div>
        ${ticket('PUT', 'PE', pe, d.lotSize, ctx.ui.margins?.pe, ctx.ui.signalRisk, runningTrade(ctx.state, ctx.ui), manualOf(ctx.ui, 'pe'))}
      </section>
      <p class="scalper-disclaimer">Live prices may be delayed or unavailable during market closures. Check the contract and quantity before placing an order. TradeLock risk rules can block any order. Charts by <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">TradingView Lightweight Charts</a>.</p>`;
  },

  draw(ctx) {
    const d = ctx.data;
    fitWorkspace(ctx);
    keepChainCentred(ctx);
    const selected = {
      ce: { rows: ctx.ui.ceCandles || [], id: ctx.ui.ceId, openingRange:ctx.ui.ceOpeningRange },
      spot: { rows: d.underlying.candles || [], id: spotId(d), openingRange:d.openingRange },
      pe: { rows: ctx.ui.peCandles || [], id: ctx.ui.peId, openingRange:ctx.ui.peOpeningRange },
    };
    ctx.ui.chartViews ||= {};
    for (const [key, value] of Object.entries(selected)) {
      const host = $(`.sc-chart-host[data-chart="${key}"]`, ctx.el);
      let view = ctx.ui.chartViews[key];
      if (!host) { view?.draw?.destroy(); view?.pos?.destroy(); view?.levels?.destroy(); view?.chart.remove(); delete ctx.ui.chartViews[key]; continue; }
      if (!view || view.host !== host) {
        // Keep the user's zoom only when the same contract and interval are redrawn.
        let range, priceRange;
        if (view) {
          if (view.instrumentId === String(value.id || '') && view.interval === ctx.ui.interval && !view.autoFit) {
            range = view.chart.timeScale().getVisibleLogicalRange();
            // Pinning the range turns auto-scale off, so only do it if the user had zoomed the price axis.
            const scale = view.chart.priceScale('right');
            if (scale.options().autoScale === false) priceRange = scale.getVisibleRange();
          }
          view.sizeWatch?.disconnect(); view.draw?.destroy(); view.pos?.destroy(); view.levels?.destroy(); view.chart.remove();
        }
        view = ctx.ui.chartViews[key] = createChartView(host, value.rows, ctx.ui.indicators, key, ctx.ui.interval, ctx);
        view.instrumentId = String(value.id || '');
        view.draw?.setKey(view.instrumentId);
        view.interval = ctx.ui.interval;
        if (range && value.rows.length > 1) { view.autoFit = false; view.chart.timeScale().setVisibleLogicalRange(range); }
        if (priceRange && Number.isFinite(priceRange.from) && Number.isFinite(priceRange.to)) view.chart.priceScale('right').setVisibleRange(priceRange);
      } else {
        view.instrumentId = String(value.id || '');
        view.draw?.setKey(view.instrumentId);
        setChartData(view, value.rows, ctx.ui.indicators, ctx.ui.interval);
      }
      setOpeningRange(view, value.openingRange);
      setPreviousDayRange(view, value.rows);
      if (view.oiProfile) { view.oiProfile.setData(d.strikes); showIndicators(view, ctx.ui.indicators); }
    }
    mountDrawRail($('.scalper-chart-grid', ctx.el));   // one drawing-tool rail for the three charts
    refreshChartPositions(ctx);
    refreshSignalMarkers(ctx);
  },

  // Live broker sync (positions and P&L) only redraws the positions block, never the charts.
  onStore(ctx, patch) {
    // Light / dark switch: re-colour the open charts in place (no reload, zoom kept).
    if ('theme' in patch) {
      for (const view of Object.values(ctx.ui.chartViews || {})) restyleChart(view);
      refreshSignalMarkers(ctx);
    }
    if ('pnl' in patch && !patch.dash) {
      // Live P&L from market ticks: the positions panel and the P&L chip, without the rest of the sync work.
      refreshPositions(ctx);
      const d = ctx.state.dash, pnl = Number(Number.isFinite(d?.netPnl) ? d.netPnl : d?.pnl) || 0, chip = $('[data-scm-pnl]', ctx.el);
      if (chip) { chip.textContent = signedInr(pnl); chip.className = pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : ''; }
      return;
    }
    if (!patch.dash) return;
    refreshPositions(ctx);
    refreshChartPositions(ctx);
    const pnl = Number(Number.isFinite(patch.dash.netPnl) ? patch.dash.netPnl : patch.dash.pnl) || 0, chip = $('[data-scm-pnl]', ctx.el), count = $('[data-scm-poscount]', ctx.el);
    if (chip) { chip.textContent = signedInr(pnl); chip.className = pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : ''; }
    if (count) count.textContent = String((patch.dash.positions || []).filter(p => Number(p.qty) !== 0).length);
    // A fill showing up (or the position closing) changes whether the next trade is allowed.
    if (ctx.ui.orderInFlight && (patch.dash.positions || []).some(p => Number(p.qty) !== 0)) ctx.ui.orderInFlight = 0;
    updateTickets(ctx);
  },

  mount(ctx) {
    const { el, signal, ui } = ctx;
    // Per-trade risk budget for sizing the order tickets (daily stop-loss ÷ trades per day).
    const refreshRisk = async () => {
      try {
        const risk = await get('/scalper/signal-risk');
        if (signal.aborted) return;
        ui.signalRisk = risk;
      } catch { ui.signalRisk = null; }
      updateTickets(ctx);
    };
    const riskTimer = setInterval(refreshRisk, 30_000);
    refreshRisk();
    // Preload the other indices (one at a time) and keep them fresh, so switching index is instant.
    const preload = async () => {
      await ui.chartsLoading;   // this index's own charts first: Dhan answers history requests one at a time
      for (const [key] of underlyingsFor(ui.underlying)) {
        if (signal.aborted) return;
        const snap = snapshots.get(`${key}|${ui.interval}`);
        if (key === ui.underlying || (snap && Date.now() - snap.at < SNAPSHOT_FRESH_MS)) continue;
        try { await fetchSnapshot(key, ui.interval); } catch { /* a switch to it simply loads normally */ }
      }
    };
    const preloadStart = setTimeout(preload, 1500), preloadTimer = setInterval(preload, SNAPSHOT_FRESH_MS);
    signal.addEventListener('abort', () => { clearInterval(riskTimer); clearTimeout(preloadStart); clearInterval(preloadTimer); }, { once:true });
    let socket, reconnectTimer, flushTimer, candleFallbackTimer, lastTickPaint = 0, expirySeq = 0, feedLive = false;
    ui.lastTickAtById ||= {};
    ui.lastCandleRefreshAtById ||= {};
    // Remember a manual scroll of the option chain (scroll events do not bubble, so listen in capture).
    el.addEventListener('scroll', e => { if (e.target.matches?.('.sc-chain-body')) ui.chainScroll = e.target.scrollTop; }, { capture:true, signal });
    // Charts hold ResizeObservers and canvases; free them when the page goes away.
    signal.addEventListener('abort', () => {
      for (const view of Object.values(ui.chartViews || {})) { view.sizeWatch?.disconnect(); view.draw?.destroy(); view.pos?.destroy(); view.levels?.destroy(); try { view.chart.remove(); } catch {} }
      ui.chartViews = {};
    }, { once:true });
    const showError = message => {
      ui.error = message || '';
      const slot = $('[data-scalper-error]', el);
      if (slot) slot.innerHTML = String(errorBanner(ui.error));
    };
    // Put fresh candle history into an existing chart without rebuilding the page.
    const applyCandles = (key, id, data) => {
      if (signal.aborted) return;
      if (key === 'spot') { ctx.data.underlying.candles = data.candles; ctx.data.openingRange = data.openingRange; }
      else {
        if (String(ui[`${key}Id`]) !== String(id)) return;
        ui[`${key}Candles`] = data.candles; ui[`${key}OpeningRange`] = data.openingRange;
      }
      const view = ui.chartViews?.[key];
      if (!view || view.instrumentId !== String(id)) return;
      const visible = view.chart.timeScale().getVisibleLogicalRange();
      const wasEmpty = !view.data?.length, wasFollowing = visible && (view.data?.length - 1 - visible.to) < 8;
      setChartData(view, data.candles, ui.indicators, ui.interval);
      if (wasEmpty || view.autoFit) fitSpan(view);
      else if (wasFollowing) view.chart.timeScale().scrollToRealTime();
      setOpeningRange(view, data.openingRange);
      setPreviousDayRange(view, data.candles);
      refreshSignalMarkers(ctx);
    };
    // Charts for a page that was loaded chain-first (see load).
    ui.loadPendingCharts = async () => {
      if (!ui.chartsPending) return;
      ui.chartsPending = false;
      const underlying = ui.underlying, sides = [['spot', spotId(ctx.data)], ['ce', ui.ceId], ['pe', ui.peId]].filter(([, id]) => id);
      await Promise.all(sides.map(async ([key, id]) => {
        try {
          const chart = await get(`/scalper/candles?securityId=${encodeURIComponent(id)}&interval=${ui.interval}&underlying=${underlying}`);
          if (ui.underlying === underlying) applyCandles(key, id, chart);
        } catch (e) { if (!signal.aborted) showError(e.message); }
      }));
    };
    ui.chartsLoading = ui.loadPendingCharts();
    const watched = () => {
      const atm = ctx.data.strikes.reduce((best, row) => !best || Math.abs(row.strike - ctx.data.underlying.ltp) < Math.abs(best.strike - ctx.data.underlying.ltp) ? row : best, null);
      const around = [...ctx.data.strikes].sort((a,b) => Math.abs(a.strike - atm.strike) - Math.abs(b.strike - atm.strike)).slice(0, 24);
      const index = spotId(ctx.data);
      return [...new Set([index, ui.ceId, ui.peId, ...around.flatMap(x => [x.ce?.securityId, x.pe?.securityId]).filter(Boolean).map(String)])]
        .map(id => id === index ? { securityId: id, exchangeSegment: spotSegment(ctx.data) } : { securityId: id, exchangeSegment: optionSegment(ctx.data) });
    };
    const connect = () => {
      if (signal.aborted) return;
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${scheme}//${location.host}/api/scalper/live`);
      socket.addEventListener('open', async () => {
        socket.send(JSON.stringify({ type:'watch', instruments: watched() }));
        // Reconcile after reconnect so a device also catches changes made while it was offline.
        try { const { alerts } = await get('/alerts'); if (!signal.aborted) setLocalAlerts(ctx, () => alerts || []); } catch { /* the live push remains primary */ }
      });
      socket.addEventListener('message', event => {
        let msg; try { msg = JSON.parse(event.data); } catch { return; }
        if (msg.type === 'status') {
          feedLive = msg.status === 'live';
          const label = $('[data-feed-label]', el), box = $('.scalper-feed', el);
          if (label) label.textContent = msg.status === 'live' ? 'Live' : msg.message || 'Connecting live feed';
          box?.classList.toggle('live', msg.status === 'live');
          box?.classList.toggle('offline', ['unavailable','reconnecting'].includes(msg.status));
        } else if (msg.type === 'error') {
          showError(msg.message);
        } else if (msg.type === 'tick') {
          // Ticks flowing means the feed is live, whatever status message arrived first.
          if (!feedLive) { feedLive = true; const label = $('[data-feed-label]', el); if (label) label.textContent = 'Live'; $('.scalper-feed', el)?.classList.add('live'); $('.scalper-feed', el)?.classList.remove('offline'); }
          applyTick(ctx, msg);
        } else if (msg.type === 'alerts' && Array.isArray(msg.alerts)) {
          // Account-scoped server push: create, move, fire or delete on another device.
          setLocalAlerts(ctx, () => msg.alerts);
        }
      });
      socket.addEventListener('close', () => { if (!signal.aborted) reconnectTimer = setTimeout(connect, 2500); });
      socket.addEventListener('error', () => { try { socket.close(); } catch {} });
    };
    connect();
    flushTimer = setInterval(() => {
      if (Date.now() - lastTickPaint < 180) return;
      if (!ui.tickDirty) return;
      ui.tickDirty = false; lastTickPaint = Date.now(); updateLiveCharts(ctx); updateLiveLabels(ctx); updateTickets(ctx); refreshChartPositions(ctx);
    }, 200);
    const refreshStaleCandles = async () => {
      const now = Date.now(), market = isMarketSession(now, ctx.data?.session);
      if (signal.aborted) return;
      const charts = [['spot',spotId(ctx.data)],['ce',ui.ceId],['pe',ui.peId]];
      const rowsOf = key => key === 'spot' ? ctx.data.underlying.candles : ui[`${key}Candles`];
      // Live: refresh when ticks pause. Any time: retry a chart whose history failed to load.
      const stale = charts.filter(([key,id]) => id && (rowsOf(key)?.length
        ? market && now - (ui.lastTickAtById[id] || 0) > 10_000 && now - (ui.lastCandleRefreshAtById[id] || 0) > 15_000
        : now - (ui.lastCandleRefreshAtById[id] || 0) > 20_000));
      await Promise.all(stale.map(async ([key,id]) => {
        ui.lastCandleRefreshAtById[id] = now;
        try {
          applyCandles(key, id, await get(`/scalper/candles?securityId=${encodeURIComponent(id)}&interval=${ui.interval}&fresh=1&underlying=${ui.underlying}`));
        } catch { /* Dhan candle refresh is a fallback when websocket ticks pause. */ }
      }));
      if (ctx.data.historyWarning && ui.error === ctx.data.historyWarning && charts.every(([key,id]) => !id || rowsOf(key)?.length)) showError('');
    };
    candleFallbackTimer = setInterval(refreshStaleCandles, 5_000);
    signal.addEventListener('abort', () => { clearInterval(flushTimer); clearInterval(candleFallbackTimer); clearTimeout(reconnectTimer); socket?.close(); }, { once:true });

    // Expiry switch: show the new chain as soon as it arrives, then fill the CE/PE charts.
    // Only the latest selection may apply, so quick consecutive changes cannot overwrite each other.
    on(el, 'change', '#sc-expiry, [data-scm-expiry]', async (_, input) => {
      const token = ++expirySeq, expiry = input.value;
      saveExpiry(ui.underlying, expiry);
      showError('');
      ui.loadingExpiry = expiry;
      $('.scalper-chain', el)?.classList.add('is-loading');
      try {
        const data = await get(`/scalper?expiry=${encodeURIComponent(expiry)}&interval=${ui.interval}&charts=0&underlying=${ui.underlying}`);
        if (signal.aborted || token !== expirySeq) return;
        data.underlying.candles = ctx.data.underlying.candles; data.openingRange = ctx.data.openingRange;
        ctx.data = data;
        const atm = data.strikes.find(row => row.strike === data.selectedCharts.atm);
        ui.selectedStrike = atm?.strike; ui.ceId = atm?.ce?.securityId; ui.peId = atm?.pe?.securityId;
        ui.ceCandles = []; ui.peCandles = []; ui.ceOpeningRange = null; ui.peOpeningRange = null;
        ui.loadingExpiry = null; ctx.paint(); ui.refreshMarginsSoon?.();
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type:'watch', instruments: watched() }));
        await Promise.all(['ce','pe'].map(async side => {
          const id = ui[`${side}Id`];
          if (!id) return;
          const chart = await get(`/scalper/candles?securityId=${encodeURIComponent(id)}&interval=${ui.interval}&underlying=${ui.underlying}`);
          if (token === expirySeq) applyCandles(side, id, chart);
        }));
      } catch (e) {
        if (signal.aborted || token !== expirySeq) return;
        if (ui.loadingExpiry) { ui.loadingExpiry = null; ctx.paint(); }
        showError(e.message);
      }
    }, signal);
    // Phones: switch the visible pane (charts size themselves when shown; the chain re-centres on ATM).
    on(el, 'click', '[data-mpane]', (_, button) => {
      const pane = button.dataset.mpane;
      ui.mPane = pane; savePref('tradelock.scalper.mPane', pane);
      for (const b of $$('[data-mpane]', el)) b.setAttribute('aria-selected', String(b.dataset.mpane === pane));
      const ws = $('.scalper-workspace', el);
      if (ws) ws.className = ws.className.replace(/\bmpane-\w+/, `mpane-${pane}`);
      button.closest('.sc-mpanes')?.scrollIntoView({ block:'start', behavior:'smooth' });
      // The chain was hidden (zero height) while another pane showed, so centre it on ATM afresh.
      if (pane === 'chain') requestAnimationFrame(() => centreChain(ctx));
    }, signal);
    on(el, 'click', '[data-strategy]', (_, button) => {
      const key = button.dataset.strategy, next = !(ui.strategies?.[key] !== false);
      ui.strategies = { ...ui.strategies, [key]: next };
      savePref('tradelock.scalper.strategies', JSON.stringify(ui.strategies));
      for (const b of $$(`[data-strategy="${key}"]`, el)) b.setAttribute('aria-checked', String(next));
      refreshSignalMarkers(ctx);
    }, signal);
    on(el, 'change', '#sc-interval', async (_, input) => {
      ui.interval = input.value; savePref('tradelock.scalper.interval', ui.interval);
      try {
        const ids = [spotId(ctx.data), ui.ceId, ui.peId];
        const [spot, ce, pe] = await Promise.all(ids.map(id => get(`/scalper/candles?securityId=${encodeURIComponent(id)}&interval=${ui.interval}&underlying=${ui.underlying}`)));
        ctx.data.underlying.candles=spot.candles; ctx.data.openingRange=spot.openingRange;
        ui.ceCandles=ce.candles; ui.ceOpeningRange=ce.openingRange; ui.peCandles=pe.candles; ui.peOpeningRange=pe.openingRange;
      }
      catch (e) { ui.error = e.message; }
      ctx.paint();
    }, signal);
    on(el, 'click', '[data-select-contract]', async (_, button) => {
      const side = button.dataset.selectContract, row = ctx.data.strikes.find(x => x.strike === Number(button.dataset.strike));
      if (!row?.[side]) return;
      // Phone full screen: a pick in the chain sheet closes the sheet and shows that side under the index chart.
      if (document.body.classList.contains('scm-sheet')) { setSheet(false); ui.mSide = side; }
      const id = row[side].securityId;
      ui.selectedStrike = row.strike; ui[`${side}Id`] = id; ui[`${side}Candles`] = []; ui[`${side}OpeningRange`] = null; ctx.paint(); ui.refreshMarginsSoon?.();
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type:'watch', instruments: watched() }));
      try { applyCandles(side, id, await get(`/scalper/candles?securityId=${encodeURIComponent(id)}&interval=${ui.interval}&underlying=${ui.underlying}`)); }
      catch (e) { if (!signal.aborted) showError(e.message); }
    }, signal);
    on(el, 'click', '#sc-refresh', async (_, button) => {
      if (button.disabled) return;
      button.disabled = true;
      try {
        const data = await get(`/scalper?expiry=${encodeURIComponent(ctx.data.expiry)}&interval=${ui.interval}&fresh=1&underlying=${ui.underlying}`);
        const atm = data.strikes.find(row => row.strike === data.selectedCharts.atm);
        const charts = await Promise.all(['ce','pe'].map(async side => {
          if (String(ui[`${side}Id`]) === String(atm?.[side]?.securityId)) return { candles:data.selectedCharts[side], openingRange:data.selectedOpeningRanges?.[side] };
          const chart = await get(`/scalper/candles?securityId=${encodeURIComponent(ui[`${side}Id`])}&interval=${ui.interval}&fresh=1&underlying=${ui.underlying}`);
          return { candles:chart.candles, openingRange:chart.openingRange };
        }));
        ctx.data = data; [ui.ceCandles, ui.peCandles] = charts.map(x=>x.candles);
        [ui.ceOpeningRange,ui.peOpeningRange] = charts.map(x=>x.openingRange); ui.error = ''; ctx.paint();
      } catch (e) { ui.error=e.message; ctx.paint(); }
      finally { button.disabled = false; }
    }, signal);
    // Funds each ticket needs: fetched from Dhan's margin calculator on lots/contract change and
    // every 20 s; the Buy amount in between follows live ticks (see updateTickets).
    const marginSeq = { ce:0, pe:0 };
    const refreshMargins = async (sides = ['ce','pe']) => {
      if (signal.aborted || document.hidden) return;
      await Promise.all(sides.map(async side => {
        const item = strikeIndex(ctx.data).byId.get(String(ui[`${side}Id`])), lots = sizeOf(ctx, side, item).lots;
        if (!(item?.ltp > 0) || !lots) return;
        const token = ++marginSeq[side];
        try {
          const r = await get(`/scalper/margin?securityId=${encodeURIComponent(item.securityId)}&lots=${lots}&price=${item.ltp}&underlying=${ui.underlying}`);
          if (signal.aborted || token !== marginSeq[side]) return;
          ui.margins = { ...ui.margins, [side]: { ...r, securityId:String(item.securityId), lots } };
          if (!ctx.data.lotSize && r.lotSize) { ctx.data.lotSize = r.lotSize; ctx.paint(); }
        } catch { /* keep the last figure; the next refresh retries */ }
      }));
      updateTickets(ctx);
    };
    const marginDebounce = {};
    const refreshMarginsSoon = (sides = ['ce','pe']) => {
      for (const side of sides) { clearTimeout(marginDebounce[side]); marginDebounce[side] = setTimeout(() => refreshMargins([side]), 450); }
    };
    ui.refreshMarginsSoon = refreshMarginsSoon;
    const marginTimer = setInterval(refreshMargins, 20_000);
    setTimeout(refreshMargins, 1500);   // after the first ticks have filled in live prices
    signal.addEventListener('abort', () => { clearInterval(marginTimer); Object.values(marginDebounce).forEach(clearTimeout); }, { once:true });

    // Lots by hand: − / + start from the lots shown (auto or manual), 1 to 500 lots; the server's risk gate still checks
    // every order. Tapping the lots label / number goes back to auto sizing from the risk rules.
    on(el, 'click', '[data-lot-step]', (_, button) => {
      if (!ui.manualMode) return;   // auto lots: switch Manual lots on first
      const side = button.dataset.lotSide, item = strikeIndex(ctx.data).byId.get(String(ui[`${side}Id`]));
      const now = sizeOf(ctx, side, item).lots || 0, step = Number(button.dataset.lotStep);
      ui.manualLots = { ...ui.manualLots, [side]: Math.min(500, Math.max(1, now + step)) };
      rememberLots(ui, side);
      updateTickets(ctx); refreshMarginsSoon([side]);
    }, signal);
    // Lots typed with the keyboard: digits only, applied on Enter or when the box is left (1–500; empty = no change),
    // and remembered like − / +. Escape puts back the lots shown before.
    on(el, 'input', '[data-lots]', (_, input) => { const v = input.value.replace(/\D/g, '').slice(0, 3); if (v !== input.value) input.value = v; }, signal);
    on(el, 'focusin', '[data-lots]', (_, input) => { input.dataset.before = input.value; setTimeout(() => input.select?.(), 0); }, signal);
    const applyTypedLots = input => {
      if (!ui.manualMode || input.readOnly) return;
      if (input.value === input.dataset.before) return;   // nothing typed (or Escape): leave it as it was
      const side = input.dataset.lots, typed = parseInt(input.value, 10);
      const item = strikeIndex(ctx.data).byId.get(String(ui[`${side}Id`])), shown = sizeOf(ctx, side, item).lots || 0;
      if (!(typed > 0)) { input.value = String(shown); return; }
      const lots = Math.min(500, typed);
      input.value = String(lots);
      if (lots === shown && ui.manualLots?.[side]) return;
      ui.manualLots = { ...ui.manualLots, [side]: lots };
      rememberLots(ui, side);
      updateTickets(ctx); refreshMarginsSoon([side]);
      if (typed > 500) toast('At most 500 lots.', 'warn');
    };
    on(el, 'keydown', '[data-lots]', (e, input) => {
      if (e.key === 'Enter') { e.preventDefault(); applyTypedLots(input); input.dataset.before = input.value; input.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); input.value = input.dataset.before || input.value; input.blur(); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); input.value = String(Math.min(500, Math.max(1, (parseInt(input.value, 10) || 0) + (e.key === 'ArrowUp' ? 1 : -1)))); }
    }, signal);
    on(el, 'focusout', '[data-lots]', (_, input) => applyTypedLots(input), signal);
    // Manual lots switch (toolbar, and the full-screen bar on phones): off = auto lots from the risk rules, locked;
    // on = the lots last set for this instrument (or the auto ones to start from), typed or − / +. Saved for the user.
    on(el, 'click', '[data-lot-mode-toggle]', () => {
      ui.manualMode = !ui.manualMode;
      for (const b of $$('[data-lot-mode-toggle]', el)) { b.setAttribute('aria-checked', String(ui.manualMode)); const t = b.querySelector('[data-lot-mode-text]'); if (t) t.textContent = ui.manualMode ? 'Manual' : 'Auto'; }
      for (const n of $) n.textContent = ui.manualMode ? 'Manual lots: type them or use − / +' : 'Lots auto-sized from your risk rules';
      put('/scalper/lots/mode', { manual: ui.manualMode }).catch(() => { /* kept for this visit */ });
      updateTickets(ctx); refreshMarginsSoon();
      toast(ui.manualLots && ui.manualMode ? 'Manual lots: type or use − / +.' : 'Auto lots: sized from your risk rules.', 'ok');
    }, signal);

    on(el, 'click', '[data-order-side]', (_, button) => {
      // Just after the full-screen view (or a sheet) appears, a tap is still the one that opened it: the Sell / Buy
      // buttons sit where the Scalper tab was, so a quick second tap must not become an order.
      if (Date.now() < (ui.ordersReadyAt || 0)) return;
      const side = button.dataset.orderSide, option = button.dataset.option, key = option.toLowerCase();
      // Order exactly the contract shown on this ticket (not whichever strike was clicked last).
      const contract = strikeIndex(ctx.data).byId.get(String(ui[`${key}Id`]));
      const lotSize = ctx.data.lotSize, size = sizeOf(ctx, key, contract);
      if (!contract || !lotSize) return;
      const busy = runningTrade(ctx.state, ui);
      if (busy) { toast(busy, 'warn'); return; }
      if (!size.lots) { showError(size.reason); return; }
      // Units sent to Dhan: lots × lot size (MCX: Dhan counts lots, qtyPerLot 1).
      sendOrder({ side, contract:{ ...contract }, lots:size.lots, qty:size.lots * (ctx.data.qtyPerLot ?? lotSize), ltp:contract.ltp });
    }, signal);
    // Market order at the auto-sized lots, sent on the tap. The buttons lock at once (orderInFlight)
    // so a double tap cannot send twice.
    async function sendOrder(order) {
      ui.orderInFlight = Date.now();
      updateTickets(ctx);
      setTimeout(() => updateTickets(ctx), 20_500);
      const what = `${order.side} ${order.lots} lot${order.lots === 1 ? '' : 's'} (${order.qty}) ${order.contract.symbol}`;
      try {
        const result = await post('/orders', { symbol:order.contract.symbol, securityId:order.contract.securityId,
          exchangeSegment:order.contract.exchangeSegment, side:order.side, qty:order.qty, type:'MARKET', productType:'INTRADAY', ...(order.ltp > 0 ? { ltp:order.ltp } : {}) });
        toast(`${what} sent to Dhan (${result.order?.id || 'pending'}).`, 'ok');
        showError('');
      } catch (e) { ui.orderInFlight = 0; updateTickets(ctx); showError(e.message); toastError(e); }
    }
    // Index switch: reload the chain, charts and live feed for NIFTY / BANKNIFTY / SENSEX, or MCX: CRUDEOILM / GOLDM
    // (the NIFTY | MCX market switch carries the instrument last used on that side).
    on(el, 'click', '[data-underlying]', async (_, button) => {
      const key = button.dataset.underlying, previous = ui.underlying;
      if (key === previous || ui.switching) return;
      ui.switching = true; expirySeq++;
      ui.underlying = key; savePref('tradelock.scalper.underlying', key);
      savePref(isMcxKey(key) ? 'tradelock.scalper.lastMcx' : 'tradelock.scalper.lastIndex', key);
      // NIFTY ↔ MCX: the charts take that market's own setup.
      const marketChanged = marketOf(key) !== currentMarket;
      if (marketChanged) { currentMarket = marketOf(key); ui.indicators = indicatorPrefs(); ui.indicatorsMarket = currentMarket; }
      Object.assign(ui, { margins:{}, autoLots:{}, manualLots:{ ...(ui.savedLots?.[key] || {}) }, chainKey:null, chainScroll:null, lastTickAtById:{}, lastCandleRefreshAtById:{} });
      showError('');
      $('.scalper-workspace', el)?.classList.add('is-switching');
      try {
        const snap = snapshots.get(`${key}|${ui.interval}`);
        const wanted = savedExpiryFor(key);   // a remembered expiry other than the preloaded one: load that instead
        if (snap && Date.now() - snap.at < SNAPSHOT_MAX_MS && (!wanted || snap.data.expiry === wanted)) {
          // Instant: paint the preloaded snapshot; the live feed brings prices up to date.
          applySnapshot(ui, snap.data); ctx.data = snap.data; ctx.paint();
          if (Date.now() - snap.at > SNAPSHOT_FRESH_MS) fetchSnapshot(key, ui.interval).then(data => {
            if (signal.aborted || ui.underlying !== key) return;
            applySnapshot(ui, data); ctx.data = data; ctx.paint();
            if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type:'watch', instruments: watched() }));
          }).catch(() => {});
        } else { await ctx.reload(); ui.chartsLoading = ui.loadPendingCharts(); }
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type:'watch', instruments: watched() }));
        ui.refreshMarginsSoon?.();
        if (marketChanged) ui.applyMarketSetup?.();
      } catch (e) {
        ui.underlying = previous; savePref('tradelock.scalper.underlying', previous); showError(e.message);
        ui.manualLots = { ...(ui.savedLots?.[previous] || {}) };
        if (marketChanged) { currentMarket = marketOf(previous); ui.indicators = indicatorPrefs(); ui.indicatorsMarket = currentMarket; }
        $('.scalper-workspace', el)?.classList.remove('is-switching');
      } finally { ui.switching = false; }
    }, signal);
    // Full screen: hide the app's sidebar and header and ask the browser for full screen (Esc exits both).
    const setFocus = on => {
      if (on) ui.ordersReadyAt = Date.now() + 1200;
      document.body.classList.toggle('scalper-focus', on);
      const button = $('#sc-fullscreen', el);
      if (button) { button.setAttribute('aria-pressed', String(on)); button.innerHTML = `${icon(on ? 'shrink' : 'expand')}<span class="sc-fs-text">${on ? 'Exit full screen' : '<span class="sc-fs-long">Full screen<span class="sc-fs-trade"> · trade</span></span><span class="sc-fs-short">Trade</span>'}</span>`; }
      for (const view of Object.values(ui.chartViews || {})) view?.chart?.applyOptions({ handleScroll:{ vertTouchDrag:on } });
      requestAnimationFrame(() => { fitWorkspace(ctx); keepChainCentred(ctx); });
    };
    on(el, 'click', '#sc-fullscreen', async () => {
      // Inside the Android app the WebView mis-sizes the page in browser full screen; the focus layout alone is enough there.
      if (!isFocus()) { setFocus(true); if (!window.TradeLockApp) try { await document.documentElement.requestFullscreen?.({ navigationUI:'hide' }); } catch { /* focus layout still applies */ } }
      else { setFocus(false); if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {}); }
    }, signal);
    document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && isFocus()) setFocus(false); }, { signal });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && isFocus() && !document.fullscreenElement) setFocus(false); }, { signal });
    signal.addEventListener('abort', () => { document.body.classList.remove('scalper-focus'); if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {}); }, { once:true });
    // Android app on a phone: Power Scalper opens straight in the full-screen trading view (✕ shows the settings view).
    if (window.TradeLockApp && window.innerWidth <= 760) setFocus(true);
    // ---- Desktop layout: classic / split ----
    const applyLayout = layout => {
      document.body.classList.toggle('sc-split', layout === 'split');
      for (const b of $$('[data-layout]', el)) b.setAttribute('aria-pressed', String(b.dataset.layout === layout));
      requestAnimationFrame(() => { fitWorkspace(ctx); keepChainCentred(ctx); });
    };
    applyLayout(ui.layout);
    on(el, 'click', '[data-layout]', (_, button) => {
      ui.layout = button.dataset.layout; savePref('tradelock.scalper.layout', ui.layout); applyLayout(ui.layout);
    }, signal);
    signal.addEventListener('abort', () => document.body.classList.remove('sc-split'), { once:true });
    // ---- Phone full screen ----
    // ✕: in the Android app full screen *is* Power Scalper, so it goes back to the page it was opened from.
    on(el, 'click', '[data-exit-focus]', () => {
      if (window.TradeLockApp && window.innerWidth <= 760) {
        const prev = document.body.dataset.prevPage;
        if (prev && prev !== 'scalper') history.back();
        else document.querySelector('[data-nav="overview"]')?.click();   // opened straight on Scalper: go Home
        return;
      }
      if (isFocus()) $('#sc-fullscreen', el)?.click();
    }, signal);
    // Full screen dropdowns (Strategy, index, interval, session): one open at a time, a tap elsewhere closes.
    const closeMenus = () => {
      for (const pop of $$('[data-scm-strat-pop], [data-scm-menu-pop]', el)) pop.hidden = true;
      for (const b of $$('[data-scm-strats], [data-scm-menu]', el)) b.setAttribute('aria-expanded', 'false');
    };
    const toggleMenu = (button, pop) => {
      const open = pop?.hidden; closeMenus();
      if (pop && open) { pop.hidden = false; button.setAttribute('aria-expanded', 'true'); }
    };
    on(el, 'click', '[data-scm-strats]', (e, b) => { e.stopPropagation(); toggleMenu(b, $('[data-scm-strat-pop]', el)); }, signal);
    on(el, 'click', '[data-scm-menu]', (e, b) => { e.stopPropagation(); toggleMenu(b, $(`[data-scm-menu-pop="${b.dataset.scmMenu}"]`, el)); }, signal);
    on(el, 'click', '[data-scm-strat-pop]', e => e.stopPropagation(), signal);
    document.addEventListener('click', closeMenus, { signal });
    on(el, 'click', '[data-scm-pick]', (e, b) => {
      e.stopPropagation();
      const key = b.dataset.scmPick, value = b.dataset.value;
      for (const o of $$(`[data-scm-pick="${key}"]`, el)) o.setAttribute('aria-checked', String(o === b));
      const label = $(`[data-scm-menu-label="${key}"]`, el); if (label) label.textContent = b.dataset.short;
      closeMenus();
      // An instrument of the other market has no button showing: send it through that market's switch button.
      if (key === 'index') { const b = $(`.sc-underlyings [data-underlying="${value}"]`, el) || $(`.sc-market [data-underlying]${isMcxKey(value) ? '.sc-mcx' : ':not(.sc-mcx)'}`, el); if (b) { b.dataset.underlying = value; b.click(); } }
      else if (key === 'span') $(`[data-span="${value}"]`, el)?.click();
      else if (key === 'interval') { const main = $('#sc-interval', el); if (main && main.value !== value) { main.value = value; main.dispatchEvent(new Event('change', { bubbles:true })); } }
    }, signal);
    // Each second in full screen: the clock, and a re-fit of the two charts, so a banner appearing or going
    // (cutoff, errors) never leaves a gap or an overlap above the order bar. fitWorkspace only writes on change.
    const clock = setInterval(() => { const c = $('[data-scm-clock]', el); if (c && isFocus()) { c.textContent = istClock(); fitWorkspace(ctx); } }, 1000);
    // A sheet is a history step, so the phone's back button closes it before leaving the page.
    const setSheet = (open, fromHistory = false) => {
      const was = document.body.classList.contains('scm-sheet');
      document.body.classList.toggle('scm-sheet', open);
      if (open && !was) history.pushState({ scmSheet:1 }, '');
      else if (!open && was && !fromHistory && history.state?.scmSheet) history.back();
      if (!open && was) ui.ordersReadyAt = Math.max(ui.ordersReadyAt || 0, Date.now() + 400);
    };
    window.addEventListener('popstate', () => { if (document.body.classList.contains('scm-sheet')) setSheet(false, true); }, { signal });
    // Phones: option chain / positions open as a sheet.
    on(el, 'click', '[data-open-sheet]', (_, button) => {
      $(`.sc-side-toggle [data-side-panel="${button.dataset.openSheet}"]`, el)?.click();
      setSheet(true);
      requestAnimationFrame(() => centreChain(ctx));
    }, signal);
    // Desktop right strip: open the side panel on a section; the active section again closes the panel.
    const setPanel = (open, mode = ui.sidePanel) => {
      ui.panelOpen = open; savePref('tradelock.scalper.panelOpen', open ? 'open' : 'closed');
      if (open && mode !== ui.sidePanel) $(`.sc-side-toggle [data-side-panel="${mode}"]`, el)?.click();
      $('.scalper-workspace', el)?.classList.toggle('panel-closed', !open);
      for (const b of $$('[data-rail]', el)) b.setAttribute('aria-pressed', String(open && b.dataset.rail === ui.sidePanel));
      requestAnimationFrame(() => { fitWorkspace(ctx); if (open) centreChain(ctx); });
    };
    on(el, 'click', '[data-rail]', (_, button) => {
      const mode = button.dataset.rail;
      setPanel(!(ui.panelOpen !== false && ui.sidePanel === mode), mode);
    }, signal);
    on(el, 'click', '[data-close-sheet]', () => setSheet(false), signal);
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (document.body.classList.contains('scm-sheet')) { e.stopImmediatePropagation(); setSheet(false); }
    }, { signal, capture:true });
    const setSide = side => {
      ui.mSide = side;
      for (const node of $$('.scalper-chart-grid, .scalper-tickets', el)) node.className = node.className.replace(/\bmside-\w+/, `mside-${side}`);
    };
    on(el, 'click', '[data-mside-toggle]', () => setSide(ui.mSide === 'pe' ? 'ce' : 'pe'), signal);
    signal.addEventListener('abort', () => { clearInterval(clock); setSheet(false); }, { once:true });
    // Option chain / positions / both, switched in place (no chart rebuild).
    on(el, 'click', '[data-side-panel]', (_, button) => {
      const mode = button.dataset.sidePanel; ui.sidePanel = mode; savePref('tradelock.scalper.sidePanel', mode);
      const aside = $('.scalper-chain', el);
      aside?.classList.remove('side-chain', 'side-positions', 'side-both'); aside?.classList.add(`side-${mode}`);
      el.querySelectorAll('.sc-side-toggle [data-side-panel]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.sidePanel === mode)));
      el.querySelectorAll('[data-rail]').forEach(b => b.setAttribute('aria-pressed', String(ui.panelOpen !== false && b.dataset.rail === mode)));
      ui.chainScroll = null; ui.chainKey = null; keepChainCentred(ctx);
    }, signal);
    // Exit from the positions panel: first click arms, second click (within 5 s) sends the market exit.
    on(el, 'click', '[data-sc-exit]', async (_, button) => {
      const symbol = button.dataset.scExit;
      ui.exiting ||= {};
      if (ui.exiting[symbol] === 'sending') return;
      if (ui.exitArmed !== symbol) {
        ui.exitArmed = symbol; refreshPositions(ctx);
        clearTimeout(ui.exitTimer); ui.exitTimer = setTimeout(() => { ui.exitArmed = null; refreshPositions(ctx); }, 5000);
        return;
      }
      ui.exitArmed = null; ui.exiting[symbol] = 'sending'; refreshPositions(ctx);
      try { await post('/positions/exit', { symbol }); toast(`Exit order sent for ${symbol}.`, 'ok'); }
      catch (e) { toastError(e); }
      delete ui.exiting[symbol]; refreshPositions(ctx);
    }, signal);
    on(el, 'click', '[data-indicator]', (_, button) => {
      const key = button.dataset.indicator, next = ui.indicators?.[key] === false;
      ui.indicators = { ...ui.indicators, [key]: next };
      savePref(indicatorKey(currentMarket), JSON.stringify(Object.fromEntries(INDICATORS.map(([k]) => [k, ui.indicators[k] !== false]))));
      el.querySelectorAll(`[data-indicator="${key}"]`).forEach(b => b.setAttribute('aria-pressed', String(next)));
      for (const view of Object.values(ui.chartViews || {})) try { showIndicators(view, ui.indicators); } catch { /* disposed chart */ }
      if (key === 'sig') refreshSignalMarkers(ctx);
    }, signal);
    // ---- Indicators panel ----
    const studiesPop = key => $(`[data-studies-pop="${key}"]`, el);
    const paintStudies = key => { const pop = studiesPop(key); if (pop && !pop.hidden) pop.innerHTML = studiesPanel(ctx, key); };
    const closeStudies = () => { for (const pop of $$('[data-studies-pop]', el)) pop.hidden = true; ui.studyEdit = null; };
    const changeStudies = (key, fn) => {
      const view = ui.chartViews?.[key];
      const list = fn((view?.studies || studiesFor(key)).map(st => ({ ...st, params:{ ...st.params }, colors:{ ...st.colors } })));
      saveStudies(key, list);
      if (view) { view.studies = list; renderStudies(view, true); }
      paintStudies(key);
    };
    // The charts follow the current market's setup (built-in overlays and each chart's indicators).
    const applyMarketSetup = () => {
      for (const view of Object.values(ui.chartViews || {})) {
        try { view.studies = studiesFor(view.key); renderStudies(view, true); showIndicators(view, ui.indicators); } catch { /* disposed chart */ }
      }
      for (const pop of $$('[data-studies-pop]', el)) if (!pop.hidden) pop.innerHTML = studiesPanel(ctx, pop.dataset.studiesPop);
      for (const b of $$('[data-indicator]', el)) b.setAttribute('aria-pressed', String(ui.indicators?.[b.dataset.indicator] !== false));
      refreshSignalMarkers(ctx);
    };
    ui.applyMarketSetup = applyMarketSetup;
    // Reset: forget this market's saved choices, so all 3 charts and the overlays are back on its default.
    const resetMarketSetup = () => {
      try {
        localStorage.removeItem(indicatorKey(currentMarket));
        for (const k of ['spot', 'ce', 'pe']) localStorage.removeItem(studyKey(k));
        if (currentMarket === 'nse') { localStorage.removeItem('tradelock.scalper.indicators'); for (const k of ['spot', 'ce', 'pe']) localStorage.removeItem(`tradelock.scalper.studies.${k}`); }
      } catch { /* private window */ }
      ui.indicators = indicatorPrefs();
      applyMarketSetup();
      toast(`Charts reset to the ${MARKET_DEFAULTS[currentMarket].label} default.`, 'ok');
    };
    const openStudies = (key, editId = null) => {
      const pop = studiesPop(key); if (!pop) return;
      const wasOpen = !pop.hidden;
      closeStudies();
      if (wasOpen && !editId) return;
      ui.studyEdit = editId; pop.hidden = false; pop.innerHTML = studiesPanel(ctx, key);
    };
    on(el, 'click', '[data-studies]', (e, b) => { e.stopPropagation(); openStudies(b.dataset.studies); }, signal);
    on(el, 'click', '[data-legend-study]', (e, b) => { e.stopPropagation(); openStudies(b.closest('[data-chart-panel]').dataset.chartPanel, b.dataset.legendStudy); }, signal);
    on(el, 'click', '[data-studies-pop]', (e, pop) => {
      e.stopPropagation();
      const key = pop.dataset.studiesPop, t = e.target.closest('button'); if (!t) return;
      if (t.matches('[data-studies-close]')) return closeStudies();
      if (t.dataset.studyAdd) { const st = newStudy(t.dataset.studyAdd); ui.studyEdit = st.id; return changeStudies(key, list => [...list, st].slice(0, 12)); }
      if (t.dataset.studyToggle) return changeStudies(key, list => list.map(st => st.id === t.dataset.studyToggle ? { ...st, visible:!st.visible } : st));
      if (t.dataset.studyRemove) return changeStudies(key, list => list.filter(st => st.id !== t.dataset.studyRemove));
      if (t.dataset.studyEdit) { ui.studyEdit = ui.studyEdit === t.dataset.studyEdit ? null : t.dataset.studyEdit; return paintStudies(key); }
      if (t.matches('[data-study-reset]')) return resetMarketSetup();
      if (t.matches('[data-study-copy]')) {
        const list = ui.chartViews?.[key]?.studies || studiesFor(key);
        for (const other of ['spot', 'ce', 'pe']) if (other !== key) changeStudies(other, () => list.map(st => ({ ...st })));
        toast('Indicators copied to all 3 charts.', 'ok');
      }
    }, signal);
    on(el, 'change', '[data-study-param], [data-study-color], [data-study-width]', (_, input) => {
      const key = input.closest('[data-studies-pop]').dataset.studiesPop, id = input.dataset.studyParam || input.dataset.studyColor || input.dataset.studyWidth;
      changeStudies(key, list => sanitizeStudies(list.map(st => {
        if (st.id !== id) return st;
        if (input.dataset.studyParam) return { ...st, params:{ ...st.params, [input.dataset.k]:input.tagName === 'SELECT' ? input.value : Number(input.value) } };
        if (input.dataset.studyColor) return { ...st, colors:{ ...st.colors, [input.dataset.k]:input.value } };
        return { ...st, width:Number(input.value) };
      })));
    }, signal);
    document.addEventListener('click', e => { if (!e.target.closest('[data-studies-pop]')) closeStudies(); }, { signal });
    on(el, 'click', '[data-span]', (_, button) => {
      chartSpan = button.dataset.span; savePref('tradelock.scalper.span', chartSpan);
      for (const b of $$('[data-span]', el)) b.setAttribute('aria-pressed', String(b.dataset.span === chartSpan));
      for (const o of $$('[data-scm-pick="span"]', el)) o.setAttribute('aria-checked', String(o.dataset.value === chartSpan));
      const spanLabel = $('[data-scm-menu-label="span"]', el); if (spanLabel) spanLabel.textContent = chartSpan.toUpperCase();
      for (const view of Object.values(ui.chartViews || {})) fitSpan(view);
    }, signal);
    on(el, 'click', '[data-chart-control]', (_, button) => {
      const panel = button.closest('[data-chart-panel]');
      chartControl(ui.chartViews?.[panel?.dataset.chartPanel], button.dataset.chartControl);
    }, signal);
  },
};

// Open positions from the live broker sync (the same feed as the Positions page), with a two-click Exit.
function positionsBlock(ctx) {
  const dash = ctx.state?.dash;
  if (!dash) return html`<div class="sc-pos-empty">Waiting for the first broker sync…</div>`;
  const open = dash.positions || [], orders = dash.orders || [];
  const total = open.reduce((sum, p) => sum + (Number(p.unrealized) || 0), 0), exiting = ctx.ui.exiting || {};
  return html`<div class="sc-pos-head"><span>Open positions <b>${open.length}</b></span>${open.length ? html`<span>Open P&amp;L <b class="${total >= 0 ? 'pos' : 'neg'}">${signedInr(total)}</b></span>` : ''}</div>
    ${open.length ? html`<div class="sc-pos-list">${open.map(p => html`<div class="sc-pos-row">
      <div class="sc-pos-name"><b>${p.symbol}</b><small><span class="${p.qty > 0 ? 'pos' : 'neg'}">${p.qty > 0 ? 'LONG' : 'SHORT'}</span> ${Math.abs(p.qty)} @ ${money(p.avg)}</small></div>
      <b class="sc-pos-pnl ${(p.unrealized || 0) >= 0 ? 'pos' : 'neg'}">${signedInr(p.unrealized)}</b>
      <button type="button" class="btn btn-sm sc-pos-exit ${ctx.ui.exitArmed === p.symbol ? 'armed' : ''}" data-sc-exit="${p.symbol}" ${exiting[p.symbol] ? 'disabled' : ''} title="Market exit for the full quantity">${exiting[p.symbol] ? 'Exiting…' : ctx.ui.exitArmed === p.symbol ? 'Confirm exit' : 'Exit'}</button>
    </div>`)}</div>` : html`<div class="sc-pos-empty">No open positions.</div>`}
    ${orders.length ? html`<a class="sc-pos-orders" href="/positions">${orders.length} pending order${orders.length === 1 ? '' : 's'} · manage on Positions</a>` : ''}`;
}
// Size the chart row so charts, side panel and order tickets fill the window exactly (the toolbar wraps
// differently by width, so this is measured rather than guessed). Phones keep the stacked CSS layout.
function fitWorkspace(ctx) {
  const ws = $('.scalper-workspace', ctx.el), tickets = $('.scalper-tickets', ctx.el);
  if (!ws || !tickets || typeof window === 'undefined') return;
  // The AI panel and ticket notes fill in after the first paint and repaints replace the ticket nodes:
  // watch the page root (stable for the page's life) so any height change re-fits.
  if (typeof ResizeObserver !== 'undefined' && !ctx.ui.fitObserver && ctx.el?.nodeType === 1) {
    ctx.ui.fitObserver = new ResizeObserver(() => fitWorkspace(ctx));
    ctx.ui.fitObserver.observe(ctx.el);
    ctx.signal?.addEventListener('abort', () => ctx.ui.fitObserver?.disconnect(), { once:true });
  }
  // Phone full screen: the two charts share exactly the height left between the top bars and the order bar.
  const hosts = $$('.sc-chart-host', ctx.el);
  if (isFocus() && window.innerWidth <= 760) {
    // From where the charts start (below the top bar and any alert) to the top of the order bar.
    const top = $('.scalper-chart-grid', ctx.el)?.getBoundingClientRect().top || 0, bottom = tickets.getBoundingClientRect().top;
    const bars = $$('.scm-bar', ctx.el).reduce((sum, bar) => sum + bar.getBoundingClientRect().height, 0);
    const each = Math.max(140, Math.floor((bottom - top - bars - 4) / 2));
    for (const host of hosts) if (host.style.height !== `${each}px`) host.style.height = `${each}px`;
    ctx.ui.scmSized = true;
    return;
  }
  if (ctx.ui.scmSized) { for (const host of hosts) host.style.height = ''; ctx.ui.scmSized = false; }
  if (window.innerWidth <= 1000) { ws.style.height = ''; return; }
  const top = ws.getBoundingClientRect().top + window.scrollY, below = tickets.getBoundingClientRect().height + 10 + 14;
  const height = Math.round(Math.min(1100, Math.max(320, window.innerHeight - top - below)));
  if (ws.style.height !== `${height}px`) ws.style.height = `${height}px`;
}
/** This chart's contract: the option shown, or the index / MCX future on the spot chart. */
function chartContract(ctx, view) {
  const d = ctx.data;
  if (!d || !view.instrumentId) return null;
  // The price the chart shows (its latest candle, kept current by live ticks): what an alert or limit is compared with.
  const shown = Number(view.data?.at(-1)?.close) || null;
  if (view.key === 'spot') return { securityId: view.instrumentId, segment: spotSegment(d), symbol: d.underlying.symbol, ltp: shown ?? d.underlying.ltp, tradable: false };
  const item = strikeIndex(d).byId.get(view.instrumentId);
  return item ? { securityId: String(item.securityId), segment: item.exchangeSegment, symbol: item.symbol, ltp: shown ?? item.ltp, tradable: true, item } : null;
}
/** What the chart's "+" menu does: limit orders (this ticket's lots, through the same risk checks) and price alerts. */
function levelOptions(ctx, view) {
  const lotsOf = qty => Math.round(qty / (ctx.data?.qtyPerLot ?? ctx.data?.lotSize ?? 1));
  return {
    contract: () => chartContract(ctx, view),
    size: () => {
      const c = chartContract(ctx, view);
      if (!c?.tradable) return null;
      const s = sizeOf(ctx, view.key, c.item);
      return s.lots > 0 ? { lots: s.lots, qty: s.lots * (ctx.data.qtyPerLot ?? ctx.data.lotSize) } : null;
    },
    act: async (kind, { id, price }) => {
      const c = chartContract(ctx, view);
      try {
        if (kind === 'buy' || kind === 'sell') {
          const s = sizeOf(ctx, view.key, c?.item), qty = s.lots * (ctx.data.qtyPerLot ?? ctx.data.lotSize);
          if (!c?.tradable || !(qty > 0)) throw new Error(s.reason || 'No lots to order: set lots on the ticket first.');
          const side = kind.toUpperCase();
          const r = await post('/orders', { symbol: c.symbol, securityId: c.securityId, exchangeSegment: c.segment, side, qty, type: 'LIMIT', price, productType: 'INTRADAY' });
          toast(`${side} limit ${lotsOf(qty)} lot${lotsOf(qty) === 1 ? '' : 's'} @ ${price} placed at Dhan (${r.order?.id || 'pending'}).`, 'ok');
        } else if (kind === 'move-order') { await put(`/orders/${encodeURIComponent(id)}`, { price }); toast(`Limit order moved to ${price}.`, 'ok'); }
        else if (kind === 'cancel-order') { await del(`/orders/${encodeURIComponent(id)}`); toast('Order cancelled.', 'ok'); }
        else if (kind === 'alert') {
          const { alert } = await post('/alerts', { segment: c.segment, securityId: c.securityId, symbol: c.symbol, price, ltp: c.ltp });
          setLocalAlerts(ctx, list => [...list.filter(a => a.id !== alert.id), alert]);   // the purple line at once
          armAlertDelivery();
          toast(`Alert set: ${c.symbol} ${c.ltp > 0 && price < c.ltp ? '≤' : '≥'} ${price}. TradeLock rings when it gets there.`, 'ok');
        } else if (kind === 'move-alert') { const { alert } = await put(`/alerts/${id}`, { price, ltp: c?.ltp }); setLocalAlerts(ctx, list => list.map(a => (a.id === id ? { ...a, ...alert } : a))); toast(`Alert moved to ${price}.`, 'ok'); }
        else if (kind === 'delete-alert') { await del(`/alerts/${id}`); setLocalAlerts(ctx, list => list.filter(a => a.id !== id)); toast('Alert removed.', 'ok'); }
      } catch (e) { toastError(e); throw e; }
    },
  };
}
/** Change this screen's copy of the alerts now (the server's next push confirms it), and redraw the markers. */
function setLocalAlerts(ctx, fn) {
  const d = ctx.state?.dash;
  if (!d) return;
  d.alerts = fn(d.alerts || []).map(({ id, segment, securityId, price, dir }) => ({ id, segment, securityId: String(securityId), price, dir }));
  refreshChartPositions(ctx);
}
/** First alert: ask for browser notifications, and wake the Android app's alarm service (it rings even when closed). */
function armAlertDelivery() {
  try { if (typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission(); } catch { /* not supported */ }
  try { window.TradeLockApp?.startTradeAlerts?.(); } catch { /* not the app */ }
}
/** Each chart's open position (by contract), its target / stop and live P&L: on every broker sync and live tick. */
function refreshChartPositions(ctx) {
  const dash = ctx.state?.dash, d = ctx.data;
  if (!d) return;
  const { byId } = strikeIndex(d), pointValue = d.mcx ? Number(d.lotSize) || 1 : 1;
  for (const view of Object.values(ctx.ui.chartViews || {})) {
    if (!view.pos) continue;
    const id = view.instrumentId;
    const pos = id && (dash?.positions || []).find(p => String(p.securityId) === id && Number(p.qty) !== 0);
    const ltp = byId.get(id)?.ltp;
    view.pos.set({ pos: pos ? { securityId: id, qty: Number(pos.qty), avg: Number(pos.avg) } : null, bracket: (dash?.brackets || []).find(b => b.securityId === id) || null, ltp, pointValue });
    // Level markers: this contract's pending limit orders (not the stop-loss orders) and price alerts.
    const perLot = d.qtyPerLot ?? d.lotSize ?? 1;
    view.levels?.set({
      orders: (dash?.orders || []).filter(o => String(o.securityId) === id && o.type === 'LIMIT').map(o => ({ id: o.id, side: o.side, qty: o.qty, lots: perLot > 0 ? Math.round(o.qty / perLot) : null, price: Number(o.price) })),
      alerts: (dash?.alerts || []).filter(a => String(a.securityId) === id),
    });
  }
}
function refreshPositions(ctx) {
  const host = $('[data-sc-positions]', ctx.el);
  if (host) host.innerHTML = String(positionsBlock(ctx));
}
function errorBanner(message) {
  return message ? html`<div class="banner amber scalper-error">${icon('alert')} ${message}</div>` : '';
}
// Split layout: Sell / lots / Buy in the option chart header (same one-tap order as the tickets).
function headerOrder(ctx, item, side) {
  const size = sizeOf(ctx, side, item), busy = runningTrade(ctx.state, ctx.ui);
  const t = ticketText(item, size, ctx.data.lotSize, ctx.ui.margins?.[side]);
  return { lots:size.lots, manual:!!size.manual, buy:t.buy, sell:t.sell, disabled:!(item && ctx.data.lotSize && size.lots > 0) || !!busy, reason:busy || size.reason || '' };
}
function chartPanel(name, instrument, key, _candles, spot, interval = '5', order = null, indicators = {}) {
  const seg = instrument?.exchangeSegment || '', exchange = seg.startsWith('BSE') ? 'BSE' : seg.startsWith('MCX') ? 'MCX' : 'NSE';
  const heading = key === 'spot' ? `${instrument.symbol} · ${interval} · ${seg.startsWith('MCX') ? 'FUT' : 'IDX'}` : instrument ? `${instrument.underlying || 'NIFTY'} ${instrument.expiry} ${instrument.strike} ${instrument.option} · ${interval} · ${exchange}` : `${name} · Select an option`;
  const { fast, slow } = emaPeriods(interval);
  const subtitle = key === 'spot' && !isAdmin() ? `EMA ${fast} / EMA ${slow}` : key === 'spot' ? (showsHammerMarkers(interval) ? 'EMA45 wick-touch hammer + 5m opening-range breakout arrows · next candle confirms' : ['5'].includes(String(interval)) ? `EMA ${fast} / EMA ${slow} · 5m opening-range breakout arrows · hammer signals on 1-minute` : `EMA ${fast} / EMA ${slow} · breakout and hammer arrows show on the 1- and 5-minute charts`) : instrument?.symbol || name;
  const live = key === 'spot' ? html`<span class="sc-hdr-index"><strong data-spot>${money(instrument?.ltp || 0)}</strong><em class="${(instrument?.ltp || 0) >= (_candles?.at?.(-1)?.open || instrument?.ltp || 0) ? 'pos' : 'neg'}">Live index</em></span>` : '';
  return html`<section class="panel sc-chart-panel" data-chart-panel="${key}"><header><span><b>${heading}${live}</b><small>${subtitle}</small></span><span class="sc-chart-ltp" data-ltp="${key}">${money(instrument?.ltp || 0)}</span>${order ? html`<span class="sc-hdr-order" title="${order.reason}"><button type="button" class="btn btn-sm sc-hdr-sell" data-order-side="SELL" data-option="${key.toUpperCase()}" data-hdr-btn="${key}" ${order.disabled ? 'disabled' : ''}>Sell <small data-hdr-funds="${key}-sell">${order.sell}</small></button><span class="sc-hdr-lots ${lotsEditable ? '' : 'locked'}" title="${lotsEditable ? 'Lots: type a number or use − / +' : 'Auto lots from your risk rules · switch Manual lots on to change them'}"><button type="button" data-lot-step="-1" data-lot-side="${key}" aria-label="One lot less" ${lotsEditable ? '' : 'disabled'}>−</button><input class="sc-hdr-lots-input ${order.manual ? 'manual' : ''}" data-lots="${key}" data-hdr-lots="${key}" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="3" autocomplete="off" enterkeyhint="done" value="${order.lots}" aria-label="${key.toUpperCase()} lots" ${lotsEditable ? '' : 'readonly'}><button type="button" data-lot-step="1" data-lot-side="${key}" aria-label="One lot more" ${lotsEditable ? '' : 'disabled'}>+</button></span><button type="button" class="btn btn-sm sc-hdr-buy" data-order-side="BUY" data-option="${key.toUpperCase()}" data-hdr-btn="${key}" ${order.disabled ? 'disabled' : ''}>Buy <small data-hdr-funds="${key}-buy">${order.buy}</small></button></span>` : ''}</header><div class="sc-chart-meta"><button type="button" class="sc-ind sc-ind-add" data-studies="${key}" title="Add or change indicators" aria-haspopup="dialog">ƒx Indicators</button><span class="sc-legend" data-legend="${key}"></span><span>Spot <b>${money(spot)}</b></span><span>${key === 'spot' ? 'PCR' : 'OI'} <b class="oi-value">--</b></span><span class="sc-chart-count" data-candle-count></span></div><div class="sc-studies-pop" data-studies-pop="${key}" role="dialog" aria-label="Indicators" hidden></div><div class="sc-chart-host" data-chart="${key}" role="img" aria-label="${name} live candlestick chart"></div><div class="sc-chart-controls" aria-label="Chart zoom controls"><span>TIME</span><button type="button" data-chart-control="x-out" aria-label="Zoom time out" title="Zoom out on time axis">-</button><button type="button" data-chart-control="x-in" aria-label="Zoom time in" title="Zoom in on time axis">+</button><span>PRICE</span><button type="button" data-chart-control="y-out" aria-label="Zoom price out" title="Zoom out on price axis">-</button><button type="button" data-chart-control="y-in" aria-label="Zoom price in" title="Zoom in on price axis">+</button><button type="button" data-chart-control="reset" aria-label="Reset chart zoom" title="Back to the selected session (1D / 5D)">Reset</button></div></section>`;
}
// Order tickets: [Sell] [lots] [Buy]. Lots are sized automatically from the risk rules, never typed:
// SL = Option SL room % (Risk rules) below the live premium, and the loss at that SL may not exceed the per-trade budget
// (daily loss limit ÷ max trades per day, reduced if today's losses have used part of the daily limit).
//   lots = floor(budget / (premium × SL% × lot size)). Units sent to Dhan = lots × lot size.
export const DEFAULT_SL_PCT = 20;   // Risk rules default for Option SL room
const round2 = n => Math.round(n * 100) / 100;
/** @param risk  /scalper/signal-risk: { budget, optionSlPct } (optionSlPct null = sizing turned off) */
export function autoSize(item, lotSize, risk) {
  const budget = risk?.budget, slPct = risk && 'optionSlPct' in risk ? risk.optionSlPct : DEFAULT_SL_PCT;
  if (slPct == null) return { lots:0, reason:'Option SL room is off in Risk rules, so orders cannot be sized.' };
  if (!lotSize) return { lots:0, reason:'Loading lot size…' };
  if (!budget) return { lots:0, reason:'Set a daily loss limit in Risk rules to size orders.' };
  if (!(item?.ltp > 0)) return { lots:0, reason:'Waiting for a live price.' };
  const sl = round2(item.ltp * (1 - slPct / 100)), riskPerLot = round2((item.ltp - sl) * lotSize), allowed = Number(budget.available);
  const base = { sl, slPct, riskPerLot, allowed, perTrade:budget.perTrade, trades:budget.trades, dailyPct:budget.dailyPct };
  if (!(allowed > 0)) return { ...base, lots:0, reason:'Daily loss limit reached: no new risk today.' };
  const byRisk = Math.floor(allowed / riskPerLot), cap = Number(budget.capitalLimit) > 0 ? Number(budget.capitalLimit) : null;
  const lots = cap != null ? Math.min(byRisk, Math.floor(cap / (item.ltp * lotSize) + 1e-9)) : byRisk;
  if (!lots && byRisk && cap != null) return { ...base, lots:0, reason:`One lot costs ${rupees(item.ltp * lotSize)}, more than your ${rupees(cap)} capital per trade.` };
  if (!lots) return { ...base, lots:0, reason:`One lot risks ${rupees(riskPerLot)} at a ${slPct}% SL, more than the ${rupees(allowed)} per-trade budget.` };
  return { ...base, lots, risk:round2(lots * riskPerLot), capital:round2(lots * lotSize * item.ltp) };
}
/**
 * Lots for a ticket: the auto size from the risk rules, or the lots set by hand with − / + (manual > 0). Manual lots
 * are still checked by the server's risk gate (capital per trade, daily loss limit, kill switch...).
 */
export function chosenSize(item, lotSize, risk, manual = 0) {
  const auto = autoSize(item, lotSize, risk);
  if (!(manual > 0)) return auto;
  if (!lotSize) return { lots:0, reason:'Loading lot size…' };
  if (!(item?.ltp > 0)) return { lots:0, manual:true, reason:'Waiting for a live price.' };
  const slPct = auto.slPct ?? (risk && 'optionSlPct' in risk ? risk.optionSlPct : DEFAULT_SL_PCT) ?? null;
  const sl = slPct != null ? round2(item.ltp * (1 - slPct / 100)) : null;
  return { lots:manual, manual:true, reason:'', sl, slPct, risk: sl != null ? round2(manual * (item.ltp - sl) * lotSize) : null,
    capital: round2(manual * lotSize * item.ltp), auto: auto.lots };
}
// Lots set by hand count only while the Manual lots switch is on; otherwise auto sizing from the risk rules.
// Rendering: whether the lots boxes are editable (the Manual lots switch); set at the start of each view.
let lotsEditable = false;
export const manualOf = (ui, side) => (ui?.manualMode ? ui.manualLots?.[side] || 0 : 0);
const sizeOf = (ctx, side, item) => chosenSize(item, ctx.data.lotSize, ctx.ui.signalRisk, manualOf(ctx.ui, side));
function ticket(name, option, item, lotSize, margin, risk, busy = '', manual = 0) {
  const side = option.toLowerCase(), size = chosenSize(item, lotSize, risk, manual), t = ticketText(item, size, lotSize, margin);
  const ready = item && lotSize && size.lots > 0 && !busy;
  if (busy) t.note = busy;
  return html`<section class="panel sc-ticket ${busy ? 'busy' : ''}" data-ticket="${side}"><header><span class="sc-option-tag ${side}">${option}</span><b><span class="tk-full">${item ? `${item.underlying || 'NIFTY'} ${item.expiry} ${item.strike} ${name}` : name}</span><span class="tk-short">${item ? `${item.strike} ${option}` : option}</span></b><span class="sc-last" data-ltp="${side}">${money(item?.ltp)}</span></header><div class="sc-ticket-buttons"><div class="sc-btn-col sell"><button class="btn btn-danger sc-order-btn ${t.sellShort ? 'short' : ''}" data-order-side="SELL" data-option="${option}" ${ready ? '' : 'disabled'}><span>Sell</span><small title="Margin Dhan blocks to sell (write) the full quantity" data-funds="sell">${t.sell}</small></button></div><div class="sc-lots ${lotsEditable ? '' : 'locked'}" title="${lotsEditable ? 'Lots: type a number or use − / +' : 'Auto lots from your risk rules · switch Manual lots on to change them'}"><span class="sc-lot-step"><button type="button" data-lot-step="-1" data-lot-side="${side}" aria-label="${option}: one lot less" ${lotsEditable ? '' : 'disabled'}>−</button><input class="input sc-lots-input" data-lots="${side}" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="3" autocomplete="off" enterkeyhint="done" value="${size.lots}" aria-label="${option} lots" ${lotsEditable ? '' : 'readonly'}><button type="button" data-lot-step="1" data-lot-side="${side}" aria-label="${option}: one lot more" ${lotsEditable ? '' : 'disabled'}>+</button></span></div><div class="sc-btn-col buy"><button class="btn btn-primary sc-order-btn ${t.buyShort ? 'short' : ''}" data-order-side="BUY" data-option="${option}" ${ready ? '' : 'disabled'}><span>Buy</span><small title="Funds needed to buy the full quantity" data-funds="buy">${t.buy}</small></button></div></div><small data-ticket-note>${t.note}</small></section>`;
}
// Button labels: a lakh or more as ₹14.28L so it fits on a phone button.
export const compactRupees = n => Math.abs(n) >= 1e5 ? `₹${(Math.round(n / 1e3) / 100).toFixed(2)}L` : rupees(n);
const rupees = n => `₹${Math.round(n).toLocaleString('en-IN')}`;
// Funds needed per ticket. Buy = units × live LTP (exactly what Dhan blocks for an option buy),
// so it moves with every tick. Sell margin needs Dhan's SPAN calculator; it is fetched, not computed.
function ticketText(item, size, lotSize, margin) {
  const t = { buy:'—', sell:'—', buyShort:false, sellShort:false, note:size.reason || 'Loading lot size…' };
  if (!lotSize || !size.lots) return t;
  const lots = size.lots, qty = lots * lotSize;
  const current = margin && item && margin.securityId === String(item.securityId) && margin.lots === lots ? margin : null;
  const available = current?.available ?? margin?.available;
  if (item?.ltp > 0) { const buy = qty * item.ltp; t.buy = rupees(buy); t.buyShort = Number.isFinite(available) && buy > available; }
  if (current && Number.isFinite(current.sell)) { t.sell = compactRupees(current.sell); t.sellShort = Number.isFinite(available) && current.sell > available; }
  else if (item) t.sell = '…';
  t.note = (size.manual
    ? `${lots} lot${lots === 1 ? '' : 's'} × ${lotSize} · manual${size.auto ? ` (auto ${size.auto})` : ''}${size.sl != null ? ` · SL ₹${size.sl.toFixed(2)} (−${size.slPct}%) · risk ${rupees(size.risk)}` : ''} · capital ${rupees(size.capital)}`
    : `${lots} lot${lots === 1 ? '' : 's'} × ${lotSize} · SL ₹${size.sl.toFixed(2)} (−${size.slPct}%) · risk ${rupees(size.risk)} of ${rupees(size.allowed)}`
      + ` (${size.dailyPct ? `${round2(size.dailyPct)}% ÷ ` : ''}${size.trades} trades) · capital ${rupees(size.capital)}`)
    // Say which order the funds check is about: a buy can be affordable while writing (selling) is not.
    + (Number.isFinite(available) ? ` · available ${rupees(available)}${t.buyShort ? ' · not enough funds to buy' : t.sellShort ? ' · enough to buy; selling (writing) needs more margin' : ''}` : '');
  return t;
}
function updateTickets(ctx) {
  const risk = ctx.ui.signalRisk, busy = runningTrade(ctx.state, ctx.ui);
  for (const side of ['ce','pe']) {
    const box = ctx.el.querySelector(`[data-ticket="${side}"]`);
    if (!box) continue;
    box.classList.toggle('busy', !!busy);
    const item = strikeIndex(ctx.data).byId.get(String(ctx.ui[`${side}Id`]));
    const size = chosenSize(item, ctx.data.lotSize, risk, manualOf(ctx.ui, side)), t = ticketText(item, size, ctx.data.lotSize, ctx.ui.margins?.[side]);
    const mode = ctx.el.querySelectorAll(`[data-lots-mode="${side}"]`);
    const editable = !!ctx.ui.manualMode;
    for (const m of mode) { const text = editable ? 'Manual' : 'Auto'; if (m.textContent !== text) m.textContent = text; m.closest('.sc-lots-mode')?.classList.toggle('manual', editable); }
    // The Manual lots switch locks or unlocks the boxes and − / + (ticket and chart header) in place.
    for (const node of ctx.el.querySelectorAll(`[data-lots="${side}"]`)) { node.readOnly = !editable; node.classList.toggle('manual', !!size.manual); node.closest('.sc-lots, .sc-hdr-lots')?.classList.toggle('locked', !editable); }
    for (const b of ctx.el.querySelectorAll(`[data-lot-step][data-lot-side="${side}"]`)) b.disabled = !editable;
    // The premium moves the lot count; refresh Dhan's sell margin only when the count actually changes.
    if ((ctx.ui.autoLots ||= {})[side] !== size.lots) { ctx.ui.autoLots[side] = size.lots; ctx.ui.refreshMarginsSoon?.([side]); }
    const lotsOut = box.querySelector('[data-lots]');
    // A typed number is left alone while the box has focus; it is applied on Enter or when the box is left.
    if (lotsOut && document.activeElement !== lotsOut && lotsOut.value !== String(size.lots)) lotsOut.value = String(size.lots);
    for (const [key, text, short] of [['buy', t.buy, t.buyShort], ['sell', t.sell, t.sellShort]]) {
      const label = box.querySelector(`[data-funds="${key}"]`);
      if (label && label.textContent !== text) label.textContent = text;
      const button = box.querySelector(`[data-order-side="${key.toUpperCase()}"]`);
      button?.classList.toggle('short', short);
      if (button) button.disabled = !(item && ctx.data.lotSize && size.lots > 0) || !!busy;
    }
    const disabled = !(item && ctx.data.lotSize && size.lots > 0) || !!busy;
    for (const b of ctx.el.querySelectorAll(`[data-hdr-btn="${side}"]`)) b.disabled = disabled;
    const hdrLots = ctx.el.querySelector(`[data-hdr-lots="${side}"]`);
    for (const [k, v] of [['buy', t.buy], ['sell', t.sell]]) { const f = ctx.el.querySelector(`[data-hdr-funds="${side}-${k}"]`); if (f && f.textContent !== v) f.textContent = v; }
    if (hdrLots) { if (document.activeElement !== hdrLots && hdrLots.value !== String(size.lots)) hdrLots.value = String(size.lots); hdrLots.classList.toggle('manual', !!size.manual); const box = hdrLots.closest('.sc-hdr-order'); if (box) box.title = busy || size.reason || ''; }
    const note = box.querySelector('[data-ticket-note]'), text = busy || t.note;
    if (note && note.textContent !== text) note.textContent = text;
  }
}

function updateCandle(rows, tick, at, interval) {
  if (!rows || !Number.isFinite(tick.ltp)) return;
  const ist = new Date(at + 330 * 60_000);
  const sessionStart = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 3, 45);
  const step = interval * 60_000;
  const bucket = sessionStart + Math.floor((at - sessionStart) / step) * step;
  let candle = rows.at(-1);
  if (candle && candle.time > bucket) return;
  // Feed volume is the day's running total: a bar gains the traded quantity since the previous tick.
  const dayVolume = Number(tick.volume);
  const traded = dayVolume > 0 && rows.lastDayVolume > 0 && dayVolume >= rows.lastDayVolume ? dayVolume - rows.lastDayVolume : 0;
  if (dayVolume > 0) rows.lastDayVolume = dayVolume;
  const oi = Number(tick.oi) > 0 ? Number(tick.oi) : Number(candle?.oi) || 0;
  if (!candle || candle.time !== bucket) { candle = { time:bucket, open:tick.ltp, high:tick.ltp, low:tick.ltp, close:tick.ltp, volume:traded, oi }; rows.push(candle); }
  else { candle.high=Math.max(candle.high,tick.ltp); candle.low=Math.min(candle.low,tick.ltp); candle.close=tick.ltp; candle.volume=(Number(candle.volume)||0)+traded; candle.oi=oi; }
}
function applyTick(ctx, tick) {
  const d = ctx.data, id = String(tick.securityId), now = Number(tick.at) || Date.now();
  ctx.ui.lastTickAtById ||= {};
  ctx.ui.lastTickAtById[id] = now;
  if (tick.exchangeSegment === spotSegment(d) && id === spotId(d)) {
    d.underlying.ltp = tick.ltp;
    if (isMarketSession(now, d.session)) updateCandle(d.underlying.candles, tick, now, Number(ctx.ui.interval));
  }
  const { byId } = strikeIndex(d), item = byId.get(id);
  if (item) { item.ltp = tick.ltp; item.volume = tick.volume ?? item.volume; item.oi = tick.oi ?? item.oi; }
  // The open position's live P&L on its chart: straight from this tick, not from the next broker sync.
  for (const view of Object.values(ctx.ui.chartViews || {})) if (view.instrumentId === id) view.pos?.setLtp(tick.ltp);
  const ce = byId.get(String(ctx.ui.ceId)), pe = byId.get(String(ctx.ui.peId));
  if (isMarketSession(now, d.session) && ce && String(ce.securityId) === id) updateCandle(ctx.ui.ceCandles, tick, now, Number(ctx.ui.interval));
  if (isMarketSession(now, d.session) && pe && String(pe.securityId) === id) updateCandle(ctx.ui.peCandles, tick, now, Number(ctx.ui.interval));
  ctx.ui.tickDirty = true;
}
// session: { open, close } minutes (MCX 09:00 to 23:55); the indices 09:15 to 15:30.
function isMarketSession(at, session = null) {
  const local = new Date(at + 330 * 60_000), day = local.getUTCDay(), minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  return day > 0 && day < 6 && minutes >= (session?.open ?? 555) && minutes < (session?.close ?? 930);
}
function chartRows(rows) {
  const out = (rows || []).map(c => ({
    time: Math.floor(Number(c.time) / 1000), open:Number(c.open), high:Number(c.high), low:Number(c.low), close:Number(c.close), volume:Number(c.volume)||0, oi:Number(c.oi)||0,
  })).filter(c => Number.isInteger(c.time) && c.time > 0 && [c.open,c.high,c.low,c.close].every(Number.isFinite));
  out.sort((a,b) => a.time-b.time);
  return out.filter((c,i) => i === 0 || c.time > out[i-1].time);
}
function emaRows(rows, period) {
  const k = 2 / (period + 1); let value;
  return rows.map(c => { value = value == null ? c.close : c.close * k + value * (1-k); return { time:c.time, value }; });
}
// Signal arrows on all three charts, from the index candles: 5-minute opening-range breakouts on the
// 1- and 5-minute charts, plus the EMA45 hammer signals on the 1-minute index chart.
function refreshSignalMarkers(ctx) {
  const views = ctx.ui.chartViews || {}, interval = ctx.ui.interval, intervalMs = Number(interval) * 60_000;
  const spot = views.spot?.data || [];
  const enabled = ctx.ui.strategies || {};
  const orb = enabled.orb === false ? [] : openingRangeChartSignals(spot, { intervalMs });
  const cross = enabled.emaCross === false ? [] : emaCrossSignals(spot, { intervalMs });
  const scalp = enabled.ema25 === false ? [] : emaScalpSignals(spot, { intervalMs });
  const scalp35 = enabled.ema35 === false ? [] : emaScalpSignals(spot, { intervalMs, f:EMA_SCALP_35 });
  // Premium charts carry the current session's signals only (IST day of the last index candle).
  const last = spot.at(-1)?.time, sessionStart = last ? Math.floor((last + 19_800) / 86_400) * 86_400 - 19_800 : 0;
  // Gap signals (scalper-chart-smc.js gapSignals): BUY on the CE / PE premium charts, "CE BUY" / "PE BUY" on the index.
  // Index options only (backtested on NIFTY); on the 1-minute chart they use 3-minute candles, as tested.
  const gap = { ce:[], pe:[] };
  if (ctx.ui.indicators?.sig !== false && currentMarket === 'nse' && spot.length) {
    const gaps = gapByDay(spot), tf = String(interval) === '1' ? GAP_SIGNAL.tf : null;
    for (const side of ['ce', 'pe']) {
      const rows = views[side]?.data || [];
      gap[side] = gapSignals(tf ? regroup(rows, tf) : rows, side.toUpperCase(), gaps);
    }
  }
  const pal = chartPalette();
  const buyMarker = (s, text, color, up = true) => ({ time:s.time, position: up ? 'belowBar' : 'aboveBar', shape: up ? 'arrowUp' : 'arrowDown', color, text });
  for (const [key, view] of Object.entries(views)) {
    if (!view?.signalMarkers) continue;
    const markers = [...openingRangeMarkers(orb, key), ...emaCrossMarkers(cross, key), ...emaScalpMarkers(scalp, key), ...emaScalpMarkers(scalp35, key, EMA_SCALP_35), ...(key === 'spot' && enabled.hammer !== false && showsHammerMarkers(interval) ? emaRejectionMarkers(spot, { intervalMs }) : [])];
    // Premium charts: place each index-time marker on the option's own candle for that minute.
    let placed = key === 'spot' ? markers : alignMarkersToBars(markers.filter(m => m.time >= sessionStart), view.data);
    if (key === 'spot') placed = [...placed, ...alignMarkersToBars([...gap.ce.map(s => buyMarker(s, 'CE BUY', pal.up, true)), ...gap.pe.map(s => buyMarker(s, 'PE BUY', pal.down, false))], view.data)];
    else placed = [...placed, ...alignMarkersToBars(gap[key].map(s => buyMarker(s, 'BUY', pal.up, true)), view.data)];
    view.signalMarkers.setMarkers(placed.sort((a, b) => a.time - b.time));
  }
}
function setChartData(view, rows, indicators, interval = '1') {
  const data = chartRows(rows);
  view.data = data;
  view.candles.setData(data);
  view.volume.setData(data.map(c => ({ time:c.time, value:c.volume, color:volumeColor(c) })));
  renderStudies(view);
  view.oi.setData(data.filter(c => c.oi > 0).map(c => ({ time:c.time, value:c.oi })));
  view.profile.setData(data); view.smc?.setData(data);
  view.draw?.setBars(data);
  showIndicators(view, indicators);
  view.lastTime = data.at(-1)?.time || 0;
  const count = view.host.closest('.sc-chart-panel')?.querySelector('[data-candle-count]');
  if (count) count.textContent = data.length ? `${data.length} bars` : 'Waiting for candle history';
  const empty = view.host.querySelector('.sc-chart-empty');
  if (empty) empty.hidden = data.length > 0;
  return data;
}
const IST_TIME = new Intl.DateTimeFormat('en-IN', { timeZone:'Asia/Kolkata', hour:'2-digit', minute:'2-digit', hourCycle:'h23' });
const IST_DATE = new Intl.DateTimeFormat('en-IN', { timeZone:'Asia/Kolkata', day:'numeric', month:'short' });
const istTime = seconds => IST_TIME.format(new Date(seconds * 1000));
const istDate = seconds => IST_DATE.format(new Date(seconds * 1000));
function showIndicators(view, indicators) {
  const prev = indicators.prev !== false;
  if (view.showPrev !== prev) { view.showPrev = prev; if (view.candles) setPreviousDayRange(view, view.data); }
  view.profile.setVisible(indicators.vp !== false);
  view.smc?.setVisible({ smc:indicators.smc !== false, fvg:indicators.fvg !== false, ict:indicators.ict !== false, fib:indicators.fib !== false });
  view.oi.applyOptions({ visible:indicators.oi !== false });
  view.oiProfile?.setVisible(indicators.oi !== false);
  const label = view.host.closest('.sc-chart-panel')?.querySelector('.oi-value');
  if (label) label.textContent = indicators.oi === false ? '--' : view.oiProfile ? putCallRatio(view.oiProfile.strikes) : oiSummary(view.data);
}
// Colours that depend on the light / dark theme (chart-palette.js); re-applied when the theme changes.
const volumeColor = c => { const p = chartPalette(); return `rgba(${c.close >= c.open ? p.upRgb : p.downRgb}, ${p.volAlpha})`; };
function themeOptions() {
  const style = getComputedStyle(document.documentElement), p = chartPalette();
  const color = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
  const bg = p.bg || color('--well','#080d15'), grid = p.grid || color('--line','#1c2734');
  return {
    layout:{ background:{type:'solid',color:bg}, textColor:p.text },
    grid:{ vertLines:{color:grid}, horzLines:{color:grid} },
    crosshair:{ vertLine:{color:p.crosshair}, horzLine:{color:p.crosshair} },
    rightPriceScale:{ borderColor:grid }, timeScale:{ borderColor:grid },
  };
}
function seriesColors() {
  const p = chartPalette();
  return { candles:{ upColor:p.up, downColor:p.down, wickUpColor:p.up, wickDownColor:p.down }, oi:{ color:p.oi } };
}
/** Re-colour an existing chart for the current theme (candles, EMAs, OI, volume, grid, text). */
function restyleChart(view) {
  if (!view?.chart) return;
  view.chart.applyOptions(themeOptions());
  const c = seriesColors();
  view.candles.applyOptions(c.candles); view.oi.applyOptions(c.oi); renderStudies(view, true);
  if (view.data?.length) view.volume.setData(view.data.map(b => ({ time:b.time, value:b.volume, color:volumeColor(b) })));
  const p = chartPalette(), lines = { high:p.orHigh, low:p.orLow };
  for (const [k, l] of Object.entries(view.openingRangeLines || {})) l.line.applyOptions({ color:lines[k] });
  for (const [k, l] of Object.entries(view.previousDayLines || {})) l.line.applyOptions({ color:k === 'high' ? p.prevHigh : p.prevLow });
  view.profile?.requestUpdate?.(); view.oiProfile?.requestUpdate?.();
}
function createChartView(host, rows, indicators, key, interval = '1', ctx = null) {
  const theme = themeOptions(), colors = seriesColors();
  const chart = createChart(host, {
    autoSize:true,
    layout:{ ...theme.layout, fontFamily:"'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace", fontSize:11, attributionLogo:true },
    grid:theme.grid,
    crosshair:{ mode:CrosshairMode.Normal, vertLine:{ ...theme.crosshair.vertLine, width:1, style:2 }, horzLine:{ ...theme.crosshair.horzLine, width:1, style:2 } },
    rightPriceScale:{ borderColor:theme.rightPriceScale.borderColor, autoScale:true, scaleMargins:{top:.1,bottom:.23}, minimumWidth:54 },
    timeScale:{ borderColor:theme.timeScale.borderColor, timeVisible:true, secondsVisible:false, rightOffset:4, barSpacing:8, minBarSpacing:2, fixLeftEdge:false,
      // Axis labels default to UTC; show IST like the crosshair. Types 0-2 are year/month/day ticks.
      tickMarkFormatter:(seconds, type) => type <= 2 ? istDate(seconds) : istTime(seconds) },
    handleScroll:{mouseWheel:true, pressedMouseMove:true, horzTouchDrag:true, vertTouchDrag:isFocus()},
    handleScale:{mouseWheel:true, pinch:true, axisPressedMouseMove:{time:true,price:true}, axisDoubleClickReset:true},
    localization:{ timeFormatter:seconds => istTime(seconds) },
  });
  const candles = chart.addSeries(CandlestickSeries, { ...colors.candles, borderVisible:false, lastValueVisible:true, priceLineVisible:true });
  const volume = chart.addSeries(HistogramSeries, { priceScaleId:'volume', priceFormat:{type:'volume'}, lastValueVisible:false, priceLineVisible:false, base:0 });
  chart.priceScale('volume').applyOptions({ visible:false, scaleMargins:{top:.79,bottom:0} });
  // Open interest: its own hidden scale in the lower band, over the volume bars.
  const oi = chart.addSeries(LineSeries,{...colors.oi,lineWidth:1,priceScaleId:'oi',priceFormat:{type:'volume'},priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:false});
  chart.priceScale('oi').applyOptions({ visible:false, scaleMargins:{top:.68,bottom:.03} });
  const profile = new VolumeProfilePrimitive(), smc = new SmcPrimitive();
  candles.attachPrimitive(profile); candles.attachPrimitive(smc);
  // The index has no OI of its own: its chart shows the option chain's OI at each strike instead.
  let oiProfile = null;
  if (key === 'spot') { oiProfile = new OiProfilePrimitive(); candles.attachPrimitive(oiProfile); }
  const empty = document.createElement('div'); empty.className='sc-chart-empty'; empty.textContent='Waiting for Dhan candle history'; host.append(empty);
  const view = {host,chart,candles,volume,oi,profile,smc,oiProfile,instrumentId:'',key,empty,lastTime:0,openingRangeLines:{},previousDayLines:{},studies:studiesFor(key),studySeries:[],studySig:''};
  view.signalMarkers = createSeriesMarkers(candles, []);
  // The open position on this chart: entry with live P&L, draggable TP / SL (before the drawings: a TP / SL line wins).
  view.pos = new PositionOverlay(view, {
    onSave: async b => { await put('/brackets', b); toast(b.tp == null && b.sl == null ? 'Target and stop-loss removed.' : `Saved${b.sl != null ? ` · stop-loss ${b.sl} placed at your broker` : ''}${b.tp != null ? ` · target ${b.tp}` : ''}.`, 'ok'); },
    onError: e => toastError(e),
  });
  // Hover "+" (limit order / alert at a price) and the pending orders' and alerts' level markers.
  if (ctx) view.levels = new LevelOverlay(view, levelOptions(ctx, view));
  view.draw = new DrawingLayer(view);   // trend lines, Fib, risk : reward and the other drawing tools
  setChartData(view,rows,indicators,interval);
  if (view.lastTime) fitSpan(view);
  // The chart is created before the workspace has its final size, and the library keeps bar width (not
  // the time range) on resize: re-fit the session whenever the size changes, until the user takes over.
  view.autoFit = true;
  if (typeof ResizeObserver !== 'undefined') {
    let frame = 0;
    view.sizeWatch = new ResizeObserver(() => { if (view.autoFit) { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => fitSpan(view)); } });
    view.sizeWatch.observe(host);
  }
  for (const type of ['wheel', 'pointerdown', 'touchstart']) host.addEventListener(type, e => { if (!e.target.closest?.('.sc-chart-empty')) view.autoFit = false; }, { passive:true });
  return view;
}
// ---- Indicators (chart-studies.js): per market and chart, saved in this browser; the market default (MARKET_DEFAULTS) until changed ----
const studyKey = (key, market = currentMarket) => `tradelock.scalper.studies.${market}.${key}`;
function studiesFor(key, market = currentMarket) {
  const read = k => { try { return sanitizeStudies(JSON.parse(localStorage.getItem(k) || 'null')); } catch { return null; } };
  // NIFTY falls back to the per-chart lists saved before markets had their own.
  return read(studyKey(key, market)) || (market === 'nse' ? read(`tradelock.scalper.studies.${key}`) : null) || MARKET_DEFAULTS[market].studies();
}
const saveStudies = (key, list) => savePref(studyKey(key), JSON.stringify(list));
/** Colour of one line: the user's pick, else the theme's EMA colours for the two default EMAs, else the study default. */
function studyColor(study, line, i) {
  if (study.colors?.[line]) return study.colors[line];
  const p = chartPalette();
  if (study.id === 'ema-default-0') return p.ema9;
  if (study.id === 'ema-default-1') return p.ema21;
  return STUDIES[study.type].lines[i][2];
}
const studyTitle = st => STUDIES[st.type].title(st.params);
/** Draw the view's studies. Series are rebuilt only when the list (or theme) changes; otherwise just re-fed. */
function renderStudies(view, rebuild = false) {
  if (!view?.chart) return;
  const visible = (view.studies || []).filter(st => st.visible);
  const sig = JSON.stringify(visible.map(st => [st.id, st.type, st.width, st.colors, st.params.upper, st.params.lower]));
  if (rebuild || sig !== view.studySig) {
    for (const entry of view.studySeries) for (const series of entry.series) { try { view.chart.removeSeries(series); } catch {} }
    view.studySeries = [];
    let pane = 0;
    for (const st of visible) {
      const def = STUDIES[st.type], paneIndex = def.pane ? ++pane : 0;
      const series = def.lines.map(([line], i) => {
        const color = studyColor(st, line, i);
        const opts = { color, priceLineVisible:false, lastValueVisible:def.pane, crosshairMarkerVisible:false, priceScaleId:def.pane ? 'right' : undefined };
        return line === 'hist' ? view.chart.addSeries(HistogramSeries, { ...opts, priceFormat:{ type:'price', precision:2, minMove:0.01 } }, paneIndex)
          : view.chart.addSeries(LineSeries, { ...opts, lineWidth:st.width, lineStyle:st.type === 'bb' && line !== 'middle' ? 2 : 0 }, paneIndex);
      });
      if (st.type === 'rsi') for (const level of [st.params.upper, st.params.lower]) series[0].createPriceLine({ price:level, color:'#8d9aab88', lineWidth:1, lineStyle:2, axisLabelVisible:true, title:'' });
      view.studySeries.push({ id:st.id, study:st, series });
    }
    view.studySig = sig;
    try { view.chart.panes().slice(1).forEach(p => p.setHeight(Math.max(70, Math.round((view.host.clientHeight || 300) * 0.2)))); } catch { /* older chart build */ }
  }
  const data = view.data || [];
  for (const entry of view.studySeries) {
    const lines = computeStudy(entry.study, data), def = STUDIES[entry.study.type];
    def.lines.forEach(([line], i) => {
      const points = lines[line] || [];
      entry.series[i].setData(line === 'hist' ? points.map(pt => ({ ...pt, color:pt.value >= 0 ? chartPalette().up : chartPalette().down })) : points);
    });
  }
  paintLegend(view);
}
/** Live tick: recompute and push only the newest point of each line. */
function updateStudies(view) {
  const data = view.data || [];
  for (const entry of view.studySeries) {
    const lines = computeStudy(entry.study, data), def = STUDIES[entry.study.type];
    def.lines.forEach(([line], i) => {
      const last = lines[line]?.at(-1);
      if (!last || last.time !== data.at(-1)?.time) return;
      try { entry.series[i].update(line === 'hist' ? { ...last, color:last.value >= 0 ? chartPalette().up : chartPalette().down } : last); } catch { /* out-of-order tick */ }
    });
  }
  paintLegend(view);
}
/** Legend in the chart's info row: each study's title and latest value(s); a click opens its settings. */
function paintLegend(view) {
  const host = view.host?.closest('.sc-chart-panel')?.querySelector('[data-legend]');
  if (!host) return;
  const data = view.data || [];
  host.innerHTML = (view.studies || []).map(st => {
    const def = STUDIES[st.type], lines = st.visible && data.length ? computeStudy(st, data) : {};
    const values = def.lines.map(([line], i) => { const v = lines[line]?.at(-1)?.value; return Number.isFinite(v) ? `<b style="color:${studyColor(st, line, i)}">${v.toFixed(2)}</b>` : ''; }).filter(Boolean).join(' ');
    return `<button type="button" class="sc-legend-item ${st.visible ? '' : 'off'}" data-legend-study="${st.id}" title="Settings · ${studyTitle(st)}"><i style="background:${studyColor(st, def.lines[0][0], 0)}"></i>${studyTitle(st)} ${values}</button>`;
  }).join('');
}
const escAttr = v => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
/** The Indicators panel for one chart: the list (show/hide, settings, remove), add, copy to all, reset. */
function studiesPanel(ctx, key) {
  const view = ctx.ui.chartViews?.[key], list = view?.studies || studiesFor(key), editing = ctx.ui.studyEdit;
  const row = st => {
    const def = STUDIES[st.type], open = editing === st.id;
    return `<div class="sc-study ${st.visible ? '' : 'off'}">
      <div class="sc-study-row"><i style="background:${studyColor(st, def.lines[0][0], 0)}"></i><b>${studyTitle(st)}</b><small>${def.pane ? 'own pane' : 'on price'}</small>
        <button type="button" data-study-toggle="${st.id}" title="${st.visible ? 'Hide' : 'Show'}" aria-pressed="${st.visible}">${st.visible ? '👁' : '◌'}</button>
        <button type="button" data-study-edit="${st.id}" title="Settings" aria-expanded="${open}">⚙</button>
        <button type="button" data-study-remove="${st.id}" title="Remove">✕</button></div>
      ${open ? `<div class="sc-study-form">
        ${def.params.map(([k, label, , min, max]) => Array.isArray(min)
          ? `<label>${label}<select data-study-param="${st.id}" data-k="${k}">${min.map(([v, l]) => `<option value="${v}" ${st.params[k] === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`
          : `<label>${label}<input type="number" data-study-param="${st.id}" data-k="${k}" value="${escAttr(st.params[k])}" min="${min}" max="${max}" step="${Number.isInteger(min) && Number.isInteger(st.params[k]) ? 1 : 0.1}"></label>`).join('')}
        ${def.lines.map(([line, label], i) => `<label>${label}<input type="color" data-study-color="${st.id}" data-k="${line}" value="${studyColor(st, line, i).slice(0, 7)}"></label>`).join('')}
        <label>Line width<select data-study-width="${st.id}">${[1, 2, 3, 4].map(w => `<option value="${w}" ${st.width === w ? 'selected' : ''}>${w}px</option>`).join('')}</select></label>
      </div>` : ''}</div>`;
  };
  return `<header><b>Indicators</b><small>${key === 'spot' ? 'Index chart' : `${key.toUpperCase()} chart`}</small><button type="button" data-studies-close title="Close" aria-label="Close">✕</button></header>
    <div class="sc-study-builtin"><span>Built-in <small>all charts</small></span>${INDICATORS.map(([k, label, hint]) => `<button type="button" class="sc-ind" data-indicator="${k}" aria-pressed="${String(ctx.ui.indicators?.[k] !== false)}" title="${escAttr(hint)}">${label}</button>`).join('')}</div>
    <div class="sc-study-list">${list.length ? list.map(row).join('') : '<p class="sc-study-empty">No indicators on this chart.</p>'}</div>
    <div class="sc-study-add"><span>Add</span>${Object.entries(STUDIES).map(([type, d]) => `<button type="button" data-study-add="${type}" title="${escAttr(d.name)}">${d.label}</button>`).join('')}</div>
    <footer><button type="button" data-study-copy>Copy to all 3 charts</button><button type="button" data-study-reset title="All 3 charts and the built-in overlays back to the ${MARKET_DEFAULTS[currentMarket].label} default">Reset to ${MARKET_DEFAULTS[currentMarket].label} default</button></footer>
    <p class="sc-study-note">Chart indicators only. Algo Trading always uses its own EMA 9 / 21 rules.</p>`;
}

function setOpeningRange(view, range) {
  const levels = range && Number.isFinite(range.high) && Number.isFinite(range.low)
    ? { high:range.high, low:range.low } : {};
  const pal = chartPalette();
  for (const [key, title, color] of [['high','OR High',pal.orHigh],['low','OR Low',pal.orLow]]) {
    const current = view.openingRangeLines[key];
    if (current && levels[key] === current.price) continue;
    if (current) view.candles.removePriceLine(current.line);
    if (Number.isFinite(levels[key])) {
      const line = view.candles.createPriceLine({ price:levels[key], color, lineWidth:1, lineStyle:2,
        axisLabelVisible:true, title });
      view.openingRangeLines[key] = { price:levels[key], line };
    } else delete view.openingRangeLines[key];
  }
}
/**
 * High / low of the last complete session before today (IST) in the candles, or null.
 * Candle times may be in ms (API rows) or seconds (chart rows): both are read the same way.
 */
export function previousDayRange(rows, now = Date.now()) {
  const today = istDay(now), grouped = new Map();
  for (const candle of rows || []) {
    const t = Number(candle.time), day = istDay(t > 0 && t < 1e11 ? t * 1000 : t);
    if (!day || day >= today) continue;
    const high = Number(candle.high), low = Number(candle.low);
    if (!Number.isFinite(high) || !Number.isFinite(low)) continue;
    const range = grouped.get(day) || { day, high:-Infinity, low:Infinity };
    range.high = Math.max(range.high, high); range.low = Math.min(range.low, low);
    grouped.set(day, range);
  }
  const last = [...grouped.keys()].sort().at(-1);
  return last ? grouped.get(last) : null;
}
function setPreviousDayRange(view, rows) {
  const range = previousDayRange(rows);
  const levels = range && view.showPrev !== false ? { high:range.high, low:range.low } : {};
  const pal = chartPalette();
  for (const [key, title, color] of [['high','Prev High',pal.prevHigh],['low','Prev Low',pal.prevLow]]) {
    const current = view.previousDayLines[key];
    if (current && levels[key] === current.price) continue;
    if (current) view.candles.removePriceLine(current.line);
    if (Number.isFinite(levels[key])) {
      const line = view.candles.createPriceLine({ price:levels[key], color, lineWidth:1, lineStyle:1,
        axisLabelVisible:true, title });
      view.previousDayLines[key] = { price:levels[key], line };
    } else delete view.previousDayLines[key];
  }
}
function istDay(at) {
  return Number.isFinite(at) ? new Date(at + 330 * 60_000).toISOString().slice(0,10) : '';
}
function updateLiveCharts(ctx) {
  const views = ctx.ui.chartViews || {};
  let markersDue = false;
  const latest = {
    ce:{ rows:ctx.ui.ceCandles || [], id:ctx.ui.ceId, openingRange:ctx.ui.ceOpeningRange },
    spot:{ rows:ctx.data.underlying.candles || [], id:spotId(ctx.data), openingRange:ctx.data.openingRange },
    pe:{ rows:ctx.ui.peCandles || [], id:ctx.ui.peId, openingRange:ctx.ui.peOpeningRange },
  };
  // Runs up to five times a second: update only the newest bar and EMA points. Full setData on
  // thousands of points per chart per flush was what pegged the CPU and grew memory.
  for (const [key,view] of Object.entries(views)) {
    const item = latest[key];
    if (!item || String(item.id || '') !== view.instrumentId) continue;
    const data = chartRows(item.rows), candle = data.at(-1);
    if (!candle || candle.time < view.lastTime) continue;
    try {
      const newBar = candle.time !== view.lastTime;
      view.candles.update(candle);
      view.volume.update({time:candle.time,value:candle.volume,color:volumeColor(candle)});
      const panel=view.host.closest('.sc-chart-panel');
      if (candle.oi > 0) {
        view.oi.update({time:candle.time,value:candle.oi});
        const label=panel?.querySelector('.oi-value'); if (label && ctx.ui.indicators.oi !== false) label.textContent=oiSummary(data);
      }
      view.data = data;
      updateStudies(view);
      // A hammer signal can only appear once its confirmation bar closes, i.e. when a new bar opens.
      // Signals appear once their confirmation bar closes, i.e. when a new bar opens.
      if (newBar) markersDue = true;
      view.data = data;
      view.profile.setData(data); view.smc?.setData(data);
      view.lastTime = candle.time;
      if (newBar) { const count=panel?.querySelector('[data-candle-count]'); if(count)count.textContent=`${data.length} bars`; }
      view.empty.hidden=true;
    } catch { /* a late tick can race with a route change and disposed chart */ }
  }
  if (views.spot?.oiProfile) try {
    views.spot.oiProfile.setData(ctx.data.strikes);
    const label = views.spot.host.closest('.sc-chart-panel')?.querySelector('.oi-value');
    if (label && ctx.ui.indicators.oi !== false) label.textContent = putCallRatio(ctx.data.strikes);
  } catch { /* disposed chart */ }
  if (markersDue) try { refreshSignalMarkers(ctx); } catch { /* disposed chart */ }
}
function updateLiveLabels(ctx) {
  moveAtmMark(ctx);
  for (const [key,id] of [['spot',spotId(ctx.data)],['ce',ctx.ui.ceId],['pe',ctx.ui.peId]]) {
    if (!id) continue;
    const item = id === spotId(ctx.data) ? {ltp:ctx.data.underlying.ltp} : strikeIndex(ctx.data).byId.get(String(id));
    if (!item) continue;
    ctx.el.querySelectorAll(`[data-ltp="${key}"]`).forEach(el=>el.textContent=money(item.ltp));
    if (key==='spot')ctx.el.querySelectorAll('[data-spot]').forEach(el=>el.textContent=money(item.ltp));
  }
  // Only the visible chain rows exist in the DOM; walk those instead of querying every strike.
  for (const button of ctx.el.querySelectorAll('[data-select-contract]')) {
    const row = strikeIndex(ctx.data).byStrike.get(Number(button.dataset.strike));
    const text = money(row?.[button.dataset.selectContract]?.ltp);
    if (button.textContent !== text) button.textContent = text;
  }
}
// Per-chain lookup tables, rebuilt only when the chain object changes (expiry switch / refresh).
const strikeIndexes = new WeakMap();
function strikeIndex(data) {
  let index = strikeIndexes.get(data);
  if (!index) {
    index = { byStrike:new Map(), byId:new Map() };
    for (const row of data.strikes) {
      index.byStrike.set(row.strike, row);
      for (const item of [row.ce, row.pe]) if (item) index.byId.set(String(item.securityId), item);
    }
    strikeIndexes.set(data, index);
  }
  return index;
}
// ATM = the strike nearest the live NIFTY level. Its row is marked and kept in the vertical centre of the
// chain; a manual scroll is respected until the ATM moves to another strike or the expiry changes.
function atmOf(data) {
  return data.strikes.reduce((best, row) => !best || Math.abs(row.strike - data.underlying.ltp) < Math.abs(best.strike - data.underlying.ltp) ? row : best, null)?.strike;
}
function centreChain(ctx) {
  const body = $('.sc-chain-body', ctx.el), row = body?.querySelector('.sc-chain-row.atm');
  if (!body || !row) return;
  body.scrollTop = Math.max(0, row.offsetTop - (body.clientHeight - row.offsetHeight) / 2);
  ctx.ui.chainScroll = body.scrollTop;
}
function keepChainCentred(ctx) {
  const key = `${ctx.data.expiry}:${atmOf(ctx.data)}`, body = $('.sc-chain-body', ctx.el);
  if (!body) return;
  if (ctx.ui.chainKey === key && Number.isFinite(ctx.ui.chainScroll)) body.scrollTop = ctx.ui.chainScroll;
  else { ctx.ui.chainKey = key; centreChain(ctx); }
}
function moveAtmMark(ctx) {
  const atm = atmOf(ctx.data), key = `${ctx.data.expiry}:${atm}`;
  if (atm == null || ctx.ui.chainKey === key) return;
  ctx.el.querySelectorAll('[data-chain-strike]').forEach(row => row.classList.toggle('atm', Number(row.dataset.chainStrike) === atm));
  const label = $('[data-chain-atm]', ctx.el); if (label) label.textContent = atm.toLocaleString('en-IN');
  ctx.ui.chainKey = key;
  centreChain(ctx);
}
function chartControl(view, action) {
  if (!view) return;
  const ts=view.chart.timeScale(), ps=view.chart.priceScale('right');
  if (action==='reset') { fitSpan(view); ps.setAutoScale(true); return; }
  if (action.startsWith('x-')) {
    const r=ts.getVisibleLogicalRange(); if(!r)return;
    const width=Math.max(5,r.to-r.from), next=width*(action==='x-in'?.75:1.33), center=(r.from+r.to)/2;
    ts.setVisibleLogicalRange({from:center-next/2,to:center+next/2});
  } else if (action.startsWith('y-')) {
    let r=ps.getVisibleRange();
    if(!r){const data=view.data||[];if(!data.length)return;const lows=data.map(c=>c.low),highs=data.map(c=>c.high);r={from:Math.min(...lows),to:Math.max(...highs)};}
    const span=Math.max(.01,r.to-r.from), next=span*(action==='y-in'?.75:1.33), center=(r.from+r.to)/2;
    ps.setAutoScale(false);ps.setVisibleRange({from:center-next/2,to:center+next/2});
  }
}
