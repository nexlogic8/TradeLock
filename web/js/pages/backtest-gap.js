// Backtest page: "Gap open 09:15", the live Algo Trading strategy. Form fields, results (both bounds: fill at the
// 09:15 open vs at 09:16), equity chart and CSV. The simulation runs on the server (server/src/modules/backtest/gap.js)
// from the stored 1-minute history, so it needs no Dhan calls.
import { html } from '../core/dom.js';
import { icon } from '../ui/icons.js';
import { LineSeries, createChart } from '../vendor/lightweight-charts.standalone.production.mjs';

export const GAP_KEY = 'gap';
export const GAP_LABEL = 'Gap open 09:15 (live Algo strategy)';
// The same engine with the entry on the retest of the 09:15 open (Algo Trading runs it on paper): its own strategy entry.
export const GAP_RETEST_KEY = 'gapRetest';
export const GAP_RETEST_LABEL = 'Gap retest 09:15 (paper strategy)';
const MODES = [['best', 'Best case', 'fill at the option’s 09:15 open'], ['worst', 'Worst case', 'fill at the 09:16 open']];
/** Late entry % above the 09:15 open (live fills so far: +2.1% and +8.9%). */
const LATE = [0, 2, 3, 4, 5, 7, 9, 10, 12, 15];
/** The first result's title and subtitle: the 09:15 open, or that % above it. */
const firstMode = late => (late ? ['Late entry', `fill ${late}% above the 09:15 open`] : ['Best case', 'fill at the option’s 09:15 open']);
const modesFor = late => [['best', ...firstMode(late)], MODES[1]];
// Users (not administrators) get the same form and results, with a short description instead of the rules text
// (server: lib/access.js).
const isUser = ui => ui?.caps?.admin === false;
// Retest entries: both results fill at the 09:15 open; they differ in the fill minute's stop (close below vs any touch).
const RETEST_MODES = [['best', 'Retest, best', 'stop in the fill minute only on a close below'], ['worst', 'Retest, worst', 'stop in the fill minute on any touch']];
const modesOf = m => (m.settings.entryMode === 'retest' ? RETEST_MODES : modesFor(m.settings.lateEntryPct));

const clock = s => new Intl.DateTimeFormat('en-IN', { timeZone:'Asia/Kolkata', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).format(new Date(s * 1000));
const dayLabel = day => new Intl.DateTimeFormat('en-IN', { day:'numeric', month:'short', year:'numeric', timeZone:'UTC' }).format(new Date(`${day}T00:00:00Z`));
const monthLabel = m => new Intl.DateTimeFormat('en-IN', { month:'short', year:'numeric', timeZone:'UTC' }).format(new Date(`${m}-01T00:00:00Z`));
const stamp = s => new Intl.DateTimeFormat('en-IN', { timeZone:'Asia/Kolkata', dateStyle:'medium', timeStyle:'short' }).format(new Date(s * 1000));
/** ₹ in lakh / crore once it gets large, so year-long compounding stays readable. */
const inr = (v, sign = false) => {
  if (!Number.isFinite(v)) return '-';
  const a = Math.abs(v), s = v < 0 ? '-' : sign && v > 0 ? '+' : '';
  return a >= 1e7 ? `${s}₹${(a / 1e7).toLocaleString('en-IN', { maximumFractionDigits:2 })} Cr` : a >= 1e5 ? `${s}₹${(a / 1e5).toLocaleString('en-IN', { maximumFractionDigits:2 })} L` : `${s}₹${Math.round(a).toLocaleString('en-IN')}`;
};
const pct = v => Number.isFinite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(1)}%` : '-';
const cls = v => v > 0 ? 'pos' : v < 0 ? 'neg' : '';

/** Strike in steps from the ATM: +1…+3 ITM, −1…−3 OTM. */
export const strikeLabel = k => (!k ? 'ATM' : `${k > 0 ? 'ITM' : 'OTM'}${Math.abs(k)}`);
const STRIKES = [-3, -2, -1, 0, 1, 2, 3];

export function gapDefaults(ui, caps) {
  const d = caps?.gap?.defaults || {};
  ui.gap ??= { signal:'live', atmFrom:'open', liveSizing:true, dailySlAmount:0, capital:d.capital ?? 100000, compound:d.compound ?? true, fundsUse:d.fundsUse ?? 90, dailySlPct:d.dailySlPct ?? 20, lotCap:d.lotCap ?? 0, slippage:d.slippage ?? 1, squareOff:d.squareOff ?? '15:15', costToCostR:d.costToCostR ?? 1, exitCandle:d.exitCandle ?? '0916', strike:d.strike ?? 0, lateEntryPct:d.lateEntryPct ?? 5, minGapPts:d.minGapPts ?? 0, tradeAmount:d.tradeAmount ?? 0, entryMode:d.entryMode ?? 'open', retestMin:d.retestMin ?? 15, retestSlPct:d.retestSlPct ?? 5 };
  ui.gapView ??= 'best';
}
/** Restore the form from a saved run's settings. */
export function gapFromRun(ui, run) {
  const s = run.metrics?.settings; if (!s) return;
  ui.gap = { signal:s.signal ?? 'premium', atmFrom:s.atmFrom ?? 'dhan', liveSizing:s.liveSizing ?? false, dailySlAmount:s.dailySlAmount ?? 0, capital:s.capital, compound:s.compound, fundsUse:s.fundsUse, dailySlPct:s.dailySlPct, lotCap:s.lotCap, slippage:s.slippage, squareOff:s.squareOff, costToCostR:s.costToCostR ?? 0, exitCandle:s.exitCandle ?? '1m', strike:s.strike ?? 0, lateEntryPct:s.lateEntryPct ?? 0, minGapPts:s.minGapPts ?? 0, tradeAmount:s.tradeAmount ?? 0, entryMode:s.entryMode ?? 'open', retestMin:s.retestMin ?? 15, retestSlPct:s.retestSlPct ?? 5 };
  ui.strategy = s.entryMode === 'retest' ? GAP_RETEST_KEY : GAP_KEY;
}
export const gapPayload = (ui, retest = false) => ({ strategy:GAP_KEY, startDate:ui.startDate, endDate:ui.endDate, ...ui.gap, entryMode:retest ? 'retest' : 'open' });
/** Apply a change from a [data-gap-field] control. Returns true when handled. */
export function gapFieldChange(ui, field) {
  const key = field.dataset.gapField; if (!key) return false;
  ui.gap[key] = key === 'squareOff' || key === 'exitCandle' || key === 'signal' ? field.value : key === 'compound' ? field.value === 'compound' : Number(field.value);
  return true;
}
export function gapRunLabel(run) {
  const m = run.metrics, s = m.settings || {}, b = m.best?.summary, w = m.worst?.summary;
  const first = s.lateEntryPct ? `+${s.lateEntryPct}% entry` : 'best', second = 'worst';
  return `${s.entryMode === 'retest' ? GAP_RETEST_LABEL : GAP_LABEL} | ${run.startDate} to ${run.endDate} | ${inr(s.capital)}${s.compound ? ' compounded' : ''}, SL ${s.dailySlPct}% of capital${s.lotCap ? `, max ${s.lotCap} lots` : ''} | ${first} ${inr(b?.endCapital)} · ${second} ${inr(w?.endCapital)}`;
}

/** Settings and results of a saved run, for the saved-backtests table and the run details strip. */
export function gapRunFacts(run) {
  const m = run.metrics, s = m.settings || {};
  const bound = (label, x) => ({ label, value: `${inr(x?.net, true)} (${pct(x?.returnPct)})`, sub: `${inr(x?.startCapital)} → ${inr(x?.endCapital)}`, tone: x?.net });
  return { ...(s.entryMode === 'retest' ? { name: GAP_RETEST_LABEL } : {}), settings: [s.signal === 'live' ? 'gap: ATM premium (live)' : s.signal === 'index' ? 'gap: index' : s.signal === 'both' ? 'gap: index + ATM premium' : 'gap: ATM premium + green', ...(s.atmFrom === 'open' ? ['ATM at the index open'] : []), ...(s.liveSizing ? ['live sizing'] : []), `${inr(s.capital)} ${s.compound ? 'compounded' : 'fixed'}`, !s.compound && s.tradeAmount > 0 ? `${inr(s.tradeAmount)} per trade` : `${s.fundsUse}% per trade`, `strike ${strikeLabel(s.strike)}`, s.entryMode === 'retest' ? `entry: retest of the 09:15 open within ${s.retestMin} min, SL ${s.retestSlPct}%` : s.lateEntryPct ? `entry +${s.lateEntryPct}% late` : 'entry at the open', (s.dailySlAmount > 0 ? `SL ₹${Math.round(s.dailySlAmount).toLocaleString('en-IN')}` : `SL ${s.dailySlPct}% of capital`), s.lotCap ? `max ${s.lotCap} lots` : 'no lot cap', `₹${s.slippage} slippage`, `square-off ${s.squareOff}`, (s.exitCandle === '0916' ? 'exit: 09:16, any colour' : `exit: opposite ${s.exitCandle === '5m' ? '5' : '1'}-min candle`), ...(s.costToCostR > 0 ? [`cost to cost at ${s.costToCostR}R`] : []), ...(s.minGapPts > 0 ? [`gap ≥ ${s.minGapPts} pts`] : [])],
    trades: `${m.best?.summary.trades ?? 0} (${s.lateEntryPct ? 'late' : 'best'}) · ${m.worst?.summary.trades ?? 0} (worst)`, signals: m.signals, sessions: m.sessions,
    results: s.entryMode === 'retest' ? [bound('Retest, best', m.best?.summary), bound('Retest, worst', m.worst?.summary)] : [bound(firstMode(s.lateEntryPct)[0], m.best?.summary), bound('Worst case', m.worst?.summary)] };
}

export function gapFields(ui, retest = false) {
  const g = ui.gap, field = (label, control) => html`<label class="strategy-field"><span>${label}</span>${control}</label>`;
  return html`
    ${field('Starting capital ₹', html`<input class="input" type="number" min="1000" step="1000" data-gap-field="capital" value="${g.capital}" aria-label="Starting capital in rupees">`)}
    ${field('Sizing', html`<select class="input" data-gap-field="compound" aria-label="Position sizing"><option value="compound" ${g.compound ? 'selected' : ''}>Compound: grows with the capital</option><option value="fixed" ${g.compound ? '' : 'selected'}>Fixed: always the starting capital</option></select>`)}
    ${!g.compound ? field('Capital per trade ₹ (0 = use the %)', html`<input class="input" type="number" min="0" step="1000" data-gap-field="tradeAmount" value="${g.tradeAmount ?? 0}" aria-label="Rupees used per trade with fixed sizing; 0 to use the percent">`) : ''}
    ${field('Capital used per trade %', html`<input class="input" type="number" min="1" max="100" step="1" data-gap-field="fundsUse" value="${g.fundsUse}" aria-label="Percent of capital used per trade" ${!g.compound && g.tradeAmount > 0 ? 'disabled' : ''}>`)}
    ${field('Daily stop-loss ₹ (0 = use %)', html`<input class="input" type="number" min="0" step="1000" data-gap-field="dailySlAmount" value="${g.dailySlAmount ?? 0}" aria-label="Daily stop-loss in rupees, 0 to use the percent">`)}
    ${field('Daily stop-loss % of capital', html`<input class="input" type="number" min="0.1" max="100" step="0.5" data-gap-field="dailySlPct" value="${g.dailySlPct}" aria-label="Daily stop-loss in percent of capital">`)}
    ${field('Lot cap (0 = none)', html`<input class="input" type="number" min="0" step="1" data-gap-field="lotCap" value="${g.lotCap}" aria-label="Maximum lots per trade, 0 for no cap">`)}
    ${field('Slippage ₹ / unit (entry)', html`<input class="input" type="number" min="0" max="50" step="0.25" data-gap-field="slippage" value="${g.slippage}" aria-label="Entry slippage in rupees per unit">`)}
    ${field('Square-off (IST)', html`<input class="input" type="time" min="09:20" max="15:29" data-gap-field="squareOff" value="${g.squareOff}" aria-label="Square-off time">`)}
    ${retest ? html`${field('Retest window (minutes)', html`<input class="input" type="number" min="1" max="60" step="1" data-gap-field="retestMin" value="${g.retestMin ?? 15}" aria-label="Minutes after 09:15 to wait for the retest">`)}${field('Retest SL % below entry', html`<input class="input" type="number" min="0.5" max="50" step="0.5" data-gap-field="retestSlPct" value="${g.retestSlPct ?? 5}" aria-label="Stop-loss percent below the retest entry">`)}`
      : field('Late entry % (above 09:15 open)', html`<select class="input" data-gap-field="lateEntryPct" aria-label="How far above the option's 09:15 open the entry fills">${LATE.map(p => html`<option value="${p}" ${Number(g.lateEntryPct || 0) === p ? 'selected' : ''}>${p ? `+${p}%` : '0% (at the open)'}</option>`)}</select>`)}
    ${field('Min index gap (points, 0 = any)', html`<input class="input" type="number" min="0" max="5000" step="5" data-gap-field="minGapPts" value="${g.minGapPts ?? 0}" aria-label="Trade only when the index opens at least this many points above or below the previous close; 0 for any gap">`)}
    ${field('Gap check', html`<select class="input" data-gap-field="signal" aria-label="Gap check"><option value="live" ${g.signal === 'live' ? 'selected' : ''}>ATM premium gap up (live)</option><option value="premium" ${g.signal === 'premium' ? 'selected' : ''}>ATM premium gap up + green 09:15 candle</option><option value="index" ${g.signal === 'index' ? 'selected' : ''}>Index gap: up → CE, down → PE</option><option value="both" ${g.signal === 'both' ? 'selected' : ''}>Both: index gap and that ATM premium</option></select>`)}
    ${field('Strike', html`<select class="input" data-gap-field="strike" aria-label="Strike to trade">${STRIKES.map(k => html`<option value="${k}" ${Number(g.strike || 0) === k ? 'selected' : ''}>${strikeLabel(k)}${k === 2 ? ' (live)' : ''}</option>`)}</select>`)}
    ${field('Exit', html`<select class="input" data-gap-field="exitCandle" aria-label="Exit rule"><option value="1m" ${g.exitCandle === '1m' || !g.exitCandle ? 'selected' : ''}>Opposite 1-minute candle</option><option value="5m" ${g.exitCandle === '5m' ? 'selected' : ''}>Opposite 5-minute candle</option><option value="0916" ${g.exitCandle === '0916' ? 'selected' : ''}>At 09:16, any colour (live)</option></select>`)}
    ${field('Cost to cost at R (0 = off)', html`<input class="input" type="number" min="0" max="5" step="0.25" data-gap-field="costToCostR" value="${g.costToCostR}" aria-label="Move the stop to the entry price at this multiple of the risk; 0 for off">`)}`;
}

export function gapNotes(ui, caps, retest = false) {
  const g = ui.gap, cov = caps?.gap?.indices ? caps.gap.indices[ui.underlying || 'NIFTY'] : caps?.gap?.coverage;
  const history = html`<p class="bt-muted">${cov ? `Uses the stored 1-minute option history on this server: ${dayLabel(cov.from)} to ${dayLabel(cov.to)}. Runs in seconds and places no orders.` : `The stored option history is not available${caps?.gap?.reason ? `: ${caps.gap.reason}` : ''}.`}</p>`;
  if (retest) return html`<p class="bt-muted"><b>Gap retest 09:15 — the paper strategy.</b> The same 09:15 gap decision and ${strikeLabel(g.strike)} contract as Gap open 09:15, but no buy at 09:15: a limit buy at the option's 09:15 open, filled by the first minute from 09:16 whose low comes back to it within ${g.retestMin} minutes (no retest → no trade). Stop-loss ${g.retestSlPct}% below the entry (closer if your daily stop-loss allows less). Exit: ${g.exitCandle === '0916' ? 'the next minute’s open after the fill' : `the next minute’s open after the first opposite-colour NIFTY ${g.exitCandle === '5m' ? '5-minute' : '1-minute'} candle`}, the stop, or ${g.squareOff}. Two results for the fill minute: <b>best</b> = stopped there only if it closed below the stop, <b>worst</b> = on any touch.</p>${history}`;
  if (isUser(ui)) return html`<p class="bt-muted"><b>Gap open 09:15 — the strategy Algo Trading runs live</b>, replayed with the settings above. Two results: <b>${g.lateEntryPct ? 'late entry' : 'best case'}</b> and <b>worst case</b> (a fill one minute later); real trading lands in between. Charges as on each date.</p>${history}`;
  return html`<p class="bt-muted"><b>Gap open 09:15 — the strategy Algo Trading runs live.</b> ${g.signal === 'index' ? `Gap check on the index: when it opens above its previous close, CE is bought; below it, PE (${g.minGapPts ? `at least ${g.minGapPts} points` : 'any gap'}).` : `Each day the ATM CE and PE of the nearest ${ui.underlying === 'BANKNIFTY' ? 'monthly' : 'weekly'} expiry are checked at 09:15: ${g.signal === 'both' ? 'the side of the index gap (up → CE, down → PE) is bought only when its ATM premium also opened above its previous close and closed its first minute green.' : g.signal === 'live' ? 'as Algo Trading does, the side whose premium opened above its previous close (gap up) is bought, with no check of the 09:15 candle colour; both or neither → no trade.' : 'the side whose premium opened above its previous close (gap up) and closed its first minute green is bought; both or neither → no trade.'}${g.atmFrom === 'open' ? ' The ATM is the strike nearest the index’s 09:15 open, as live.' : ''}${g.liveSizing ? ' Size as live: also at most 98% of the capital ÷ 1.15 (the broker blocks about 15% above the price for a market buy).' : ''}${g.dailySlAmount > 0 ? ` Stop-loss: ₹${Math.round(g.dailySlAmount).toLocaleString('en-IN')} ÷ the quantity below the entry.` : ''}`} The trade uses the ${strikeLabel(g.strike)} strike of that side, fixed at 09:15 (a 09:15 open below the option's intrinsic value is a stale pre-open price: the entry uses the intrinsic value, capped at that minute's high). Size: ${g.fundsUse}% of ${g.compound ? 'the running' : 'the starting'} capital in whole lots${g.lotCap ? `, at most ${g.lotCap}` : ', no lot cap'}. Stop-loss: ${g.dailySlPct}% of capital ÷ the quantity, below the entry (your daily stop-loss, as live); hit when the option's 1-minute low reaches it. Exit: ${g.exitCandle === '0916' ? 'at the 09:16 open, whatever the colour of the 09:15 candle (worst case: one minute after its 09:16 fill, at the 09:17 open), or the stop inside that minute' : `the next minute's open after the first opposite-colour index ${g.exitCandle === '5m' ? '5-minute candle (09:15–09:19, 09:20–09:24, …; the one the entry is in counts)' : '1-minute candle'}, the stop, or ${g.squareOff}`}. Charges as on each date, ₹${g.slippage} slippage a unit on the entry.${g.costToCostR > 0 ? ` Cost to cost: after a minute whose option high reaches entry + ${g.costToCostR} × the risk, the stop is the entry price (as live).` : ''}</p>
    <p class="bt-muted"><b>Two results, because 1-minute candles cannot show the first 2 seconds.</b> Live buys at 09:15:02; the backtest gives the range it falls in: <b>${g.lateEntryPct ? `late entry` : 'best case'}</b> = filled ${g.lateEntryPct ? `${g.lateEntryPct}% above the option's 09:15 open (a market order fills during the 09:15 spike: live fills so far were 2.1% and 8.9% above it)` : "at the option's 09:15 open"} with the whole first minute's colour known; <b>worst case</b> = filled at the 09:16 open, after that minute. Real results land in between. Without a lot cap, sizes far beyond what the option trades at 09:15 are possible on paper; treat totals past about ₹1 crore as unreachable.</p>
    <p class="bt-muted">${cov ? `Uses the stored 1-minute option history on this server: ${dayLabel(cov.from)} to ${dayLabel(cov.to)}. Runs in seconds and places no orders.` : `The stored option history is not available${caps?.gap?.reason ? `: ${caps.gap.reason}` : ''}.`}</p>`;
}

// ---------- Results ----------
function boundCard(key, title, sub, r) {
  const s = r.summary;
  return html`<article class="bt-gap-bound ${key}"><header><b>${title}</b><small>${sub}</small></header>
    <div class="bt-gap-big ${cls(s.endCapital - s.startCapital)}">${inr(s.startCapital)} → ${inr(s.endCapital)} <small>(${pct(s.returnPct)})</small></div>
    <div class="bt-gap-net ${cls(s.net)}"><small>Net P&amp;L after charges</small><b>${inr(s.net, true)}</b></div>
    <dl><div><dt>Trades</dt><dd>${s.trades}</dd></div><div><dt>Won</dt><dd>${s.wins} (${s.winRate.toFixed(0)}%)</dd></div><div><dt>Stops hit</dt><dd>${s.stops}</dd></div>
      <div><dt>Max drawdown</dt><dd class="${s.maxDrawdownPct ? 'neg' : ''}">${s.maxDrawdownPct.toFixed(1)}%</dd></div><div><dt>Avg win / loss</dt><dd>${inr(s.averageWin, true)} / ${inr(s.averageLoss, true)}</dd></div>
      <div><dt>Charges</dt><dd>${inr(s.charges)}</dd></div>${s.skipped ? html`<div><dt>Signals not traded</dt><dd>${s.skipped}</dd></div>` : ''}</dl></article>`;
}
export function gapResults(ui, result) {
  const m = result.metrics, view = m[ui.gapView] ? ui.gapView : 'best', noTrade = m.days.filter(d => !d.side);
  const months = [...new Set([...m.best.months, ...m.worst.months].map(x => x.month))].sort();
  const mb = Object.fromEntries(m.best.months.map(x => [x.month, x])), mw = Object.fromEntries(m.worst.months.map(x => [x.month, x]));
  const monthCell = x => x ? html`<td>${x.trades} / ${x.wins} / ${x.stops}</td><td class="${cls(x.net)}">${inr(x.net, true)}</td><td>${inr(x.end)}</td>` : html`<td>-</td><td>-</td><td>-</td>`;
  return html`
    <div class="bt-result-head"><div><span class="eyebrow">${GAP_LABEL}</span><h3>Backtest results</h3><small>${result.oneMinuteBars.toLocaleString('en-IN')} one-minute bars | ${result.startDate} to ${result.endDate} IST | ${m.sessions} sessions, ${m.signals} signal days | SL ${m.settings.dailySlPct}% of capital | ${m.settings.lotCap ? `max ${m.settings.lotCap} lots` : 'no lot cap'} | saved ${stamp(result.createdAt / 1000)}</small></div><span class="pill sm ${m.signals ? '' : 'grey'}">${m.signals} SIGNAL${m.signals === 1 ? '' : 'S'}</span></div>
    <div class="bt-gap-bounds">${modesOf(m).map(([k, t, s]) => boundCard(k, t, s, m[k]))}</div>
    <p class="bt-muted">Live trading buys at 09:15:02, between these two. The fill price versus the option's 09:15 open decides which side it lands on.</p>
    <div class="bt-orb-actions"><button class="btn bt-chart-btn" data-gap-csv>${icon('chart')} Export trades CSV</button></div>
    ${m.best.trades.length || m.worst.trades.length ? html`<h4 class="bt-orb-title">Capital after each trade <small class="bt-muted">· green: ${modesOf(m)[0][1].toLowerCase()} · amber: ${modesOf(m)[1][1].toLowerCase()}</small></h4><div id="bt-gap-equity" class="bt-chart-host bt-orb-equity" role="img" aria-label="Capital after each trade, both results"></div>` : html`<div class="bt-empty">${icon('radar')}<b>No trades.</b><span>${isUser(ui) ? 'The strategy found no trade in this range.' : 'No day in this range had exactly one ATM premium gap up and stay green.'}</span></div>`}
    ${months.length ? html`<h4 class="bt-orb-title">Month by month</h4><div class="bt-table-wrap"><table class="bt-table"><thead><tr><th rowspan="2">Month</th><th colspan="3">${modesOf(m)[0][1]}</th><th colspan="3">${modesOf(m)[1][1]}</th></tr><tr><th>Trades / won / stops</th><th>P&amp;L</th><th>Capital</th><th>Trades / won / stops</th><th>P&amp;L</th><th>Capital</th></tr></thead><tbody>${months.map(k => html`<tr><td>${monthLabel(k)}</td>${monthCell(mb[k])}${monthCell(mw[k])}</tr>`)}</tbody></table></div>` : ''}
    ${m[view].trades.length ? html`<div class="bt-gap-tabs" role="tablist">${modesOf(m).map(([k, t]) => html`<button class="btn bt-chart-btn ${view === k ? 'active' : ''}" role="tab" aria-selected="${view === k}" data-gap-view="${k}">${t} trades (${m[k].trades.length})</button>`)}</div>${tradeTable(m[view])}` : ''}
    ${noTrade.length ? html`<details class="bt-orb-days"><summary>Days without a trade (${noTrade.length})</summary><div class="bt-table-wrap"><table class="bt-table"><thead><tr><th>Date</th><th>CE: prev → open → 09:15 close</th><th>PE: prev → open → 09:15 close</th><th>Why</th></tr></thead><tbody>${noTrade.slice().reverse().map(d => html`<tr><td>${dayLabel(d.day)}</td><td>${side(d.ce)}</td><td>${side(d.pe)}</td><td>${d.reason}</td></tr>`)}</tbody></table></div></details>` : ''}`;
}
// ≈: the previous close estimated from the nearest stored strike (the exact strike is beyond Dhan's history; see gap.js).
const prevText = x => (x.prev == null ? '-' : `${x.prevEstimated ? '≈' : ''}${x.prev}`);
const side = x => x ? `${x.strike} · ${prevText(x)} → ${x.open} → ${x.close}` : '-';
function tradeTable(r) {
  return html`<div class="bt-table-wrap"><table class="bt-table bt-orb-table"><thead><tr><th>Date</th><th>Contract</th><th>Prev → open</th><th>Entry</th><th>Lots</th><th>Stop</th><th>Exit</th><th>Exit reason</th><th>Charges</th><th>Net</th><th>Capital</th><th>Result</th></tr></thead><tbody>${r.trades.slice().reverse().map(t => html`<tr><td>${dayLabel(t.day)}</td><td><span class="bt-side ${t.side.toLowerCase()}">${t.strike} ${t.side}</span></td><td>${prevText(t)} → ${t.open}</td><td>${t.entry.toFixed(2)} at ${clock(t.entryAt)}</td><td>${t.lots.toLocaleString('en-IN')} × ${t.lotSize}</td><td>${t.stop.toFixed(2)}</td><td>${t.exit.toFixed(2)} at ${clock(t.exitAt)}</td><td>${t.exitReason}</td><td>${inr(t.charges)}</td><td class="${cls(t.net)}">${inr(t.net, true)}</td><td>${inr(t.capitalAfter)}</td><td><span class="bt-outcome ${t.net > 0 ? 'win' : 'loss'}">${t.net > 0 ? 'WIN' : 'LOSS'}</span></td></tr>`)}</tbody></table></div>`;
}

// ---------- Chart & CSV ----------
export function drawGapEquity(host, result, theme) {
  const m = result.metrics, chart = createChart(host, theme);
  for (const [k, color] of [['best', '#21d3a3'], ['worst', '#ffbf47']]) {
    const pts = []; for (const p of m[k].equityCurve || []) if (!pts.length || p.time > pts.at(-1).time) pts.push(p);
    if (pts.length) chart.addSeries(LineSeries, { color, lineWidth:2, priceLineVisible:false, lastValueVisible:true, title:k === 'best' ? (m.settings.lateEntryPct ? `+${m.settings.lateEntryPct}%` : 'Best') : 'Worst' }).setData(pts);
  }
  chart.timeScale().fitContent();
  return chart;
}
export function gapCsv(result) {
  const m = result.metrics, cell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ['case', 'date', 'side', 'strike', 'prev_close', 'open_0915', 'entry_time', 'entry', 'lots', 'lot_size', 'qty', 'stop', 'exit_time', 'exit', 'exit_reason', 'gross_inr', 'charges_inr', 'net_inr', 'capital_after'];
  const rows = MODES.flatMap(([k]) => m[k].trades.map(t => [k, t.day, t.side, t.strike, t.prev, t.open, stamp(t.entryAt), t.entry, t.lots, t.lotSize, t.qty, t.stop, stamp(t.exitAt), t.exit, t.exitReason, t.gross, t.charges, t.net, t.capitalAfter]));
  return [head, ...rows].map(r => r.map(cell).join(',')).join('\n');
}
