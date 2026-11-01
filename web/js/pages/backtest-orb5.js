// Backtest page: Nifty 5-Minute Opening Range Breakout ("Nifty 5-Min ORB"). Form fields, results,
// charts and CSV export. The simulation itself runs on the server (server/src/modules/scalper/orb5.js).
import { html } from '../core/dom.js';
import { icon } from '../ui/icons.js';
import { BaselineSeries, CandlestickSeries, LineSeries, createChart, createSeriesMarkers } from '../vendor/lightweight-charts.standalone.production.mjs';

export const ORB5_KEY = 'orb5';
export const ORB5_LABEL = 'Nifty 5-Min ORB';
const EXPIRIES = [['W1','Weekly (nearest)'],['W2','Weekly (next)'],['M1','Monthly (current)']];
const STRIKES = [[2,'2 strikes ITM'],[1,'1 strike ITM'],[0,'ATM'],[-1,'1 strike OTM'],[-2,'2 strikes OTM']];
const MAX_OPTION_DAYS = 60;

const stamp = s => new Intl.DateTimeFormat('en-IN',{ timeZone:'Asia/Kolkata', dateStyle:'medium', timeStyle:'short' }).format(new Date(s*1000));
const clock = s => new Intl.DateTimeFormat('en-IN',{ timeZone:'Asia/Kolkata', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).format(new Date(s*1000));
const dayLabel = day => new Intl.DateTimeFormat('en-IN',{ day:'numeric', month:'short', year:'numeric', timeZone:'UTC' }).format(new Date(`${day}T00:00:00Z`));
const pts = v => Number.isFinite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(2)}` : '-';
const inr = v => Number.isFinite(v) ? `${v < 0 ? '-' : v > 0 ? '+' : ''}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}` : '-';
const num = v => Number.isFinite(v) ? v.toFixed(2) : '-';
const expiryText = e => e?.date ? `${e.estimated ? '≈ ' : ''}${dayLabel(e.date)}` : '-';
const dayCount = (a,b) => (Date.parse(`${b}T00:00:00Z`)-Date.parse(`${a}T00:00:00Z`))/86_400_000+1;

export function orbDefaults(ui) {
  ui.orb ??= { mode:'directional', riskReward:2, maxEntriesPerDay:2, squareOff:'15:15', slippagePoints:0, oppositeExit:'off',
    options:{ expiry:'W1', moneyness:0, lots:1, brokeragePerOrder:20, slippagePerUnit:0.5, statutoryCharges:true } };
}
/** Restore the form from a saved run's settings. */
export function orbFromRun(ui, run) {
  const s=run.metrics?.settings; if(!s) return;
  ui.orb={ mode:s.mode, riskReward:s.riskReward, maxEntriesPerDay:s.maxEntriesPerDay, squareOff:s.squareOff, slippagePoints:s.slippagePoints||0, oppositeExit:s.oppositeExit||'off',
    options:{ ...ui.orb?.options, ...(s.options||{}) } };
}
export function orbPayload(ui) {
  const o=ui.orb; return { strategy:ORB5_KEY, startDate:ui.startDate, endDate:ui.endDate, horizon:10, mode:o.mode, riskReward:o.riskReward,
    maxEntriesPerDay:o.maxEntriesPerDay, squareOff:o.squareOff, slippagePoints:o.slippagePoints, oppositeExit:o.oppositeExit||'off', options:o.mode==='options'?o.options:undefined };
}
/** Apply a change from a [data-orb-field] control. Returns true when handled. */
export function orbFieldChange(ui, field) {
  const key=field.dataset.orbField; if(!key) return false;
  const value=field.type==='checkbox'?field.checked:field.value;
  if(key.startsWith('options.')) ui.orb.options[key.slice(8)]=['expiry'].includes(key.slice(8))||field.type==='checkbox'?value:Number(value);
  else ui.orb[key]=['mode','squareOff','oppositeExit'].includes(key)?value:Number(value);
  return true;
}
export function orbRunLabel(run) {
  const m=run.metrics, s=m.settings||{};
  const result=m.optionSummary?`${inr(m.optionSummary.net)} net (options, ${s.options?.lots||1} lot${s.options?.lots>1?'s':''})`:`${pts(m.summary.net)} pts`;
  return `${ORB5_LABEL} | ${run.startDate} to ${run.endDate} | ${s.mode==='options'?'Actual options':'Directional'} | ${s.riskReward}R, ${s.maxEntriesPerDay}/day, square-off ${s.squareOff}${s.oppositeExit&&s.oppositeExit!=='off'?`, opposite ${s.oppositeExit} candle exit`:''} | ${result}`;
}

export function orbFields(ui, caps) {
  const o=ui.orb, optionsOk=caps?.optionsData?.available;
  const field=(label,control)=>html`<label class="strategy-field"><span>${label}</span>${control}</label>`;
  return html`
    ${field('Backtest mode',html`<select class="input" data-orb-field="mode" aria-label="Backtest mode"><option value="directional" ${o.mode==='directional'?'selected':''}>Underlying directional (points)</option><option value="options" ${o.mode==='options'?'selected':''} ${optionsOk?'':'disabled'}>Actual options (₹)${optionsOk?'':' - unavailable'}</option></select>`)}
    ${field('Risk : reward',html`<input class="input" type="number" min="0.5" max="10" step="0.5" data-orb-field="riskReward" value="${o.riskReward}" aria-label="Risk to reward ratio">`)}
    ${field('Max entries / day',html`<input class="input" type="number" min="1" max="10" step="1" data-orb-field="maxEntriesPerDay" value="${o.maxEntriesPerDay}" aria-label="Maximum entries per day">`)}
    ${field('Square-off (IST)',html`<input class="input" type="time" min="09:21" max="15:29" data-orb-field="squareOff" value="${o.squareOff}" aria-label="Square-off time">`)}
    ${field('Exit on opposite candle',html`<select class="input" data-orb-field="oppositeExit" aria-label="Exit on the first opposite-colour candle"><option value="off" ${(o.oppositeExit||'off')==='off'?'selected':''}>Off</option><option value="1m" ${o.oppositeExit==='1m'?'selected':''}>Opposite 1-minute candle</option><option value="5m" ${o.oppositeExit==='5m'?'selected':''}>Opposite 5-minute candle</option></select>`)}
    ${o.mode==='directional'?field('Slippage (points / side)',html`<input class="input" type="number" min="0" max="20" step="0.25" data-orb-field="slippagePoints" value="${o.slippagePoints}" aria-label="Slippage in index points per side">`):html`
    ${field('Expiry',html`<select class="input" data-orb-field="options.expiry" aria-label="Option expiry">${EXPIRIES.map(([v,l])=>html`<option value="${v}" ${o.options.expiry===v?'selected':''}>${l}</option>`)}</select>`)}
    ${field('Strike',html`<select class="input" data-orb-field="options.moneyness" aria-label="Strike selection">${STRIKES.map(([v,l])=>html`<option value="${v}" ${o.options.moneyness===v?'selected':''}>${l}</option>`)}</select>`)}
    ${field('Lots',html`<input class="input" type="number" min="1" max="100" step="1" data-orb-field="options.lots" value="${o.options.lots}" aria-label="Number of lots">`)}
    ${field('Brokerage ₹ / order',html`<input class="input" type="number" min="0" max="500" step="1" data-orb-field="options.brokeragePerOrder" value="${o.options.brokeragePerOrder}" aria-label="Brokerage per order in rupees">`)}
    ${field('Slippage ₹ / unit / side',html`<input class="input" type="number" min="0" max="50" step="0.05" data-orb-field="options.slippagePerUnit" value="${o.options.slippagePerUnit}" aria-label="Option slippage per unit per side">`)}
    <label class="strategy-field bt-check"><span>Statutory charges</span><span><input type="checkbox" data-orb-field="options.statutoryCharges" ${o.options.statutoryCharges?'checked':''}> STT, exchange, SEBI, stamp, GST</span></label>`}`;
}

/** Weekly expiries read stored option history (any length from its first day); otherwise Dhan, up to MAX_OPTION_DAYS. */
function optionRangeNote(ui, caps) {
  const cov=caps?.gap?.coverage, weekly=ui.orb.options.expiry!=='M1', local=weekly&&cov&&ui.startDate>=cov.from;
  if(local) return html`Weekly option prices come from the stored history (${dayLabel(cov.from)} – ${dayLabel(cov.to)}; later days from Dhan): any length.`;
  const over=dayCount(ui.startDate,ui.endDate)>MAX_OPTION_DAYS;
  return html`Option prices come from Dhan here: up to ${MAX_OPTION_DAYS} days per run${weekly&&cov?` (weekly expiries from ${dayLabel(cov.from)} have no limit)`:''}.${over?html` <b>Choose ${MAX_OPTION_DAYS} days or fewer${weekly&&cov?`, or start on or after ${dayLabel(cov.from)}`:''}.</b>`:''}`;
}
export function orbNotes(ui, caps) {
  const o=ui.orb, optionsOk=caps?.optionsData?.available;
  return html`<p class="bt-muted"><b>Nifty 5-Min ORB.</b> The opening range is the highest high and lowest low (wicks included) of the 09:15-09:19 one-minute NIFTY spot candles, frozen at 09:20 and rebuilt every day; days missing any of those candles are skipped and reported. A CE signal is a completed candle closing above the range high after a close at or below it (PE: below the low after a close at or above it); wick-only breaks and closes inside the range do nothing. Orders fill at the next candle's open, one position at a time, at most ${o.maxEntriesPerDay} entr${o.maxEntriesPerDay===1?'y':'ies'} a day and none at or after ${o.squareOff}. Stop: the signal candle's low (CE) or high (PE), frozen at entry; an entry already beyond its stop is skipped. Target: ${o.riskReward} × the actual entry-to-stop distance. Exits: stop or target (a gap fills at the open; both inside one candle counts as the stop and is flagged ambiguous), the next open after a close back inside the range${o.oppositeExit&&o.oppositeExit!=='off'?`, the next open after the first opposite-colour ${o.oppositeExit==='5m'?'5-minute candle (09:15–09:19, 09:20–09:24, …; the one the entry is in counts)':'1-minute candle (the entry candle counts)'} — red for CE, green for PE`:''}, or square-off at ${o.squareOff}.</p>
    ${o.mode==='directional'?html`<p class="bt-muted"><b>Underlying directional backtest - not options P&amp;L.</b> CE signals are booked as long NIFTY and PE signals as short NIFTY, in index points and R multiples (R = result ÷ entry-to-stop risk).</p>`
      :html`<p class="bt-muted"><b>Actual options.</b> Every trade buys the selected ${STRIKES.find(([v])=>v===o.options.moneyness)?.[1]||'ATM'} CE (CE signal) or PE (PE signal) of the ${EXPIRIES.find(([v])=>v===o.options.expiry)?.[1].toLowerCase()} expiry, chosen from Dhan's ATM at the signal candle and held to the exit. Entries, stops, targets and exits trigger on NIFTY; execution uses that contract's historical premiums (the open for open-time fills, otherwise the trigger minute's close). Lot size follows NSE's revisions; charges use the rates in force on each date (STT 0.1% / exchange 0.03503% from 1 Oct 2024, earlier 0.0625% / 0.0503%). ${optionRangeNote(ui,caps)}</p>`}
    ${optionsOk?'':html`<p class="bt-muted">Actual-options mode is unavailable: ${caps?.optionsData?.reason||'historical option data could not be checked'}.</p>`}`;
}

// ---------- Results ----------
function metricTiles(items) {
  return html`<div class="bt-metrics">${items.map(([label,value,cls=''])=>html`<article><small>${label}</small><b class="${cls}">${value}</b></article>`)}</div>`;
}
export function orbResults(ui, result) {
  const m=result.metrics, options=m.mode==='options', s=options?m.optionSummary:m.summary, d=m.directionalSummary||m.summary;
  const unit=v=>options?inr(v):pts(v), cls=v=>v>0?'pos':v<0?'neg':'';
  const filled=m.trades.filter(t=>!t.option?.skipped);
  return html`
    <div class="bt-result-head"><div><span class="eyebrow">${ORB5_LABEL} · ${options?'actual options':'underlying directional'}</span><h3>Backtest results</h3><small>${result.oneMinuteBars.toLocaleString('en-IN')} one-minute bars | ${result.startDate} to ${result.endDate} IST | ${m.settings.riskReward}R target | max ${m.settings.maxEntriesPerDay}/day | square-off ${m.settings.squareOff} | saved ${stamp(result.createdAt/1000)}</small></div><span class="pill sm ${filled.length?'':'grey'}">${filled.length} TRADE${filled.length===1?'':'S'}</span></div>
    ${options?'':html`<p class="bt-banner-note">Underlying directional backtest: CE = long NIFTY, PE = short NIFTY. These are index points, not option profits.</p>`}
    ${metricTiles([
      ['Total trades', String(s.trades)],
      ['Win rate', s.trades?`${s.winRate.toFixed(1)}%`:'-'],
      [options?'Net P&L (after costs)':'Net points', s.trades?unit(s.net):'-', cls(s.net)],
      ['Average win / loss', s.trades?html`${unit(s.averageWin)} / ${unit(s.averageLoss)}`:'-'],
      ['Expectancy / trade', s.trades?unit(s.expectancy):'-', cls(s.expectancy)],
      ['Profit factor', s.profitFactor==null?'∞':s.trades?s.profitFactor.toFixed(2):'-'],
      [options?'Max drawdown':'Max drawdown (pts)', s.trades?(options?`₹${Math.round(s.maxDrawdown).toLocaleString('en-IN')}`:s.maxDrawdown.toFixed(2)):'-', s.maxDrawdown?'neg':''],
      options?['Charges paid', `₹${Math.round(s.charges).toLocaleString('en-IN')}`]:['Net R / avg R', d.trades?`${pts(d.netR)}R / ${pts(d.averageR)}R`:'-', cls(d.netR)],
    ])}
    <p class="bt-muted">Sessions ${d.sessions} | skipped days ${d.skippedDays} (incomplete 09:15-09:19 data) | ambiguous trades ${d.ambiguous} (stop and target in one candle, stop assumed) | signals not executed ${d.skippedSignals}${options?` | trades without option prices ${s.unavailable} | gross ${inr(s.grossPnl)}`:''}</p>
    <div class="bt-orb-actions"><button class="btn bt-chart-btn" data-orb-csv>${icon('chart')} Export trades CSV</button></div>
    ${filled.length?html`<h4 class="bt-orb-title">Equity curve</h4><div id="bt-orb-equity" class="bt-chart-host bt-orb-equity" role="img" aria-label="Cumulative result after each trade"></div>`:html`<div class="bt-empty">${icon('radar')}<b>No completed trades.</b><span>${d.sessions?'No completed candle closed through the opening range on these dates, or every signal was skipped.':'No sessions with NIFTY candles were found for these dates.'}</span></div>`}
    ${dailyTable(m, options)}
    ${filled.length?tradeTable(m, ui, options):''}
    ${ui.chartLoading!=null?html`<div class="bt-chart-loading">Loading the saved trade chart...</div>`:''}
    ${ui.chartData?tradeChart(ui.chartData, options):''}`;
}
function dailyTable(m, options) {
  const days=m.days||[]; if(!days.length) return '';
  return html`<details class="bt-orb-days"><summary>Daily results (${days.length} sessions)</summary><div class="bt-table-wrap"><table class="bt-table"><thead><tr><th>Date</th><th>Opening high</th><th>Opening low</th><th>Trades</th><th>${options?'Net ₹':'Net points'}</th><th>Status</th></tr></thead><tbody>${days.slice().reverse().map(d=>html`<tr class="${d.skipped?'bt-skipped':''}"><td>${dayLabel(d.day)}</td><td>${num(d.rangeHigh)}</td><td>${num(d.rangeLow)}</td><td>${d.skipped?'-':d.trades}</td><td class="${(options?d.pnl:d.net)>0?'pos':(options?d.pnl:d.net)<0?'neg':''}">${d.skipped?'-':options?inr(d.pnl):pts(d.net)}</td><td>${d.skipped?`Skipped: ${d.skipped}`:d.trades?'Traded':'No signal'}</td></tr>`)}</tbody></table></div></details>`;
}
function tradeTable(m, ui, options) {
  const rows=m.trades.map((t,index)=>({t,index})).reverse();
  const chartBtn=index=>html`<td><button class="btn bt-chart-btn" data-bt-chart-index="${index}" ${ui.chartLoading!=null?'disabled':''}>View chart</button></td>`;
  return html`<div class="bt-table-wrap"><table class="bt-table bt-orb-table"><thead><tr><th>Date</th><th>Direction</th>${options?html`<th>Contract</th><th>Lots</th>`:''}<th>Signal</th><th>Executed</th><th>Entry</th><th>Stop</th><th>Target</th><th>Exit</th><th>Exit time</th><th>Exit reason</th>${options?html`<th>Option entry → exit ₹</th><th>Costs ₹</th><th>Net ₹</th>`:html`<th>Costs (pts)</th><th>Points</th><th>R</th>`}<th>Result</th><th>Chart</th></tr></thead><tbody>${rows.map(({t,index})=>{
    const o=t.option;
    if(options&&o?.skipped) return html`<tr class="bt-skipped"><td>${dayLabel(t.day)}</td><td><span class="bt-side ${t.direction.toLowerCase()}">${t.direction} BUY</span></td><td>${expiryText(o.expiry)}</td><td>-</td><td>${clock(t.signalAt)}</td><td>${clock(t.entryAt)}</td><td colspan="9">Not priced: ${o.skipped}</td><td>-</td>${chartBtn(index)}</tr>`;
    const result=options?o.result:t.result;
    return html`<tr><td>${dayLabel(t.day)}</td><td><span class="bt-side ${t.direction.toLowerCase()}">${t.direction} ${options?'BUY':t.direction==='CE'?'· long':'· short'}</span></td>${options?html`<td>${o.strike} ${o.type} · ${expiryText(o.expiry)}</td><td>${o.lots} × ${o.lotSize}</td>`:''}<td>${clock(t.signalAt)}</td><td>${clock(t.entryAt)}</td><td>${num(t.entry)}</td><td>${num(t.stop)}</td><td>${num(t.target)}</td><td>${num(t.exit)}</td><td>${clock(t.exitAt)}</td><td>${t.exitReason}${t.ambiguous?html` <span class="pill sm amber" title="Stop and target were both inside this candle; stop assumed">ambiguous</span>`:''}</td>${options?html`<td>${o.entry.toFixed(2)} → ${o.exit.toFixed(2)}</td><td>${o.charges.total.toFixed(2)}</td><td class="${o.pnl>=0?'pos':'neg'}">${inr(o.pnl)}</td>`:html`<td>${(2*(m.settings.slippagePoints||0)).toFixed(2)}</td><td class="${t.points>=0?'pos':'neg'}">${pts(t.points)}</td><td class="${t.r>=0?'pos':'neg'}">${pts(t.r)}</td>`}<td><span class="bt-outcome ${result.toLowerCase()}">${result}</span></td>${chartBtn(index)}</tr>`;
  })}</tbody></table></div>`;
}
function tradeChart(data, options) {
  const t=data.trade,o=t.option;
  return html`<section class="bt-trade-chart"><div class="bt-chart-head"><div><h4>${dayLabel(data.day)} · ${t.direction} ${options?'BUY':t.direction==='CE'?'long':'short'}</h4><small>Opening range ${num(t.rangeHigh)} / ${num(t.rangeLow)} · shaded band = no-trade zone</small></div><button class="btn bt-chart-btn" data-bt-close-chart>Close chart</button></div>
    <div class="bt-chart-prices"><span>Signal <b>${clock(t.signalAt)}</b></span><span>Entry <b>${num(t.entry)}</b> at ${clock(t.entryAt)}</span><span>Stop <b>${num(t.stop)}</b></span><span>Target <b>${num(t.target)}</b></span><span>Exit <b>${num(t.exit)}</b> at ${clock(t.exitAt)} · ${t.exitReason}</span>${options?'':html`<span class="${t.points>=0?'pos':'neg'}">${pts(t.points)} pts (${pts(t.r)}R)</span>`}</div>
    ${options&&o&&!o.skipped?html`<div class="bt-chart-prices"><span>Option <b>${o.strike} ${o.type}</b> · expiry ${expiryText(o.expiry)} · ${o.lots} × ${o.lotSize}</span><span>Buy ₹<b>${o.entry.toFixed(2)}</b></span><span>Sell ₹<b>${o.exit.toFixed(2)}</b> (${o.exitPriceFrom})</span><span>Charges ₹<b>${o.charges.total.toFixed(2)}</b></span><span class="${o.pnl>=0?'pos':'neg'}">${inr(o.pnl)}</span></div>`:''}
    <div id="bt-trade-chart" class="bt-chart-host" role="img" aria-label="NIFTY one-minute candles with the opening range, entry and exit"></div>
    ${options&&o&&!o.skipped&&data.optionCandles?.length?html`<h5 class="bt-chart-sub">NIFTY ${o.strike} ${o.type} · expiry ${expiryText(o.expiry)} · option premium (1 min)</h5><div id="bt-option-chart" class="bt-chart-host bt-option-chart" role="img" aria-label="Option premium candles with buy and sell"></div>`:''}
  </section>`;
}

// ---------- Charts ----------
export function drawOrbEquity(host, result, theme) {
  const m=result.metrics, curve=[];
  for(const point of m.equityCurve||[]) { if(curve.at(-1)?.time===point.time) curve[curve.length-1]=point; else if(!curve.length||point.time>curve.at(-1).time) curve.push(point); }
  if(!curve.length) return null;
  const chart=createChart(host,theme);
  chart.addSeries(LineSeries,{color:'#21d3a3',lineWidth:2,priceLineVisible:false,lastValueVisible:true,title:m.mode==='options'?'₹':'pts'}).setData(curve);
  chart.timeScale().fitContent();
  return chart;
}
export function drawOrbTradeChart(host, data, theme, candleStyle) {
  const t=data.trade, chart=createChart(host,theme), candles=data.candles||[];
  // Shaded no-trade zone between the frozen opening high and low, from 09:20.
  const fromFreeze=candles.filter(c=>new Date(c.time*1000+19_800_000).toISOString().slice(11,16)>='09:20');
  if(fromFreeze.length&&Number.isFinite(t.rangeHigh)&&Number.isFinite(t.rangeLow))
    chart.addSeries(BaselineSeries,{baseValue:{type:'price',price:t.rangeLow},topLineColor:'rgba(0,0,0,0)',topFillColor1:'rgba(255,191,71,.14)',topFillColor2:'rgba(255,191,71,.14)',
      bottomLineColor:'rgba(0,0,0,0)',bottomFillColor1:'rgba(0,0,0,0)',bottomFillColor2:'rgba(0,0,0,0)',lineWidth:1,priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:false})
      .setData(fromFreeze.map(c=>({time:c.time,value:t.rangeHigh})));
  const series=chart.addSeries(CandlestickSeries,candleStyle);
  series.setData(candles);
  const times=new Set(candles.map(c=>c.time)), ce=t.direction==='CE';
  createSeriesMarkers(series,[
    {time:t.signalAt,position:ce?'aboveBar':'belowBar',color:'#ffbf47',shape:'square',text:'SIGNAL',size:1},
    {time:t.entryAt,position:ce?'belowBar':'aboveBar',color:'#21d3a3',shape:ce?'arrowUp':'arrowDown',text:`ENTRY ${num(t.entry)}`,size:2},
    {time:t.exitAt,position:ce?'aboveBar':'belowBar',color:/Stop/.test(t.exitReason)?'#ff536f':/Target/.test(t.exitReason)?'#21d3a3':'#5da9ff',shape:'circle',text:`${t.exitReason.toUpperCase()} ${num(t.exit)}`,size:2},
  ].filter(x=>times.has(x.time)).sort((a,b)=>a.time-b.time));
  const line=(price,color,title,style=2)=>Number.isFinite(price)&&series.createPriceLine({price,color,lineWidth:style===0?2:1,lineStyle:style,axisLabelVisible:true,title});
  line(t.rangeHigh,'#ffbf47','OR HIGH',0); line(t.rangeLow,'#a98cff','OR LOW',0);
  line(t.entry,'#21d3a3','ENTRY'); line(t.stop,'#ff536f','STOP'); line(t.target,'#5da9ff','TARGET');
  chart.timeScale().fitContent();
  return chart;
}

// ---------- CSV ----------
export function orbCsv(result) {
  const m=result.metrics, options=m.mode==='options';
  const head=['date','direction','signal_time','execution_time','entry','stop','target','exit','exit_time','exit_reason','ambiguous',
    ...(options?['contract','expiry','lots','lot_size','option_entry','option_exit','gross_inr','charges_inr','net_inr']:['slippage_points','points','r']),'result'];
  const cell=v=>{ const s=v==null?'':String(v); return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s; };
  const rows=m.trades.map(t=>{ const o=t.option||{};
    return [t.day,t.direction,stamp(t.signalAt),stamp(t.entryAt),t.entry,t.stop,t.target,t.exit,stamp(t.exitAt),t.exitReason,t.ambiguous?'yes':'no',
      ...(options?[o.skipped?`not priced: ${o.skipped}`:`${o.strike} ${o.type}`,o.expiry?.date,o.lots,o.lotSize,o.entry,o.exit,o.gross,o.charges?.total,o.pnl]
        :[2*(m.settings.slippagePoints||0),t.points,t.r]),options?o.result||'':t.result]; });
  return [head,...rows].map(r=>r.map(cell).join(',')).join('\n');
}
export function downloadCsv(name, text) {
  const url=URL.createObjectURL(new Blob([text],{type:'text/csv;charset=utf-8'}));
  const a=Object.assign(document.createElement('a'),{href:url,download:name});
  document.body.append(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
