// Backtest page: "Overnight ATM CE + PE": buy the ATM call and put near the close, sell both the next morning (gains
// on a big gap either way). Form fields, results, capital chart and CSV. The simulation runs on the server
// (server/src/modules/backtest/overnight.js) from the stored near-ATM 1-minute history.
import { html } from '../core/dom.js';
import { icon } from '../ui/icons.js';
import { LineSeries, createChart } from '../vendor/lightweight-charts.standalone.production.mjs';

export const OVERNIGHT_KEY = 'overnight';
export const OVERNIGHT_LABEL = 'Overnight ATM CE + PE (buy at close, sell next morning)';

const clock = s => new Intl.DateTimeFormat('en-IN', { timeZone:'Asia/Kolkata', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).format(new Date(s * 1000));
const dayLabel = day => new Intl.DateTimeFormat('en-IN', { day:'numeric', month:'short', year:'numeric', timeZone:'UTC' }).format(new Date(`${day}T00:00:00Z`));
const shortDay = day => new Intl.DateTimeFormat('en-IN', { weekday:'short', day:'numeric', month:'short', timeZone:'UTC' }).format(new Date(`${day}T00:00:00Z`));
const monthLabel = m => new Intl.DateTimeFormat('en-IN', { month:'short', year:'numeric', timeZone:'UTC' }).format(new Date(`${m}-01T00:00:00Z`));
const stamp = s => new Intl.DateTimeFormat('en-IN', { timeZone:'Asia/Kolkata', dateStyle:'medium', timeStyle:'short' }).format(new Date(s * 1000));
const inr = (v, sign = false) => {
  if (!Number.isFinite(v)) return '-';
  const a = Math.abs(v), s = v < 0 ? '-' : sign && v > 0 ? '+' : '';
  return a >= 1e7 ? `${s}₹${(a / 1e7).toLocaleString('en-IN', { maximumFractionDigits:2 })} Cr` : a >= 1e5 ? `${s}₹${(a / 1e5).toLocaleString('en-IN', { maximumFractionDigits:2 })} L` : `${s}₹${Math.round(a).toLocaleString('en-IN')}`;
};
const pct = (v, sign = true) => (Number.isFinite(v) ? `${sign && v > 0 ? '+' : ''}${v.toFixed(1)}%` : '-');
const cls = v => v > 0 ? 'pos' : v < 0 ? 'neg' : '';
const STRIKES = { atm:'ATM', otm1:'1 strike OTM each side', itm1:'1 strike ITM each side' };
const EVE = { skip:'skip the night before expiry', next:'next week’s contract before expiry', hold:'hold into expiry' };

export function overnightDefaults(ui, caps) {
  const d = caps?.overnight?.defaults || {};
  ui.overnight ??= { strikes: d.strikes ?? 'atm', entryTime: d.entryTime ?? '15:25', exitTime: d.exitTime ?? '09:45', expiryEve: d.expiryEve ?? 'skip', skipBreaks: d.skipBreaks ?? true,
    capital: d.capital ?? 50000, fundsUse: d.fundsUse ?? 100, sizing: d.sizing ?? 'compound', slippage: d.slippage ?? 0 };
}
export function overnightFromRun(ui, run) {
  const s = run.metrics?.settings; if (!s) return;
  ui.overnight = { strikes:s.strikes, entryTime:s.entryTime, exitTime:s.exitTime, expiryEve:s.expiryEve, skipBreaks:s.skipBreaks, capital:s.capital, fundsUse:s.fundsUse, sizing:s.sizing, slippage:s.slippage };
}
export const overnightPayload = ui => ({ strategy:OVERNIGHT_KEY, startDate:ui.startDate, endDate:ui.endDate, ...ui.overnight });
const TEXT = ['strikes', 'entryTime', 'exitTime', 'expiryEve', 'sizing'];
export function overnightFieldChange(ui, field) {
  const key = field.dataset.overnightField; if (!key) return false;
  ui.overnight[key] = key === 'skipBreaks' ? field.value === '1' : TEXT.includes(key) ? field.value : Number(field.value);
  return true;
}
const settingsText = s => [STRIKES[s.strikes] || s.strikes, `buy ${s.entryTime} → sell ${s.exitTime} next day`, EVE[s.expiryEve] || s.expiryEve, s.skipBreaks ? 'no weekend / holiday holds' : 'holds over weekends'];
export function overnightRunLabel(run) {
  const m = run.metrics, s = m.settings || {}, x = m.summary;
  return `${OVERNIGHT_LABEL} | ${run.startDate} to ${run.endDate} | ${settingsText(s).join(' | ')} | ${x.traded} nights | ${pct(x.returnPct)}`;
}
export function overnightRunFacts(run) {
  const m = run.metrics, s = m.settings || {}, x = m.summary;
  return { name: 'Overnight ATM CE + PE', settings: [...settingsText(s), `${inr(s.capital)} ${s.sizing === 'compound' ? 'compounding' : 'fixed'} · ${s.fundsUse}% a night`],
    trades: `${x.traded} nights`, results: [{ label:'Capital', value:`${inr(x.startCapital)} → ${inr(x.endCapital)}`, sub:`${pct(x.returnPct)} · worst night ${pct(x.worstDayPct)}`, tone:x.net }] };
}

export function overnightFields(ui) {
  const g = ui.overnight, field = (label, control) => html`<label class="strategy-field"><span>${label}</span>${control}</label>`;
  const num = (key, label, min, max, step, aria) => field(label, html`<input class="input" type="number" min="${min}" max="${max}" step="${step}" data-overnight-field="${key}" value="${g[key]}" aria-label="${aria}">`);
  const sel = (key, label, opts, aria) => field(label, html`<select class="input" data-overnight-field="${key}" aria-label="${aria}">${opts.map(([v, t]) => html`<option value="${v}" ${String(g[key]) === String(v) ? 'selected' : ''}>${t}</option>`)}</select>`);
  return html`
    ${sel('strikes', 'Strikes', [['atm', 'ATM call + ATM put'], ['otm1', '1 strike OTM each side'], ['itm1', '1 strike ITM each side']], 'Which call and put to buy')}
    ${field('Buy at (IST)', html`<input class="input" type="time" min="14:00" max="15:29" data-overnight-field="entryTime" value="${g.entryTime}" aria-label="Buy time">`)}
    ${field('Sell next day at (IST)', html`<input class="input" type="time" min="09:15" max="12:00" data-overnight-field="exitTime" value="${g.exitTime}" aria-label="Sell time the next trading day">`)}
    ${sel('expiryEve', 'Night before expiry', [['skip', 'Skip that night'], ['next', 'Use next week’s contract'], ['hold', 'Hold the expiring contract']], 'What to do on the night before the contract expires')}
    ${sel('skipBreaks', 'Weekends & holidays', [['1', 'Skip (no Friday → Monday)'], ['0', 'Hold over them']], 'Hold the position over weekends and holidays')}
    ${num('capital', 'Starting capital ₹', 1000, 1e10, 1000, 'Starting capital in rupees')}
    ${sel('sizing', 'Sizing', [['compound', 'Compound: % of running capital'], ['fixed', 'Fixed: % of starting capital']], 'Sizing')}
    ${num('fundsUse', 'Capital used a night %', 1, 100, 1, 'Percent of capital used each night')}
    ${num('slippage', 'Slippage ₹ / unit (entry)', 0, 50, 0.05, 'Entry slippage in rupees per unit')}
    ${field('Settings', html`<button type="button" class="btn" data-overnight-reset aria-label="Reset these settings to the defaults">Reset to defaults</button>`)}`;
}

export function overnightNotes(ui, caps) {
  const g = ui.overnight, cov = caps?.gap?.indices ? caps.gap.indices[ui.underlying || 'NIFTY'] : caps?.gap?.coverage;
  return html`<p class="bt-muted"><b>Overnight ATM CE + PE.</b> Every trading day at ${g.entryTime}: buy ${g.strikes === 'atm' ? 'the ATM call and the ATM put' : g.strikes === 'otm1' ? 'the call one strike above the ATM and the put one strike below it' : 'the call one strike below the ATM and the put one strike above it'} of the nearest weekly expiry (the same number of lots of each, at that minute's close), and sell both at ${g.exitTime} the next trading day. It gains when the index opens with a big gap up or down; on a quiet open both lose value overnight. Night before expiry: ${g.expiryEve === 'skip' ? 'no trade' : g.expiryEve === 'next' ? 'next week’s contract instead (stored ±3 strikes only, so a gap of more than about 150 NIFTY points has no exit price and the night is skipped)' : 'hold the contract expiring the next morning'}. On an expiry day the next week's contract is used. ${g.skipBreaks ? 'No position is held over a weekend or holiday. ' : ''}Charges as on each date.</p>
    <p class="bt-muted"><b>Data:</b> the near-ATM history (Dhan's expired-options data: nearest expiry ATM ±10 strikes, next expiry ±3), a year or more. A night is listed as not traded when the sell price is missing, for example after a gap beyond the stored strikes. ${cov ? `Stored range: ${dayLabel(cov.from)} to ${dayLabel(cov.to)}.` : `The stored option history is not available${caps?.gap?.reason ? `: ${caps.gap.reason}` : ''}.`}</p>`;
}

// ---------- Results ----------
const legCell = (side, l) => html`<span class="bt-side ${side.toLowerCase()}">${l.strike} ${side}</span> ${l.entry.toFixed(2)} → ${l.exit.toFixed(2)} <small class="${cls(l.pct)}">(${pct(l.pct)})</small><br><small>sold ${clock(l.exitAt)}</small>`;
export function overnightResults(ui, result) {
  const m = result.metrics, s = m.summary, st = m.settings;
  return html`
    <div class="bt-result-head"><div><span class="eyebrow">${OVERNIGHT_LABEL}</span><h3>Backtest results</h3><small>${result.startDate} to ${result.endDate} IST | ${s.sessions} nights, ${s.traded} traded, ${s.skipped} not traded | ${settingsText(st).join(' | ')} | saved ${stamp(result.createdAt / 1000)}</small></div><span class="pill sm ${s.traded ? '' : 'grey'}">${s.traded} NIGHT${s.traded === 1 ? '' : 'S'}</span></div>
    <div class="bt-gap-bounds"><article class="bt-gap-bound best"><header><b>Capital after charges</b><small>${st.sizing === 'compound' ? `compounding, ${st.fundsUse}% of the running capital a night` : `fixed, ${st.fundsUse}% of the starting capital a night`}</small></header>
      <div class="bt-gap-big ${cls(s.net)}">${inr(s.startCapital)} → ${inr(s.endCapital)} <small>(${pct(s.returnPct)})</small></div>
      <div class="bt-gap-net"><small>Net ${inr(s.net, true)} · charges ${inr(s.charges)}</small></div>
      <dl><div><dt>Nights traded</dt><dd>${s.traded} of ${s.sessions}</dd></div><div><dt>Won</dt><dd>${s.wins} (${s.winRate.toFixed(0)}%)</dd></div>
        <div><dt>Best / worst night</dt><dd><span class="pos">${pct(s.bestDayPct)}</span> / <span class="neg">${pct(s.worstDayPct)}</span></dd></div>
        <div><dt>Max drawdown</dt><dd class="${s.maxDrawdownPct ? 'neg' : ''}">${pct(-s.maxDrawdownPct)}</dd></div><div><dt>Longest losing run</dt><dd>${s.longestLosingRun} night${s.longestLosingRun === 1 ? '' : 's'}</dd></div></dl></article></div>
    <div class="bt-orb-actions"><button class="btn bt-chart-btn" data-overnight-csv>${icon('chart')} Export nights CSV</button></div>
    ${m.trades.length ? html`<h4 class="bt-orb-title">Capital after each night</h4><div id="bt-overnight-equity" class="bt-chart-host bt-orb-equity" role="img" aria-label="Capital after each night"></div>` : html`<div class="bt-empty">${icon('radar')}<b>No nights traded.</b><span>See the nights not traded below.</span></div>`}
    ${m.months.length ? html`<h4 class="bt-orb-title">Month by month</h4><div class="bt-table-wrap"><table class="bt-table"><thead><tr><th>Month</th><th>Nights</th><th>Won</th><th>Net</th><th>Capital</th></tr></thead><tbody>${m.months.slice().reverse().map(x => html`<tr><td>${monthLabel(x.month)}</td><td>${x.days}</td><td>${x.wins}</td><td class="${cls(x.net)}">${inr(x.net, true)}</td><td>${inr(x.startCapital)} → ${inr(x.endCapital)}</td></tr>`)}</tbody></table></div>` : ''}
    ${m.trades.length ? html`<h4 class="bt-orb-title">Nights</h4><div class="bt-table-wrap"><table class="bt-table bt-orb-table"><thead><tr><th>Bought → sold</th><th>${st.underlying} gap</th><th>Call</th><th>Put</th><th>Lots</th><th>Invested</th><th>Charges</th><th>Net</th><th>Night %</th><th>Capital</th></tr></thead><tbody>${m.trades.slice().reverse().map(t => html`<tr><td>${shortDay(t.day)} → ${shortDay(t.next)}<br><small>exp ${dayLabel(t.expiry)}</small></td><td class="${cls(t.gap)}">${t.gap > 0 ? '+' : ''}${Math.round(t.gap).toLocaleString('en-IN')}<br><small>${Math.round(t.index[0]).toLocaleString('en-IN')} → ${Math.round(t.index[1]).toLocaleString('en-IN')}</small></td><td>${legCell('CE', t.ce)}</td><td>${legCell('PE', t.pe)}</td><td>${t.lots.toLocaleString('en-IN')} × ${t.lotSize}</td><td>${inr(t.invested)}</td><td>${inr(t.charges)}</td><td class="${cls(t.net)}">${inr(t.net, true)}</td><td class="${cls(t.dayPct)}">${pct(t.dayPct)}</td><td>${inr(t.capitalAfter)}</td></tr>`)}</tbody></table></div>` : ''}
    ${m.skipped.length ? html`<details class="bt-orb-days"><summary>Nights not traded (${m.skipped.length})</summary><div class="bt-table-wrap"><table class="bt-table"><thead><tr><th>Date</th><th>Why</th></tr></thead><tbody>${m.skipped.slice().reverse().map(x => html`<tr><td>${dayLabel(x.day)}</td><td>${x.reason}</td></tr>`)}</tbody></table></div></details>` : ''}`;
}

// ---------- Chart & CSV ----------
export function drawOvernightEquity(host, result, theme) {
  const chart = createChart(host, theme), pts = [];
  for (const p of result.metrics.equityCurve || []) if (!pts.length || p.time > pts.at(-1).time) pts.push(p); else pts[pts.length - 1] = { ...pts.at(-1), value: p.value };
  if (pts.length) chart.addSeries(LineSeries, { color:'#21d3a3', lineWidth:2, priceLineVisible:false, lastValueVisible:true, title:'Capital' }).setData(pts);
  chart.timeScale().fitContent();
  return chart;
}
export function overnightCsv(result) {
  const m = result.metrics, cell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ['buy_date', 'sell_date', 'expiry', 'gap_points', 'index_at_buy', 'index_at_sell', 'ce_strike', 'ce_buy', 'ce_sell', 'pe_strike', 'pe_buy', 'pe_sell',
    'lots', 'lot_size', 'qty', 'invested_inr', 'gross_inr', 'charges_inr', 'net_inr', 'night_pct', 'capital_after_inr'];
  const rows = m.trades.map(t => [t.day, t.next, t.expiry, t.gap, t.index[0], t.index[1], t.ce.strike, t.ce.entry, t.ce.exit, t.pe.strike, t.pe.entry, t.pe.exit,
    t.lots, t.lotSize, t.qty, t.invested, t.gross, t.charges, t.net, t.dayPct, t.capitalAfter]);
  return [head, ...rows].map(r => r.map(cell).join(',')).join('\n');
}
