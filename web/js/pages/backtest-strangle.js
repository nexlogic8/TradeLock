// Backtest page: "CE + PE at a target price": every day the call and the put nearest a target premium (₹3 on NIFTY,
// ₹100 on SENSEX, …), both held to the exit time, with an optional stop. Form fields, results, equity chart and CSV.
// The simulation runs on the server (server/src/modules/backtest/strangle.js) from the stored 1-minute history.
import { html } from '../core/dom.js';
import { icon } from '../ui/icons.js';
import { LineSeries, createChart } from '../vendor/lightweight-charts.standalone.production.mjs';

export const STRANGLE_KEY = 'strangle';
export const STRANGLE_LABEL = 'CE + PE at a target price (both sides)';

const clock = s => new Intl.DateTimeFormat('en-IN', { timeZone:'Asia/Kolkata', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).format(new Date(s * 1000));
const dayLabel = day => new Intl.DateTimeFormat('en-IN', { day:'numeric', month:'short', year:'numeric', timeZone:'UTC' }).format(new Date(`${day}T00:00:00Z`));
const monthLabel = m => new Intl.DateTimeFormat('en-IN', { month:'short', year:'numeric', timeZone:'UTC' }).format(new Date(`${m}-01T00:00:00Z`));
const stamp = s => new Intl.DateTimeFormat('en-IN', { timeZone:'Asia/Kolkata', dateStyle:'medium', timeStyle:'short' }).format(new Date(s * 1000));
const inr = (v, sign = false) => {
  if (!Number.isFinite(v)) return '-';
  const a = Math.abs(v), s = v < 0 ? '-' : sign && v > 0 ? '+' : '';
  return a >= 1e7 ? `${s}₹${(a / 1e7).toLocaleString('en-IN', { maximumFractionDigits:2 })} Cr` : a >= 1e5 ? `${s}₹${(a / 1e5).toLocaleString('en-IN', { maximumFractionDigits:2 })} L` : `${s}₹${Math.round(a).toLocaleString('en-IN')}`;
};
const pct = (v, sign = true) => (Number.isFinite(v) ? `${sign && v > 0 ? '+' : ''}${v.toFixed(1)}%` : '-');
const cls = v => v > 0 ? 'pos' : v < 0 ? 'neg' : '';
const stopText = s => s.stopMode === 'leg' ? `each option −${s.stopPct}%` : s.stopMode === 'whole' ? `both together −${s.stopPct}%` : 'no stop';

export function strangleDefaults(ui, caps) {
  const d = caps?.strangle?.defaults || {}, targets = caps?.strangle?.targets || {};
  ui.strangle ??= { target: targets[ui.underlying || 'NIFTY'] ?? d.target ?? 3, tolerancePct: d.tolerancePct ?? 30, entryTime: d.entryTime ?? '09:20', waitMin: d.waitMin ?? 25,
    exitTime: d.exitTime ?? '15:25', stopMode: d.stopMode ?? 'leg', stopPct: d.stopPct ?? 20, expiryCode: d.expiryCode ?? 1, skipExpiryDay: d.skipExpiryDay ?? true,
    capital: d.capital ?? 600000, fundsUse: d.fundsUse ?? 100, sizing: d.sizing ?? 'compound', maxVolPct: d.maxVolPct ?? 10, slippage: d.slippage ?? 0 };
}
/** The usual target for an index (₹3 NIFTY, ₹100 SENSEX), when the index changes. */
export function strangleIndexChanged(ui, caps) {
  const t = caps?.strangle?.targets?.[ui.underlying];
  if (ui.strangle && Number.isFinite(t)) ui.strangle.target = t;
}
export function strangleFromRun(ui, run) {
  const s = run.metrics?.settings; if (!s) return;
  ui.strangle = { target:s.target, tolerancePct:s.tolerancePct, entryTime:s.entryTime, waitMin:s.waitMin, exitTime:s.exitTime, stopMode:s.stopMode, stopPct:s.stopPct,
    expiryCode:s.expiryCode, skipExpiryDay:s.skipExpiryDay, capital:s.capital, fundsUse:s.fundsUse, sizing:s.sizing, maxVolPct:s.maxVolPct, slippage:s.slippage };
}
export const stranglePayload = ui => ({ strategy:STRANGLE_KEY, startDate:ui.startDate, endDate:ui.endDate, ...ui.strangle });
const TEXT = ['entryTime', 'exitTime', 'stopMode', 'sizing'];
export function strangleFieldChange(ui, field) {
  const key = field.dataset.strangleField; if (!key) return false;
  ui.strangle[key] = key === 'skipExpiryDay' ? field.value === '1' : TEXT.includes(key) ? field.value : Number(field.value);
  return true;
}
export function strangleRunLabel(run) {
  const m = run.metrics, s = m.settings || {}, x = m.summary;
  return `${STRANGLE_LABEL} | ${run.startDate} to ${run.endDate} | ₹${s.target} | ${stopText(s)} | ${x.traded} days | ${pct(x.returnPct)}`;
}
export function strangleRunFacts(run) {
  const m = run.metrics, s = m.settings || {}, x = m.summary;
  return { name: 'CE + PE at a target price', settings: [`₹${s.target} ±${s.tolerancePct}%`, `${s.entryTime} → ${s.exitTime}`, stopText(s), s.expiryCode === 2 ? 'next expiry' : 'nearest expiry',
    `${inr(s.capital)} ${s.sizing === 'compound' ? 'compounding' : 'fixed'} · ${s.fundsUse}% a day`, s.maxVolPct > 0 ? `≤ ${s.maxVolPct}% of volume` : 'no volume limit'],
    trades: `${x.traded} days`, results: [{ label:'Capital', value:`${inr(x.startCapital)} → ${inr(x.endCapital)}`, sub:`${pct(x.returnPct)} · worst day ${pct(x.worstDayPct)}`, tone:x.net }] };
}

export function strangleFields(ui) {
  const g = ui.strangle, field = (label, control) => html`<label class="strategy-field"><span>${label}</span>${control}</label>`;
  const num = (key, label, min, max, step, aria) => field(label, html`<input class="input" type="number" min="${min}" max="${max}" step="${step}" data-strangle-field="${key}" value="${g[key]}" aria-label="${aria}">`);
  return html`
    ${num('target', 'Option price ₹ (both)', 0.05, 5000, 0.05, 'Target premium for the call and the put')}
    ${num('tolerancePct', 'Price band ± %', 1, 90, 1, 'How far from the target a price may be, in percent')}
    ${field('Entry (IST)', html`<input class="input" type="time" min="09:15" max="15:29" data-strangle-field="entryTime" value="${g.entryTime}" aria-label="Entry time">`)}
    ${num('waitMin', 'Wait for a price (min)', 0, 120, 1, 'Minutes to keep looking when no option traded near the target at the entry time')}
    ${field('Exit (IST)', html`<input class="input" type="time" min="09:16" max="15:29" data-strangle-field="exitTime" value="${g.exitTime}" aria-label="Exit time">`)}
    ${field('Stop', html`<select class="input" data-strangle-field="stopMode" aria-label="Stop rule"><option value="leg" ${g.stopMode === 'leg' ? 'selected' : ''}>On each option</option><option value="whole" ${g.stopMode === 'whole' ? 'selected' : ''}>On both together</option><option value="none" ${g.stopMode === 'none' ? 'selected' : ''}>No stop</option></select>`)}
    ${num('stopPct', 'Stop % below entry', 1, 99, 1, 'Stop percent below the entry price')}
    ${field('Expiry', html`<select class="input" data-strangle-field="expiryCode" aria-label="Expiry"><option value="1" ${g.expiryCode === 1 ? 'selected' : ''}>Nearest (strikes ATM ±10)</option><option value="2" ${g.expiryCode === 2 ? 'selected' : ''}>Next (strikes ATM ±3 only)</option></select>`)}
    ${field('On the expiry day', html`<select class="input" data-strangle-field="skipExpiryDay" aria-label="Trade on the day the option expires"><option value="1" ${g.skipExpiryDay ? 'selected' : ''}>Skip (option expires that day)</option><option value="0" ${g.skipExpiryDay ? '' : 'selected'}>Trade it</option></select>`)}
    ${num('capital', 'Starting capital ₹', 1000, 1e10, 1000, 'Starting capital in rupees')}
    ${field('Sizing', html`<select class="input" data-strangle-field="sizing" aria-label="Sizing"><option value="compound" ${g.sizing === 'compound' ? 'selected' : ''}>Compound: % of running capital</option><option value="fixed" ${g.sizing === 'fixed' ? 'selected' : ''}>Fixed: % of starting capital</option></select>`)}
    ${num('fundsUse', 'Capital used a day %', 1, 100, 1, 'Percent of capital used each day')}
    ${num('maxVolPct', 'Max % of volume (0 = off)', 0, 100, 1, 'Size limit as a percent of the option volume in the 10 minutes before entry')}
    ${num('slippage', 'Slippage ₹ / unit (entry)', 0, 50, 0.05, 'Entry slippage in rupees per unit')}`;
}

export function strangleNotes(ui, caps) {
  const g = ui.strangle, cov = caps?.gap?.indices ? caps.gap.indices[ui.underlying || 'NIFTY'] : caps?.gap?.coverage;
  return html`<p class="bt-muted"><b>CE + PE at a target price.</b> Every day at ${g.entryTime}: buy the call and the put whose price is closest to ₹${g.target} (within ±${g.tolerancePct}%, and traded in the last 10 minutes), the same number of lots of each. If none is there yet, keep looking every minute for ${g.waitMin} minutes. Stop: ${g.stopMode === 'leg' ? `each option on its own at ${g.stopPct}% below its entry (the other keeps running)` : g.stopMode === 'whole' ? `both sold together when their combined price is ${g.stopPct}% below the combined entry` : 'none'}. Everything still open is sold at ${g.exitTime}. Charges as on each date, plus extra orders for quantity above the exchange's per-order limit.</p>
    <p class="bt-muted"><b>What the stored history can test:</b> it keeps only strikes near the ATM: the nearest expiry ATM ±10 strikes, the next expiry ±3. Very cheap far options (₹3 on NIFTY) are usually further away, so most days are skipped and listed with the reason; ₹100 on SENSEX is in the data on most days. ${cov ? `Stored range: ${dayLabel(cov.from)} to ${dayLabel(cov.to)}.` : `The stored option history is not available${caps?.gap?.reason ? `: ${caps.gap.reason}` : ''}.`}</p>`;
}

// ---------- Results ----------
const legCell = (side, l) => html`<span class="bt-side ${side.toLowerCase()}">${l.strike} ${side}</span> ${l.entry.toFixed(2)} → ${l.exit.toFixed(2)} <small class="${cls(l.pct)}">(${pct(l.pct)})</small><br><small>${clock(l.entryAt)}–${clock(l.exitAt)} · ${l.exitReason}${l.dataEnded ? ` · price data ends ${clock(l.dataEnded)}` : ''}</small>`;
export function strangleResults(ui, result) {
  const m = result.metrics, s = m.summary, st = m.settings;
  return html`
    <div class="bt-result-head"><div><span class="eyebrow">${STRANGLE_LABEL}</span><h3>Backtest results</h3><small>${result.oneMinuteBars.toLocaleString('en-IN')} one-minute bars | ${result.startDate} to ${result.endDate} IST | ${s.sessions} sessions, ${s.traded} traded, ${s.skipped} skipped | ₹${st.target} ±${st.tolerancePct}% | ${stopText(st)} | saved ${stamp(result.createdAt / 1000)}</small></div><span class="pill sm ${s.traded ? '' : 'grey'}">${s.traded} DAY${s.traded === 1 ? '' : 'S'}</span></div>
    <div class="bt-gap-bounds"><article class="bt-gap-bound best"><header><b>Capital after charges</b><small>${st.sizing === 'compound' ? `compounding, ${st.fundsUse}% of the running capital a day` : `fixed, ${st.fundsUse}% of the starting capital a day`}</small></header>
      <div class="bt-gap-big ${cls(s.net)}">${inr(s.startCapital)} → ${inr(s.endCapital)} <small>(${pct(s.returnPct)})</small></div>
      <div class="bt-gap-net"><small>Net ${inr(s.net, true)} · charges ${inr(s.charges)}</small></div>
      <dl><div><dt>Days traded</dt><dd>${s.traded} of ${s.sessions}</dd></div><div><dt>Won</dt><dd>${s.wins} (${s.winRate.toFixed(0)}%)</dd></div>
        <div><dt>Best / worst day</dt><dd><span class="pos">${pct(s.bestDayPct)}</span> / <span class="neg">${pct(s.worstDayPct)}</span></dd></div>
        <div><dt>Max drawdown</dt><dd class="${s.maxDrawdownPct ? 'neg' : ''}">${pct(-s.maxDrawdownPct)}</dd></div><div><dt>Longest losing run</dt><dd>${s.longestLosingRun} day${s.longestLosingRun === 1 ? '' : 's'}</dd></div>
        ${s.volCapped ? html`<div><dt>Size cut by volume</dt><dd>${s.volCapped} day${s.volCapped === 1 ? '' : 's'}</dd></div>` : ''}${s.dataEnded ? html`<div><dt>Price data ended early</dt><dd>${s.dataEnded} day${s.dataEnded === 1 ? '' : 's'}</dd></div>` : ''}</dl></article></div>
    <div class="bt-orb-actions"><button class="btn bt-chart-btn" data-strangle-csv>${icon('chart')} Export days CSV</button></div>
    ${m.trades.length ? html`<h4 class="bt-orb-title">Capital after each day</h4><div id="bt-strangle-equity" class="bt-chart-host bt-orb-equity" role="img" aria-label="Capital after each day"></div>` : html`<div class="bt-empty">${icon('radar')}<b>No days traded.</b><span>No call and put near ₹${st.target} in the stored strikes on these dates. See the skipped days below.</span></div>`}
    ${m.months.length ? html`<h4 class="bt-orb-title">Month by month</h4><div class="bt-table-wrap"><table class="bt-table"><thead><tr><th>Month</th><th>Days</th><th>Won</th><th>Net</th><th>Capital</th></tr></thead><tbody>${m.months.slice().reverse().map(x => html`<tr><td>${monthLabel(x.month)}</td><td>${x.days}</td><td>${x.wins}</td><td class="${cls(x.net)}">${inr(x.net, true)}</td><td>${inr(x.startCapital)} → ${inr(x.endCapital)}</td></tr>`)}</tbody></table></div>` : ''}
    ${m.trades.length ? html`<h4 class="bt-orb-title">Days</h4><div class="bt-table-wrap"><table class="bt-table bt-orb-table"><thead><tr><th>Date</th><th>${st.underlying}</th><th>Call</th><th>Put</th><th>Lots</th><th>Invested</th><th>Charges</th><th>Net</th><th>Day %</th><th>Capital</th></tr></thead><tbody>${m.trades.slice().reverse().map(t => html`<tr><td>${dayLabel(t.day)}<br><small>exp ${dayLabel(t.expiry)}</small></td><td>${Math.round(t.index[0]).toLocaleString('en-IN')} → ${Math.round(t.index[1]).toLocaleString('en-IN')}</td><td>${legCell('CE', t.ce)}</td><td>${legCell('PE', t.pe)}</td><td>${t.lots.toLocaleString('en-IN')} × ${t.lotSize}${t.volCapped ? html`<br><small>volume limit</small>` : ''}</td><td>${inr(t.invested)}</td><td>${inr(t.charges)}</td><td class="${cls(t.net)}">${inr(t.net, true)}</td><td class="${cls(t.dayPct)}">${pct(t.dayPct)}</td><td>${inr(t.capitalAfter)}</td></tr>`)}</tbody></table></div>` : ''}
    ${m.skipped.length ? html`<details class="bt-orb-days"><summary>Days not traded (${m.skipped.length})</summary><div class="bt-table-wrap"><table class="bt-table"><thead><tr><th>Date</th><th>Why</th></tr></thead><tbody>${m.skipped.slice().reverse().map(x => html`<tr><td>${dayLabel(x.day)}</td><td>${x.reason}</td></tr>`)}</tbody></table></div></details>` : ''}`;
}

// ---------- Chart & CSV ----------
export function drawStrangleEquity(host, result, theme) {
  const chart = createChart(host, theme), pts = [];
  for (const p of result.metrics.equityCurve || []) if (!pts.length || p.time > pts.at(-1).time) pts.push(p); else pts[pts.length - 1] = { ...pts.at(-1), value: p.value };
  if (pts.length) chart.addSeries(LineSeries, { color:'#21d3a3', lineWidth:2, priceLineVisible:false, lastValueVisible:true, title:'Capital' }).setData(pts);
  chart.timeScale().fitContent();
  return chart;
}
export function strangleCsv(result) {
  const m = result.metrics, cell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ['date', 'expiry', 'index_entry', 'index_exit', 'ce_strike', 'ce_entry_time', 'ce_entry', 'ce_exit_time', 'ce_exit', 'ce_exit_reason', 'pe_strike', 'pe_entry_time', 'pe_entry', 'pe_exit_time', 'pe_exit', 'pe_exit_reason',
    'lots', 'lot_size', 'qty', 'invested_inr', 'gross_inr', 'charges_inr', 'net_inr', 'day_pct', 'capital_after_inr'];
  const rows = m.trades.map(t => [t.day, t.expiry, t.index[0], t.index[1], t.ce.strike, stamp(t.ce.entryAt), t.ce.entry, stamp(t.ce.exitAt), t.ce.exit, t.ce.exitReason,
    t.pe.strike, stamp(t.pe.entryAt), t.pe.entry, stamp(t.pe.exitAt), t.pe.exit, t.pe.exitReason, t.lots, t.lotSize, t.qty, t.invested, t.gross, t.charges, t.net, t.dayPct, t.capitalAfter]);
  return [head, ...rows].map(r => r.map(cell).join(',')).join('\n');
}
