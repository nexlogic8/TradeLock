// Backtest page: "EMA 9/15 5m · 30° angle", the live Algo Trading strategy. Form fields, results, equity chart and CSV.
// The simulation runs on the server (server/src/modules/backtest/ema915.js) from the stored 1-minute history, so it
// needs no Dhan calls.
import { html } from '../core/dom.js';
import { icon } from '../ui/icons.js';
import { LineSeries, createChart } from '../vendor/lightweight-charts.standalone.production.mjs';

export const EMA915_KEY = 'ema915';
export const EMA915_LABEL = 'EMA 9/15 5m · 30° angle (live Algo strategy)';

const clock = s => new Intl.DateTimeFormat('en-IN', { timeZone:'Asia/Kolkata', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).format(new Date(s * 1000));
const dayLabel = day => new Intl.DateTimeFormat('en-IN', { day:'numeric', month:'short', year:'numeric', timeZone:'UTC' }).format(new Date(`${day}T00:00:00Z`));
const monthLabel = m => new Intl.DateTimeFormat('en-IN', { month:'short', year:'numeric', timeZone:'UTC' }).format(new Date(`${m}-01T00:00:00Z`));
const stamp = s => new Intl.DateTimeFormat('en-IN', { timeZone:'Asia/Kolkata', dateStyle:'medium', timeStyle:'short' }).format(new Date(s * 1000));
const inr = (v, sign = false) => {
  if (!Number.isFinite(v)) return '-';
  const a = Math.abs(v), s = v < 0 ? '-' : sign && v > 0 ? '+' : '';
  return a >= 1e7 ? `${s}₹${(a / 1e7).toLocaleString('en-IN', { maximumFractionDigits:2 })} Cr` : a >= 1e5 ? `${s}₹${(a / 1e5).toLocaleString('en-IN', { maximumFractionDigits:2 })} L` : `${s}₹${Math.round(a).toLocaleString('en-IN')}`;
};
const cls = v => v > 0 ? 'pos' : v < 0 ? 'neg' : '';

export function ema915Defaults(ui, caps) {
  const d = caps?.ema915?.defaults || {};
  ui.ema915 ??= { lots:d.lots ?? 1, slippage:d.slippage ?? 1, minAngle:d.minAngle ?? 30, afterCross:d.afterCross ?? 3, costToCostR:d.costToCostR ?? 1, lastEntry:d.lastEntry ?? '15:00', squareOff:d.squareOff ?? '15:15' };
}
/** Restore the form from a saved run's settings. */
export function ema915FromRun(ui, run) {
  const s = run.metrics?.settings; if (!s) return;
  ui.ema915 = { lots:s.lots, slippage:s.slippage, minAngle:s.minAngle, afterCross:s.afterCross, costToCostR:s.costToCostR, lastEntry:s.lastEntry, squareOff:s.squareOff };
}
export const ema915Payload = ui => ({ strategy:EMA915_KEY, startDate:ui.startDate, endDate:ui.endDate, ...ui.ema915 });
/** Apply a change from a [data-ema915-field] control. Returns true when handled. */
export function ema915FieldChange(ui, field) {
  const key = field.dataset.ema915Field; if (!key) return false;
  ui.ema915[key] = key === 'lastEntry' || key === 'squareOff' ? field.value : Number(field.value);
  return true;
}
export function ema915RunLabel(run) {
  const m = run.metrics, s = m.settings || {};
  return `${EMA915_LABEL} | ${run.startDate} to ${run.endDate} | ${s.minAngle}° | ${s.lots} lot${s.lots === 1 ? '' : 's'} | ${m.summary.trades} trades | ${inr(m.summary.net, true)}`;
}
/** Settings and results of a saved run, for the saved-backtests list and the run details strip. */
export function ema915RunFacts(run) {
  const m = run.metrics, s = m.settings || {}, x = m.summary;
  return { name: 'EMA 9/15 5m', settings: [`angle ≥ ${s.minAngle}°`, `up to ${s.afterCross} candle${s.afterCross === 1 ? '' : 's'} after the cross`, `${s.lots} lot${s.lots === 1 ? '' : 's'}`, `₹${s.slippage} slippage`, s.costToCostR > 0 ? `cost to cost at ${s.costToCostR}R` : 'no cost to cost', `last entry ${s.lastEntry}`, `square-off ${s.squareOff}`],
    trades: String(x.trades), results: [{ label:'Net P&L', value:inr(x.net, true), sub:`${x.winRate.toFixed(0)}% won · charges ${inr(x.charges)}`, tone:x.net }] };
}

export function ema915Fields(ui) {
  const g = ui.ema915, field = (label, control) => html`<label class="strategy-field"><span>${label}</span>${control}</label>`;
  return html`
    ${field('Minimum EMA 9 angle °', html`<input class="input" type="number" min="0" max="89" step="1" data-ema915-field="minAngle" value="${g.minAngle}" aria-label="Minimum EMA 9 angle in degrees">`)}
    ${field('Candles after the cross', html`<input class="input" type="number" min="0" max="10" step="1" data-ema915-field="afterCross" value="${g.afterCross}" aria-label="How many 5-minute candles after the crossover the angle may come">`)}
    ${field('Lots per trade', html`<input class="input" type="number" min="1" max="1000" step="1" data-ema915-field="lots" value="${g.lots}" aria-label="Lots per trade">`)}
    ${field('Slippage ₹ / unit (entry)', html`<input class="input" type="number" min="0" max="50" step="0.25" data-ema915-field="slippage" value="${g.slippage}" aria-label="Entry slippage in rupees per unit">`)}
    ${field('Cost to cost at R (0 = off)', html`<input class="input" type="number" min="0" max="5" step="0.25" data-ema915-field="costToCostR" value="${g.costToCostR}" aria-label="Move the stop to the entry price at this multiple of the risk; 0 for off">`)}
    ${field('Last entry (IST)', html`<input class="input" type="time" min="09:20" max="15:29" data-ema915-field="lastEntry" value="${g.lastEntry}" aria-label="No new entries after this time">`)}
    ${field('Square-off (IST)', html`<input class="input" type="time" min="09:20" max="15:29" data-ema915-field="squareOff" value="${g.squareOff}" aria-label="Square-off time">`)}`;
}

export function ema915Notes(ui, caps) {
  const g = ui.ema915, cov = caps?.gap?.indices ? caps.gap.indices[ui.underlying || 'NIFTY'] : caps?.gap?.coverage;
  return html`<p class="bt-muted"><b>EMA 9/15 5m — the strategy Algo Trading runs live.</b> NIFTY 5-minute candles; EMA 9, EMA 15 and ATR 14 run across sessions, as on the chart. When EMA 9 crosses above EMA 15 (CE) or below it (PE), the first candle of that trend, the crossover candle or up to ${g.afterCross} after it, on which EMA 9 moves at ${g.minAngle}° or steeper (angle = atan(EMA 9’s change ÷ ATR 14)) is the signal. One chance per crossover, as live: if a trade is still open or it is after ${g.lastEntry}, that crossover is skipped. Entry: the ATM option of the next expiry at the next minute's open + ₹${g.slippage}. Stop: 1 tick below the option's low during the signal candle.${g.costToCostR > 0 ? ` Cost to cost at ${g.costToCostR}R.` : ''} Exit: the next minute's open after the first opposite-colour 5-minute candle (red for CE, green for PE), the stop, or ${g.squareOff}. Charges as on each date.</p>
    <p class="bt-muted">${cov ? `Uses the stored 1-minute option history on this server: ${dayLabel(cov.from)} to ${dayLabel(cov.to)}. Runs in seconds and places no orders.` : `The stored option history is not available${caps?.gap?.reason ? `: ${caps.gap.reason}` : ''}.`}</p>`;
}

// ---------- Results ----------
export function ema915Results(ui, result) {
  const m = result.metrics, s = m.summary, st = m.settings;
  return html`
    <div class="bt-result-head"><div><span class="eyebrow">${EMA915_LABEL}</span><h3>Backtest results</h3><small>${result.oneMinuteBars.toLocaleString('en-IN')} one-minute bars | ${result.startDate} to ${result.endDate} IST | ${m.sessions} sessions, ${m.crossovers} crossovers, ${m.signals} at ${st.minAngle}°+ | saved ${stamp(result.createdAt / 1000)}</small></div><span class="pill sm ${s.trades ? '' : 'grey'}">${s.trades} TRADE${s.trades === 1 ? '' : 'S'}</span></div>
    <div class="bt-gap-bounds"><article class="bt-gap-bound best"><header><b>Net P&amp;L after charges</b><small>${st.lots} lot${st.lots === 1 ? '' : 's'} a trade, real option premiums</small></header>
      <div class="bt-gap-big ${cls(s.net)}">${inr(s.net, true)}</div>
      <div class="bt-gap-net"><small>${inr(s.averageTrade, true)} a trade · ${s.perMonth.toFixed(1)} trades a month · charges ${inr(s.charges)}</small></div>
      <dl><div><dt>Trades</dt><dd>${s.trades}</dd></div><div><dt>Won</dt><dd>${s.wins} (${s.winRate.toFixed(0)}%)</dd></div><div><dt>Stops hit</dt><dd>${s.stops}${s.atCost ? ` · ${s.atCost} at cost` : ''}</dd></div>
        <div><dt>Avg win / loss</dt><dd>${inr(s.averageWin, true)} / ${inr(s.averageLoss, true)}</dd></div><div><dt>Avg R</dt><dd class="${cls(s.averageR)}">${s.averageR.toFixed(2)}</dd></div>
        <div><dt>Max drawdown</dt><dd class="${s.maxDrawdown ? 'neg' : ''}">${inr(-s.maxDrawdown)}</dd></div>${s.skipped ? html`<div><dt>Signals not traded</dt><dd>${s.skipped}</dd></div>` : ''}</dl></article></div>
    <div class="bt-orb-actions"><button class="btn bt-chart-btn" data-ema915-csv>${icon('chart')} Export trades CSV</button></div>
    ${m.trades.length ? html`<h4 class="bt-orb-title">Cumulative P&amp;L after each trade</h4><div id="bt-ema915-equity" class="bt-chart-host bt-orb-equity" role="img" aria-label="Cumulative P&L after each trade"></div>` : html`<div class="bt-empty">${icon('radar')}<b>No trades.</b><span>No EMA 9/15 crossover reached ${st.minAngle}° on these dates.</span></div>`}
    ${m.months.length ? html`<h4 class="bt-orb-title">Month by month</h4><div class="bt-table-wrap"><table class="bt-table"><thead><tr><th>Month</th><th>Trades</th><th>Won</th><th>Stops</th><th>Net</th></tr></thead><tbody>${m.months.slice().reverse().map(x => html`<tr><td>${monthLabel(x.month)}</td><td>${x.trades}</td><td>${x.wins}</td><td>${x.stops}</td><td class="${cls(x.net)}">${inr(x.net, true)}</td></tr>`)}</tbody></table></div>` : ''}
    ${m.trades.length ? html`<h4 class="bt-orb-title">Trades</h4><div class="bt-table-wrap"><table class="bt-table bt-orb-table"><thead><tr><th>Date</th><th>Contract</th><th>Signal candle</th><th>Angle</th><th>Entry</th><th>Stop</th><th>Exit</th><th>Exit reason</th><th>R</th><th>Charges</th><th>Net</th><th>Total</th><th>Result</th></tr></thead><tbody>${m.trades.slice().reverse().map(t => html`<tr><td>${dayLabel(t.day)}</td><td><span class="bt-side ${t.side.toLowerCase()}">${t.strike} ${t.side}</span></td><td>${clock(t.signalAt)}</td><td>${t.angle.toFixed(1)}°</td><td>${t.entry.toFixed(2)} at ${clock(t.entryAt)}</td><td>${t.stop.toFixed(2)}</td><td>${t.exit.toFixed(2)} at ${clock(t.exitAt)}</td><td>${t.exitReason}</td><td class="${cls(t.r)}">${t.r.toFixed(2)}</td><td>${inr(t.charges)}</td><td class="${cls(t.net)}">${inr(t.net, true)}</td><td class="${cls(t.cumulative)}">${inr(t.cumulative, true)}</td><td><span class="bt-outcome ${t.net > 0 ? 'win' : 'loss'}">${t.net > 0 ? 'WIN' : 'LOSS'}</span></td></tr>`)}</tbody></table></div>` : ''}
    ${m.skipped.length ? html`<details class="bt-orb-days"><summary>Signals not traded (${m.skipped.length})</summary><div class="bt-table-wrap"><table class="bt-table"><thead><tr><th>Date</th><th>Side</th><th>Signal candle</th><th>Angle</th><th>Why</th></tr></thead><tbody>${m.skipped.slice().reverse().map(x => html`<tr><td>${dayLabel(x.day)}</td><td>${x.side}</td><td>${clock(x.signalAt)}</td><td>${x.angle.toFixed(1)}°</td><td>${x.reason}</td></tr>`)}</tbody></table></div></details>` : ''}`;
}

// ---------- Chart & CSV ----------
export function drawEma915Equity(host, result, theme) {
  const chart = createChart(host, theme), pts = [];
  for (const p of result.metrics.equityCurve || []) if (!pts.length || p.time > pts.at(-1).time) pts.push(p); else pts[pts.length - 1] = { ...pts.at(-1), value: p.value };
  if (pts.length) chart.addSeries(LineSeries, { color:'#21d3a3', lineWidth:2, priceLineVisible:false, lastValueVisible:true, title:'Net P&L' }).setData(pts);
  chart.timeScale().fitContent();
  return chart;
}
export function ema915Csv(result) {
  const m = result.metrics, cell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ['date', 'side', 'strike', 'signal_candle', 'angle', 'entry_time', 'entry', 'stop', 'exit_time', 'exit', 'exit_reason', 'r', 'lots', 'lot_size', 'qty', 'gross_inr', 'charges_inr', 'net_inr', 'cumulative_inr'];
  const rows = m.trades.map(t => [t.day, t.side, t.strike, stamp(t.signalAt), t.angle, stamp(t.entryAt), t.entry, t.stop, stamp(t.exitAt), t.exit, t.exitReason, t.r, t.lots, t.lotSize, t.qty, t.gross, t.charges, t.net, t.cumulative]);
  return [head, ...rows].map(r => r.map(cell).join(',')).join('\n');
}
