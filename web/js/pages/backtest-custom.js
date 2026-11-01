// Backtest page: "My strategy", one of the user's saved strategies (Strategy page → My strategies) replayed on the
// stored NIFTY 1-minute history. Form fields, results, equity chart and CSV. The simulation runs on the server
// (server/src/modules/backtest/custom.js), so it needs no Dhan calls.
import { html } from '../core/dom.js';
import { icon } from '../ui/icons.js';
import { LineSeries, createChart } from '../vendor/lightweight-charts.standalone.production.mjs';

export const CUSTOM_KEY = 'custom';
export const CUSTOM_LABEL = 'My strategy (saved on the Strategy page)';

const clock = s => new Intl.DateTimeFormat('en-IN', { timeZone:'Asia/Kolkata', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).format(new Date(s * 1000));
const dayLabel = day => new Intl.DateTimeFormat('en-IN', { day:'numeric', month:'short', year:'numeric', timeZone:'UTC' }).format(new Date(`${day}T00:00:00Z`));
const stamp = s => new Intl.DateTimeFormat('en-IN', { timeZone:'Asia/Kolkata', dateStyle:'medium', timeStyle:'short' }).format(new Date(s * 1000));
const inr = (v, sign = false) => {
  if (!Number.isFinite(v)) return '-';
  const a = Math.abs(v), s = v < 0 ? '-' : sign && v > 0 ? '+' : '';
  return a >= 1e7 ? `${s}₹${(a / 1e7).toLocaleString('en-IN', { maximumFractionDigits:2 })} Cr` : a >= 1e5 ? `${s}₹${(a / 1e5).toLocaleString('en-IN', { maximumFractionDigits:2 })} L` : `${s}₹${Math.round(a).toLocaleString('en-IN')}`;
};
const cls = v => v > 0 ? 'pos' : v < 0 ? 'neg' : '';
const TF = { '1m':'1 minute', '3m':'3 minutes', '5m':'5 minutes', '15m':'15 minutes', day:'Daily' };
const DIR = { long:'Long only (CE)', short:'Short only (PE)', both:'Long & short' };

/** The saved strategy's rules in words: what the backtest will check. */
export function strategyRules(st) {
  if (!st) return [];
  const e = st.entries || {}, x = st.exits || {}, out = [];
  if (e.ema) out.push(`EMA ${e.emaFast} ${st.direction === 'short' ? 'below' : 'above'} EMA ${e.emaSlow}${st.direction === 'both' ? ' (below for PE)' : ''}`);
  if (e.vwap) out.push('Close on the trade’s side of VWAP');
  if (e.rsi) out.push(`RSI 14 ≥ ${e.rsiMin}${st.direction !== 'long' ? ` (≤ ${100 - e.rsiMin} for PE)` : ''}`);
  if (e.breakout) out.push(`Close beyond the last ${e.breakoutBars} bars’ high / low`);
  if (e.volume) out.push('Volume rule (not applied: the index has no volume)');
  if (x.stopMode === 'none' && x.targetMode === 'none') out.push('exit on the opposite crossover');
  else out.push(x.stopMode === 'none' ? 'no stop' : `SL ${x.stopMode === 'amount' ? `₹${x.stopValue} a trade` : `${x.stopValue}%`}`, x.targetMode === 'none' ? 'no target' : `target ${x.targetMode === 'rr' ? `${x.targetValue}R` : `${x.targetValue}%`}`);
  if (x.trailing) out.push(`trailing ${x.trailValue}%`);
  out.push(`square-off ${x.squareOff}`);
  return out;
}

export function customDefaults(ui, caps) {
  const d = caps?.custom?.defaults || {}, list = caps?.custom?.strategies || [];
  const first = (list.find(x => !x.builtIn) || list[0])?.id ?? null;   // the user's own strategy first
  ui.custom ??= { strategyId: first, lots: d.lots ?? 1, slippage: d.slippage ?? 0.5, brokeragePerOrder: d.brokeragePerOrder ?? 15, measure: d.measure ?? 'premium', oppositeExit: d.oppositeExit ?? true, maxTrades: d.maxTrades ?? 20 };
  if (ui.custom.strategyId == null || !list.some(x => x.id === ui.custom.strategyId)) ui.custom.strategyId = first;
}
export function customFromRun(ui, run) {
  const s = run.metrics?.settings; if (!s) return;
  ui.custom = { strategyId: run.metrics.strategyId, lots: s.lots, slippage: s.slippage, brokeragePerOrder: s.brokeragePerOrder, measure: s.measure, oppositeExit: s.oppositeExit, maxTrades: s.maxTrades };
}
export const customPayload = ui => ({ strategy:CUSTOM_KEY, startDate:ui.startDate, endDate:ui.endDate, ...ui.custom });
export function customFieldChange(ui, field) {
  const key = field.dataset.customField; if (!key) return false;
  ui.custom[key] = key === 'strategyId' ? (/^\d+$/.test(field.value) ? Number(field.value) : field.value) : key === 'measure' ? field.value : key === 'oppositeExit' ? field.value === 'on' : Number(field.value);
  return true;
}
export function customRunLabel(run) {
  const m = run.metrics, s = m.summary;
  return `${m.strategy?.name || 'My strategy'} | ${run.startDate} to ${run.endDate} | ${m.settings.lots} lot${m.settings.lots === 1 ? '' : 's'} | ${s.trades} trades | ${inr(s.net, true)}`;
}
export function customRunFacts(run) {
  const m = run.metrics, s = m.settings || {}, st = m.strategy || {};
  return { name: st.name || 'My strategy', settings: [TF[st.timeframe] || st.timeframe, DIR[st.direction] || st.direction, ...strategyRules(st), `${s.lots} lot${s.lots === 1 ? '' : 's'}`, `levels on ${s.measure === 'index' ? 'NIFTY' : 'the premium'}`, s.oppositeExit ? 'reverse on opposite signal' : 'no opposite exit', `₹${s.slippage} slippage`, `₹${s.brokeragePerOrder}/order`],
    trades: String(m.summary.trades), results: [{ label:'Net P&L', value:inr(m.summary.net, true), sub:`gross ${inr(m.summary.gross, true)} · charges ${inr(m.summary.charges)}`, tone:m.summary.net }] };
}

export function customFields(ui, caps) {
  const c = ui.custom, list = caps?.custom?.strategies || [], builtIn = list.find(x => x.id === c.strategyId)?.builtIn, field = (label, control) => html`<label class="strategy-field"><span>${label}</span>${control}</label>`;
  if (!list.length) return html`<div class="bt-muted">No saved strategies yet. Create one on the <a href="/strategy" data-nav="strategy">Strategy</a> page (My strategies → New strategy), then come back to backtest it.</div>`;
  return html`
    ${field('Saved strategy', html`<select class="input" data-custom-field="strategyId" aria-label="Saved strategy">${list.map(x => html`<option value="${x.id}" ${x.id === c.strategyId ? 'selected' : ''}>${x.name}${x.builtIn ? '' : ` · ${TF[x.timeframe] || x.timeframe}`}</option>`)}</select>`)}
    ${field('Lots per trade', html`<input class="input" type="number" min="1" max="100" step="1" data-custom-field="lots" value="${c.lots}" aria-label="Lots per trade">`)}
    ${field('Stop / target measured on', html`<select class="input" data-custom-field="measure" aria-label="Measure the stop and target on"><option value="premium" ${c.measure !== 'index' ? 'selected' : ''}>Option premium</option><option value="index" ${c.measure === 'index' ? 'selected' : ''}>NIFTY index</option></select>`)}
    ${field('Opposite signal', html`<select class="input" data-custom-field="oppositeExit" aria-label="On the opposite signal" ${builtIn ? 'disabled' : ''}><option value="on" ${c.oppositeExit ? 'selected' : ''}>Exit and reverse</option><option value="off" ${c.oppositeExit ? '' : 'selected'}>Ignore (hold to stop / target)</option></select>`)}
    ${field('Max trades a day', html`<input class="input" type="number" min="1" max="100" step="1" data-custom-field="maxTrades" value="${c.maxTrades}" aria-label="Maximum trades a day">`)}
    ${field('Slippage ₹ / unit (entry)', html`<input class="input" type="number" min="0" max="50" step="0.25" data-custom-field="slippage" value="${c.slippage}" aria-label="Entry slippage in rupees per unit">`)}
    ${field('Brokerage ₹ / order', html`<input class="input" type="number" min="0" max="500" step="1" data-custom-field="brokeragePerOrder" value="${c.brokeragePerOrder}" aria-label="Brokerage per order in rupees">`)}`;
}

export function customNotes(ui, caps) {
  const list = caps?.custom?.strategies || [], st = list.find(x => x.id === ui.custom?.strategyId), cov = caps?.custom?.coverage;
  return html`${st ? html`<p class="bt-muted"><b>${st.name}</b> · ${TF[st.timeframe] || st.timeframe} · ${DIR[st.direction] || st.direction}: ${strategyRules(st).join(' · ')}.${st.timeframe === 'day' ? html` <b>Daily strategies cannot be backtested here: change the timeframe on the Strategy page.</b>` : ''}</p>` : ''}
    <p class="bt-muted"><b>How it is tested.</b> NIFTY 1-minute candles are grouped into the strategy's timeframe. A signal is the completed bar on which all the switched-on rules become true together (so an EMA crossover enters on the cross). Long buys the ATM CE, short the ATM PE (nearest weekly expiry), at the option's open in the next minute plus slippage; the strike stays fixed for the trade. Stop, target and trailing stop are checked every minute on ${ui.custom?.measure === 'index' ? 'NIFTY (filled at the option’s close of that minute)' : 'the option premium'}; the stop wins if both are touched in the same minute. One trade at a time. Charges as on each date, with your brokerage per order. VWAP on the index is the session’s running average of (high + low + close) / 3, as the index has no volume.</p>
    <p class="bt-muted">${cov ? `Uses the stored 1-minute history on this server: ${dayLabel(cov.from)} to ${dayLabel(cov.to)} (today's candles are added at about 15:40 IST on weekdays). Runs in seconds and places no orders.` : `The stored history is not available${caps?.custom?.reason ? `: ${caps.custom.reason}` : ''}.`}</p>`;
}

// ---------- Results ----------
export function customResults(ui, result) {
  const m = result.metrics, s = m.summary, reasons = Object.entries(s.exitReasons || {});
  return html`
    <div class="bt-result-head"><div><span class="eyebrow">${m.strategy?.name || CUSTOM_LABEL}</span><h3>Backtest results</h3><small>${result.oneMinuteBars.toLocaleString('en-IN')} one-minute bars | ${result.startDate} to ${result.endDate} IST | ${m.sessions} sessions, ${m.signals} signals | saved ${stamp(result.createdAt / 1000)}</small></div><span class="pill sm ${s.trades ? '' : 'grey'}">${s.trades} TRADE${s.trades === 1 ? '' : 'S'}</span></div>
    ${m.notes?.length ? html`<p class="bt-muted">${m.notes.join(' ')}</p>` : ''}
    <div class="bt-gap-bounds"><article class="bt-gap-bound best"><header><b>Net P&amp;L after charges</b><small>${m.settings.lots} lot${m.settings.lots === 1 ? '' : 's'} a trade, real option premiums</small></header>
      <div class="bt-gap-big ${cls(s.net)}">${inr(s.net, true)}</div>
      <div class="bt-gap-net"><small>Gross ${inr(s.gross, true)} · charges ${inr(s.charges)}</small></div>
      <dl><div><dt>Trades</dt><dd>${s.trades}</dd></div><div><dt>Won</dt><dd>${s.wins} (${s.winRate.toFixed(0)}%)</dd></div>
        <div><dt>Avg win / loss</dt><dd>${inr(s.averageWin, true)} / ${inr(s.averageLoss, true)}</dd></div><div><dt>Best / worst trade</dt><dd>${inr(s.best, true)} / ${inr(s.worst, true)}</dd></div>
        <div><dt>Max drawdown</dt><dd class="${s.maxDrawdown ? 'neg' : ''}">${inr(-s.maxDrawdown)}</dd></div>
        <div><dt>Exits</dt><dd>${reasons.length ? reasons.map(([k, n]) => `${k} ${n}`).join(' · ') : '-'}</dd></div>${s.skipped ? html`<div><dt>Signals not traded</dt><dd>${s.skipped}</dd></div>` : ''}</dl></article></div>
    <div class="bt-orb-actions"><button class="btn bt-chart-btn" data-custom-csv>${icon('chart')} Export trades CSV</button></div>
    ${m.trades.length ? html`<h4 class="bt-orb-title">Cumulative P&amp;L after each trade</h4><div id="bt-custom-equity" class="bt-chart-host bt-orb-equity" role="img" aria-label="Cumulative P&L after each trade"></div>` : html`<div class="bt-empty">${icon('radar')}<b>No trades.</b><span>The strategy's rules never became true together on these dates.</span></div>`}
    ${m.days.length > 1 ? html`<h4 class="bt-orb-title">Day by day</h4><div class="bt-table-wrap"><table class="bt-table"><thead><tr><th>Date</th><th>Trades</th><th>Won</th><th>Charges</th><th>Net</th></tr></thead><tbody>${m.days.slice().reverse().map(d => html`<tr><td>${dayLabel(d.day)}</td><td>${d.trades}</td><td>${d.wins}</td><td>${inr(d.charges)}</td><td class="${cls(d.net)}">${inr(d.net, true)}</td></tr>`)}</tbody></table></div>` : ''}
    ${m.trades.length ? html`<h4 class="bt-orb-title">Trades</h4><div class="bt-table-wrap"><table class="bt-table bt-orb-table"><thead><tr><th>Date</th><th>Contract</th><th>Signal (NIFTY)</th><th>Entry</th><th>Stop / target</th><th>Exit</th><th>Exit reason</th><th>Qty</th><th>Charges</th><th>Net</th><th>Total</th><th>Result</th></tr></thead><tbody>${m.trades.slice().reverse().map(t => html`<tr><td>${dayLabel(t.day)}</td><td><span class="bt-side ${t.side.toLowerCase()}">${t.strike} ${t.side}</span></td><td>${clock(t.signalAt)} · ${t.spot}</td><td>${t.entry.toFixed(2)} at ${clock(t.entryAt)}</td><td>${t.stop == null && t.target == null ? (result.metrics.settings.measure === 'index' && result.metrics.strategy?.exits?.stopMode !== 'none' ? 'on NIFTY' : '-') : `${t.stop != null ? t.stop.toFixed(2) : '-'} / ${t.target != null ? t.target.toFixed(2) : '-'}`}</td><td>${t.exit.toFixed(2)} at ${clock(t.exitAt)}</td><td>${t.exitReason}</td><td>${t.lots} × ${t.lotSize}</td><td>${inr(t.charges)}</td><td class="${cls(t.net)}">${inr(t.net, true)}</td><td class="${cls(t.cumulative)}">${inr(t.cumulative, true)}</td><td><span class="bt-outcome ${t.net > 0 ? 'win' : 'loss'}">${t.net > 0 ? 'WIN' : 'LOSS'}</span></td></tr>`)}</tbody></table></div>` : ''}`;
}

export function drawCustomEquity(host, result, theme) {
  const chart = createChart(host, theme), pts = [];
  for (const p of result.metrics.equityCurve || []) if (!pts.length || p.time > pts.at(-1).time) pts.push(p); else pts[pts.length - 1] = { ...pts.at(-1), value: p.value };
  if (pts.length) chart.addSeries(LineSeries, { color:'#21d3a3', lineWidth:2, priceLineVisible:false, lastValueVisible:true, title:'Net P&L' }).setData(pts);
  chart.timeScale().fitContent();
  return chart;
}
export function customCsv(result) {
  const m = result.metrics, cell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ['date', 'side', 'strike', 'signal_time', 'nifty', 'entry_time', 'entry', 'stop', 'target', 'exit_time', 'exit', 'exit_reason', 'lots', 'lot_size', 'qty', 'gross_inr', 'charges_inr', 'net_inr', 'cumulative_inr'];
  const rows = m.trades.map(t => [t.day, t.side, t.strike, stamp(t.signalAt), t.spot, stamp(t.entryAt), t.entry, t.stop, t.target, stamp(t.exitAt), t.exit, t.exitReason, t.lots, t.lotSize, t.qty, t.gross, t.charges, t.net, t.cumulative]);
  return [head, ...rows].map(r => r.map(cell).join(',')).join('\n');
}
