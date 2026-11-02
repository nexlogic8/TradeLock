import { html, $, on } from '../core/dom.js';
import { get, post } from '../core/api.js';
import { icon } from '../ui/icons.js';
import { createChart, CandlestickSeries, LineSeries, createSeriesMarkers } from '../vendor/lightweight-charts.standalone.production.mjs';
import { LEVEL_REJECT } from './scalper-chart-signals.js';
import { GAP_KEY, GAP_LABEL, drawGapEquity, gapCsv, gapDefaults, gapFieldChange, gapFields, gapFromRun, gapNotes, gapPayload, gapResults, gapRunFacts, gapRunLabel } from './backtest-gap.js';
import { EMA915_KEY, EMA915_LABEL, drawEma915Equity, ema915Csv, ema915Defaults, ema915FieldChange, ema915Fields, ema915FromRun, ema915Notes, ema915Payload, ema915Results, ema915RunFacts, ema915RunLabel } from './backtest-ema915.js';
import { CUSTOM_KEY, CUSTOM_LABEL, customCsv, customDefaults, customFieldChange, customFields, customFromRun, customNotes, customPayload, customResults, customRunFacts, customRunLabel, drawCustomEquity } from './backtest-custom.js';
import { ORB5_KEY, ORB5_LABEL, downloadCsv, drawOrbEquity, drawOrbTradeChart, orbCsv, orbDefaults, orbFieldChange, orbFields, orbFromRun, orbNotes, orbPayload, orbResults, orbRunLabel } from './backtest-orb5.js';
const IST_TIME = new Intl.DateTimeFormat('en-IN', { timeZone:'Asia/Kolkata', hour:'2-digit', minute:'2-digit', hourCycle:'h23' });
const IST_DATE = new Intl.DateTimeFormat('en-IN', { timeZone:'Asia/Kolkata', day:'numeric', month:'short' });

const strategies = [
  ['openingRange', 'First 5-minute opening-range breakout'],
  ['previousDay', 'Previous day high/low breakout'],
  ['ema45', 'EMA45 hammer + next-candle breakout'],
  [ORB5_KEY, ORB5_LABEL],
  [GAP_KEY, GAP_LABEL],
  [EMA915_KEY, EMA915_LABEL],
  [CUSTOM_KEY, CUSTOM_LABEL],
];
const horizons = [[5,'5 minutes'],[10,'10 minutes'],[15,'15 minutes'],[30,'30 minutes']];
const exitRules = [['horizon','Fixed time'],['emaZone','EMA45/EMA105 zone'],['swingSL','Previous swing low/high stop'],['levelReject','Level rejection (3 touches)']];
const stopRules = [['none','No stop loss'],['breakoutCandle','Beyond 1m breakout candle']];
const stopRuleLabel = stopLogic => stopLogic==='breakoutCandle'?'SL beyond 1m breakout candle':'No SL';
const stamp = value => new Intl.DateTimeFormat('en-IN',{ timeZone:'Asia/Kolkata', dateStyle:'medium', timeStyle:'short' }).format(new Date(value*1000));
const chartStamp = value => new Intl.DateTimeFormat('en-IN',{ timeZone:'Asia/Kolkata', dateStyle:'medium' }).format(new Date(value));
const signed = value => `${value > 0 ? '+' : ''}${Number(value).toFixed(2)}`;
const exitRuleLabel = (exitLogic,horizon) => exitLogic==='emaZone'?'EMA45/EMA105 zone':exitLogic==='swingSL'?'Previous swing low/high stop':exitLogic==='levelReject'?'Level rejection (3 touches)':`${horizon}m close`;
const rangeMonths = {'1m':1,'2m':2,'6m':6,'1y':12,'5y':60};
const todayIst = () => { const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{ timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit' }).formatToParts(new Date()).map(x=>[x.type,x.value])); return `${p.year}-${p.month}-${p.day}`; };
function shiftMonths(day, months) {
  const date=new Date(`${day}T00:00:00Z`), wanted=date.getUTCDate();
  date.setUTCDate(1);date.setUTCMonth(date.getUTCMonth()+months);
  const last=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate();
  date.setUTCDate(Math.min(wanted,last));
  return date.toISOString().slice(0,10);
}
const earliestIntradayDate = () => shiftMonths(todayIst(),-60);
const quickRangeStart = (day,range) => { const date=shiftMonths(day,-rangeMonths[range]);return date<earliestIntradayDate()?earliestIntradayDate():date; };
const rupee = value => `${value < 0 ? '-' : value > 0 ? '+' : ''}₹${Math.abs(Math.round(value)).toLocaleString('en-IN')}`;
const OPTION_MAX_DAYS = 92;
const money = value => `₹${Math.round(value).toLocaleString('en-IN')}`;
const sizingLabel = sizing => sizing==='fixed'?'fixed capital per trade':'compounding, 100% of running capital';
const dayCount = (start,end) => (Date.parse(`${end}T00:00:00Z`)-Date.parse(`${start}T00:00:00Z`))/86_400_000+1;
// Option mode: each index trade replayed on the ATM option of the 2nd weekly expiry, sized in whole lots.
function optionTable(metrics, ui) {
  return html`<div class="bt-table-wrap"><table class="bt-table"><thead><tr><th>Entry time (IST)</th><th>Option</th><th>Expiry</th><th>Lots</th><th>Entry ₹</th><th>SL ₹</th><th>Exit ₹</th><th>Exit time</th><th>Exit rule</th><th>Premium</th><th>Index pts</th><th>P&amp;L ₹</th><th>Capital ₹</th><th>Result</th><th>Chart</th></tr></thead><tbody>${metrics.trades.slice().reverse().map((trade,displayIndex)=>{
    const o=trade.option||{}, index=metrics.trades.length-1-displayIndex;
    const chart=html`<td><button class="btn bt-chart-btn" data-bt-chart-index="${index}" ${ui.chartLoading!=null?'disabled':''}>View chart</button></td>`;
    if(o.skipped) return html`<tr class="bt-skipped"><td>${stamp(trade.entryAt||trade.time)}</td><td>${o.strike?`${o.strike} ${trade.direction}`:trade.direction}</td><td>${optionExpiryText(o.expiry)}</td><td colspan="9">Skipped: ${o.skipped}</td><td>${Number.isFinite(o.capitalAfter)?money(o.capitalAfter):'-'}</td>${chart}</tr>`;
    return html`<tr><td>${stamp(trade.entryAt||trade.time)}</td><td><span class="bt-side ${trade.direction.toLowerCase()}">${o.strike} ${trade.direction}</span></td><td>${optionExpiryText(o.expiry)}</td><td>${o.lots} × ${o.lotSize}</td><td>${o.entry.toFixed(2)}</td><td>${Number.isFinite(o.sl)?o.sl.toFixed(2):'-'}</td><td>${o.exit.toFixed(2)}</td><td>${stamp(o.exitAt)}</td><td>${o.exitReason}</td><td class="${o.premiumPoints>=0?'pos':'neg'}">${signed(o.premiumPoints)}${Number.isFinite(o.returnPct)?html` <small>(${o.returnPct>=0?'+':''}${o.returnPct.toFixed(1)}%)</small>`:''}</td><td class="${(trade.points??0)>=0?'pos':'neg'}">${Number.isFinite(trade.points)?signed(trade.points):'-'}</td><td class="${o.pnl>=0?'pos':'neg'}">${rupee(o.pnl)}</td><td>${Number.isFinite(o.capitalAfter)?money(o.capitalAfter):'-'}</td><td><span class="bt-outcome ${o.result.toLowerCase()}">${o.result}</span></td>${chart}</tr>`;
  })}</tbody></table></div>`;
}
function runLabel(run) {
  if(run.strategy===ORB5_KEY) return orbRunLabel(run);
  if(run.strategy===GAP_KEY) return gapRunLabel(run);
  if(run.strategy===EMA915_KEY) return ema915RunLabel(run);
  if(run.strategy===CUSTOM_KEY) return customRunLabel(run);
  const name=strategies.find(([key])=>key===run.strategy)?.[1]||run.strategy;
  const exit=exitRuleLabel(run.exitLogic,run.horizon);
  const sl=run.stopLogic&&run.stopLogic!=='none'?` | ${stopRuleLabel(run.stopLogic)}`:'';
  const result=run.metrics.option?`${rupee(run.metrics.option.totalPnl)} on ₹${run.metrics.option.capital.toLocaleString('en-IN')}${run.metrics.option.sizing==='compound'?' compounded':''} (ATM option)`:`${signed(run.metrics.totalPoints)} pts`;
  return `${name} | ${run.startDate} to ${run.endDate} | Exit ${exit}${sl} | ${result}`;
}
/** What a saved run used and what it made: strategy, settings, trades and the headline result(s). */
function runFacts(run) {
  const m=run.metrics, name=strategies.find(([key])=>key===run.strategy)?.[1]||run.strategy;
  if(run.strategy===GAP_KEY) return { name, ...gapRunFacts(run) };
  if(run.strategy===EMA915_KEY) return { ...ema915RunFacts(run), name };
  if(run.strategy===CUSTOM_KEY) return customRunFacts(run);
  if(run.strategy===ORB5_KEY) {
    const st=m.settings||{}, o=m.optionSummary, sum=o||m.summary;
    return { name, settings:[st.mode==='options'?`Actual options · ${st.options?.lots||1} lot${st.options?.lots>1?'s':''}`:'Index points', `${st.riskReward}R target`, `${st.maxEntriesPerDay}/day`, `square-off ${st.squareOff}`, ...(st.oppositeExit && st.oppositeExit !== 'off' ? [`exit: opposite ${st.oppositeExit === '5m' ? '5' : '1'}-min candle`] : [])],
      trades:String(sum?.trades??m.trades.length), results:[o?{ label:'Net P&L', value:rupee(o.net), tone:o.net }:{ label:'Net points', value:signed(m.summary.net), tone:m.summary.net }] };
  }
  const o=m.option, sl=run.stopLogic&&run.stopLogic!=='none'?[stopRuleLabel(run.stopLogic)]:[];
  return { name, settings:[`Exit: ${exitRuleLabel(run.exitLogic,run.horizon)}`, ...sl, ...(o?[`ATM option · ${money(o.capital)}${o.sizing==='compound'?' compounded':''}`]:['Index points'])],
    trades:String(m.trades.length), results:[o?{ label:'Net P&L', value:rupee(o.totalPnl), sub:Number.isFinite(o.endCapital)?`${money(o.capital)} → ${money(o.endCapital)}`:'', tone:o.totalPnl }:{ label:'Net points', value:signed(m.totalPoints), tone:m.totalPoints }] };
}
// Built-in crossovers (EMA 5/9, EMA 3/5) from the server, offered in the Strategy list too.
const builtIns = ui => (ui.caps?.custom?.strategies||[]).filter(x=>x.builtIn);
const builtInPicked = ui => builtIns(ui).some(x=>x.id===ui.custom?.strategyId);
const tone = v => v>0?'pos':v<0?'neg':'';
const period = run => { const n=(Date.parse(`${run.endDate}T00:00:00Z`)-Date.parse(`${run.startDate}T00:00:00Z`))/86_400_000+1; return html`${run.startDate} → ${run.endDate} <small>(${n} day${n===1?'':'s'})</small>`; };
/** Header strip on every result: what was tested, when, with which settings, and the P&L. */
function runStrip(run) {
  const x=runFacts(run);
  return html`<div class="bt-run-strip"><div class="bt-run-main"><span class="eyebrow">Saved backtest #${run.id}</span><b>${x.name}</b><span class="bt-run-period">${period(run)}</span><small>Saved ${stamp(run.createdAt/1000)} · trades ${x.trades}</small></div>
    <div class="bt-run-results">${x.results.map(r=>html`<div class="bt-run-pnl ${tone(r.tone)}"><small>${r.label}</small><b>${r.value}</b>${r.sub?html`<small>${r.sub}</small>`:''}</div>`)}</div>
    <div class="bt-run-chips">${x.settings.map(c=>html`<span class="pill sm">${c}</span>`)}</div></div>`;
}
/** Saved runs as compact cards in the side column: strategy, period, result, settings; clicking a card shows the run. */
function savedSide(ui) {
  return html`<aside class="bt-saved-side" aria-label="Saved backtests"><div class="bt-saved-head"><b>Saved backtests</b><small>${ui.savedRuns.length} saved to your account</small></div>${ui.savedRuns.map(run=>{
    const x=runFacts(run), on=ui.result?.id===run.id, settings=x.settings.join(' · ');
    return html`<article class="bt-saved-card ${on?'on':''}" role="button" tabindex="0" aria-pressed="${on}" aria-label="Show saved backtest #${run.id}: ${x.name}" data-bt-open-run="${run.id}"><header><b>${x.name}</b><small>#${run.id} · ${stamp(run.createdAt/1000)}</small></header><div class="bt-saved-period">${period(run)}</div>${x.results.map(r=>html`<div class="bt-saved-pnl ${tone(r.tone)}"><small>${r.label}</small><b>${r.value}</b></div>`)}<p class="bt-saved-settings" title="${settings}">${settings}</p></article>`;
  })}</aside>`;
}
function clearTradeChart(ui) { ui.chartView?.remove();ui.optionChartView?.remove();ui.chartView=null;ui.optionChartView=null;ui.chartHost=null; }
const optionExpiryText = expiry => expiry?.date ? `${expiry.estimated?'≈ ':''}${new Intl.DateTimeFormat('en-IN',{day:'numeric',month:'short',year:'2-digit',timeZone:'UTC'}).format(new Date(`${expiry.date}T00:00:00Z`))}` : '-';
function chartTheme() {
  const style=getComputedStyle(document.documentElement),color=(name,fallback)=>style.getPropertyValue(name).trim()||fallback;
  const grid=color('--line','#1c2734'),text=color('--dim','#8797aa');
  return {autoSize:true,layout:{background:{type:'solid',color:color('--panel','#0b121d')},textColor:text,fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace',fontSize:10},grid:{vertLines:{color:grid},horzLines:{color:grid}},rightPriceScale:{borderColor:grid,scaleMargins:{top:.12,bottom:.12}},timeScale:{borderColor:grid,timeVisible:true,secondsVisible:false,tickMarkFormatter:(seconds,type)=>type<=2?IST_DATE.format(new Date(seconds*1000)):IST_TIME.format(new Date(seconds*1000))},localization:{timeFormatter:seconds=>IST_TIME.format(new Date(seconds*1000))}};
}
const candleStyle={upColor:'#21d3a3',downColor:'#ff536f',borderVisible:false,wickUpColor:'#21d3a3',wickDownColor:'#ff536f',lastValueVisible:false,priceLineVisible:false};
// The option premium for the trade's strike, with its own entry, SL and exit. Long premium: entry below, exit above/below by result.
function drawOptionChart(host, data) {
  const trade=data.trade,o=trade.option,chart=createChart(host,chartTheme());
  const series=chart.addSeries(CandlestickSeries,candleStyle);
  series.setData(data.optionCandles);
  const times=new Set(data.optionCandles.map(candle=>candle.time));
  const slHit=o.exitReason==='Option SL (breakout candle)'||o.exitReason==='Previous swing stop',levelExit=o.exitReason==='Level rejection';
  createSeriesMarkers(series,[
    ...(trade.breakoutAt&&times.has(trade.breakoutAt)?[{time:trade.breakoutAt,position:'belowBar',color:'#ffbf47',shape:'square',text:'BREAKOUT MIN',size:1}]:[]),
    {time:trade.time,position:'belowBar',color:'#21d3a3',shape:'arrowUp',text:`BUY ${o.strike} ${trade.direction} ${o.entry.toFixed(2)}`,size:2},
    {time:o.exitAt,position:'aboveBar',color:slHit?'#ff536f':levelExit?'#ffbf47':o.pnl>=0?'#5da9ff':'#ff536f',shape:'circle',text:`${slHit?'SL HIT':levelExit?'LEVEL REJECT':'EXIT'} ${o.exit.toFixed(2)}`,size:2},
  ].filter(marker=>times.has(marker.time)).sort((a,b)=>a.time-b.time));
  series.createPriceLine({price:o.entry,color:'#21d3a3',lineWidth:2,lineStyle:0,axisLabelVisible:true,title:`ENTRY ${o.entry.toFixed(2)}`});
  series.createPriceLine({price:o.exit,color:'#5da9ff',lineWidth:2,lineStyle:2,axisLabelVisible:true,title:`EXIT ${o.exit.toFixed(2)}`});
  if(Number.isFinite(o.sl))series.createPriceLine({price:o.sl,color:'#ff536f',lineWidth:2,lineStyle:2,axisLabelVisible:true,title:`SL ${o.sl.toFixed(2)}`});
  if(Number.isFinite(o.stopLevel))series.createPriceLine({price:o.stopLevel,color:'#ffbf47',lineWidth:2,lineStyle:2,axisLabelVisible:true,title:`SWING SL ${o.stopLevel.toFixed(2)}`});
  if(Number.isFinite(o.rejectLevel))series.createPriceLine({price:o.rejectLevel,color:'#c6ff4f',lineWidth:2,lineStyle:0,axisLabelVisible:true,title:`REJECT LEVEL ${o.rejectLevel.toFixed(2)}`});
  chart.timeScale().fitContent();
  return chart;
}
// Scrolling or zooming one chart moves the other to the same time window.
function syncTime(a, b) {
  let syncing=false;
  const link=(from,to)=>from.timeScale().subscribeVisibleTimeRangeChange(range=>{ if(!range||syncing)return; syncing=true; try{to.timeScale().setVisibleRange(range);}catch{} syncing=false; });
  link(a,b); link(b,a);
}

export default {
  title:'Backtest', sub:'Review breakout and Power Scalper setups against historical NIFTY candles', layout:'app', auth:true,
  async load(ctx) {
    const {ui}=ctx;
    ui.endDate ??= todayIst(); ui.startDate ??= shiftMonths(ui.endDate,-1);
    ui.range ??= '1m'; ui.horizon ??= 10; ui.exitLogic ??= 'horizon'; ui.stopLogic ??= 'none'; ui.resultMode ??= 'index'; ui.capital ??= 10000; ui.sizing ??= 'compound'; ui.strategy ??= 'openingRange'; ui.result ??= null; ui.error ??= '';
    orbDefaults(ui);
    try { ui.savedRuns=await get('/scalper/backtest-runs'); } catch { ui.savedRuns=[]; }
    // Whether historical option data can be read (Nifty 5-Min ORB actual-options mode).
    try { ui.caps=await get('/scalper/backtest-capabilities'); } catch(error) { ui.caps={optionsData:{available:false,reason:error.message}}; }
    gapDefaults(ui,ui.caps); ema915Defaults(ui,ui.caps); customDefaults(ui,ui.caps);
    // Opened from a strategy's Backtest button (Strategy page → My strategies): that strategy, ready to run.
    let picked=null; try { picked=Number(sessionStorage.getItem('tradelock.backtest.strategy'))||null; sessionStorage.removeItem('tradelock.backtest.strategy'); } catch { /* private window */ }
    if (picked && (ui.caps?.custom?.strategies||[]).some(x=>x.id===picked)) { ui.strategy=CUSTOM_KEY; ui.custom.strategyId=picked; ui.result=null; }
    else if (!ui.result && ui.savedRuns[0]) {
      const last=ui.savedRuns[0];
      ui.result=last;ui.strategy=last.strategy;ui.startDate=last.startDate;ui.endDate=last.endDate;
      ui.horizon=last.horizon;ui.exitLogic=last.exitLogic||'horizon';ui.stopLogic=last.stopLogic||'none';ui.range='custom';
      ui.resultMode=last.metrics.option?'option':'index';if(last.metrics.option){ui.capital=last.metrics.option.capital;ui.sizing=last.metrics.option.sizing||'fixed';}
      if(last.strategy===ORB5_KEY) orbFromRun(ui,last);
      if(last.strategy===GAP_KEY) gapFromRun(ui,last);
      if(last.strategy===EMA915_KEY) ema915FromRun(ui,last);
      if(last.strategy===CUSTOM_KEY) customFromRun(ui,last);
    }
    return {};
  },
  view(ctx) {
    const {ui}=ctx, result=ui.result, metrics=result?.metrics, selectedName=strategies.find(([key])=>key===ui.strategy)?.[1];
    const resultExit=exitRuleLabel(result?.exitLogic,result?.horizon||ui.horizon);
    const unavailableExits=Math.max(0,(metrics?.unavailable||0)-(metrics?.noSwingStop||0));
    const emptyReason=metrics?.noSwingStop&&!metrics.trades.length
      ? 'Signals were found, but none had a confirmed prior 2-bar swing to place a stop.'
      : metrics?.unavailable&&!metrics.trades.length
      ? 'Signals were found, but there was no later candle to close the trade in that session.'
      : ui.strategy==='openingRange'
        ? result?.rangeSessions===0?'No 09:15 opening-range candles were returned for these dates.':'No first 1-minute close breakout matched the opening range on these dates.'
        : ui.strategy==='previousDay' ? 'No previous-session high/low close breakout matched these dates. A prior trading session must be available.' : 'No EMA45 hammer-and-next-candle breakout matched these dates.';
    return html`<div class="bt-page ${ui.savedRuns?.length?'bt-has-saved':''}">
      <section class="strategy-hero panel pad bt-hero"><div class="strategy-hero-copy"><span class="eyebrow strategy-eyebrow">TRADELOCK - HISTORICAL REVIEW</span><h2>Test the same chart rules.</h2></div><small class="bt-hero-note">${icon('chart')} Historical candles only · no orders are placed</small></section>
      <section class="panel pad bt-controls">
        <div class="strategy-section-head"><span class="strategy-step">01</span><div><h3>Backtest setup</h3><p>Choose a rule set, historical range and exit logic.</p></div><span class="pill sm ice">NIFTY 50 | 1 MIN</span></div>
        <div class="bt-form">
          <label class="strategy-field"><span>Strategy</span><select class="input" data-bt-field="strategy" aria-label="Backtest strategy">${strategies.filter(([key])=>key!==GAP_KEY||ui.caps?.gap).map(([key,label])=>html`<option value="${key}" ${ui.strategy===key&&!(key===CUSTOM_KEY&&builtInPicked(ui))?'selected':''}>${label}</option>`)}${builtIns(ui).map(x=>html`<option value="${x.id}" ${ui.strategy===CUSTOM_KEY&&ui.custom?.strategyId===x.id?'selected':''}>${x.name.replace(' (built-in)','')}: entry and exit on the crossover</option>`)}</select></label>
          <label class="strategy-field"><span>Quick range</span><select class="input" data-bt-field="range" aria-label="Quick date range"><option value="1m" ${ui.range==='1m'?'selected':''}>1 month</option><option value="2m" ${ui.range==='2m'?'selected':''}>2 months</option><option value="6m" ${ui.range==='6m'?'selected':''}>6 months</option><option value="1y" ${ui.range==='1y'?'selected':''}>1 year</option><option value="5y" ${ui.range==='5y'?'selected':''}>5 years (max)</option><option value="custom" ${ui.range==='custom'?'selected':''}>Custom dates</option></select></label>
          <label class="strategy-field"><span>Start date</span><input class="input" type="date" data-bt-field="startDate" aria-label="Backtest start date" value="${ui.startDate}" min="${earliestIntradayDate()}" max="${ui.endDate}"></label>
          <label class="strategy-field"><span>End date</span><input class="input" type="date" data-bt-field="endDate" aria-label="Backtest end date" value="${ui.endDate}" min="${ui.startDate}" max="${todayIst()}"></label>
          ${ui.strategy===ORB5_KEY?orbFields(ui,ui.caps):ui.strategy===GAP_KEY?gapFields(ui):ui.strategy===EMA915_KEY?ema915Fields(ui):ui.strategy===CUSTOM_KEY?customFields(ui,ui.caps):html`<label class="strategy-field"><span>Exit logic</span><select class="input" data-bt-field="exitLogic" aria-label="Exit logic">${exitRules.map(([value,label])=>html`<option value="${value}" ${ui.exitLogic===value?'selected':''} ${ui.resultMode==='option'&&value==='emaZone'?'disabled':''}>${label}${ui.resultMode==='option'&&value==='emaZone'?' (index only)':''}</option>`)}</select></label>
          <label class="strategy-field"><span>Stop loss</span><select class="input" data-bt-field="stopLogic" aria-label="Stop-loss rule" ${ui.strategy!=='openingRange'?'disabled':''}>${stopRules.map(([value,label])=>html`<option value="${value}" ${ui.stopLogic===value?'selected':''}>${label}</option>`)}</select></label>
          <label class="strategy-field"><span>Exit after signal</span><select class="input" data-bt-field="horizon" aria-label="Fixed exit horizon" ${ui.exitLogic!=='horizon'?'disabled':''}>${horizons.map(([value,label])=>html`<option value="${value}" ${ui.horizon===value?'selected':''}>${label} - close</option>`)}</select></label>
          <label class="strategy-field"><span>Results in</span><select class="input" data-bt-field="resultMode" aria-label="Backtest result mode"><option value="index" ${ui.resultMode==='index'?'selected':''}>Index points</option><option value="option" ${ui.resultMode==='option'?'selected':''}>ATM option ₹ (2nd expiry)</option></select></label>
          <label class="strategy-field"><span>Sizing</span><select class="input" data-bt-field="sizing" aria-label="Position sizing" ${ui.resultMode!=='option'?'disabled':''}><option value="compound" ${ui.sizing==='compound'?'selected':''}>Compound: 100% of capital</option><option value="fixed" ${ui.sizing==='fixed'?'selected':''}>Fixed capital per trade</option></select></label>
          <label class="strategy-field"><span>${ui.sizing==='compound'?'Starting capital ₹':'Capital per trade ₹'}</span><input class="input" type="number" min="1000" step="1000" data-bt-field="capital" aria-label="Capital per trade in rupees" value="${ui.capital}" ${ui.resultMode!=='option'?'disabled':''}></label>`}
          <button class="btn btn-primary bt-run" id="bt-run" ${ui.running?'disabled':''}>${icon('chart')}${ui.running?'Loading history & saving...':'Run backtest'}</button>
        </div>
        ${ui.error?html`<div class="bt-error">${ui.error}</div>`:''}
        ${ui.chartError?html`<div class="bt-error">${ui.chartError}</div>`:''}
        ${ui.strategy===ORB5_KEY?orbNotes(ui,ui.caps):ui.strategy===GAP_KEY?gapNotes(ui,ui.caps):ui.strategy===EMA915_KEY?ema915Notes(ui,ui.caps):ui.strategy===CUSTOM_KEY?customNotes(ui,ui.caps):''}
        ${ui.strategy===ORB5_KEY||ui.strategy===GAP_KEY||ui.strategy===EMA915_KEY||ui.strategy===CUSTOM_KEY?'':html`<div>${''}
        ${ui.strategy==='previousDay'?html`<p class="bt-muted">First completed 1-minute close above the previous trading session's high: CE. Below its low: PE. One trade per day, entered at the confirming close; opening gaps qualify. Up to 14 calendar days of prior history are loaded for reference levels.</p>`:''}
        ${ui.resultMode==='option'?html`<p class="bt-muted">Option rupees: each index signal buys the ATM CE/PE of the 2nd weekly expiry at that minute's option close and stays on that strike. Lots = capital ÷ (premium × lot size), whole lots only; trades that cannot afford one lot are skipped. ${ui.sizing==='compound'?'Compounding: each trade uses 100% of the running capital, so profits and losses change the size of the next trade.':'Fixed: every trade is sized from the same capital.'} The Capital column shows the running balance after each trade. ${ui.stopLogic==='breakoutCandle'?'SL is the option candle in the index breakout minute (its low, since the option is bought).':'Choose the breakout-candle stop loss to add an option SL.'} The exit time follows the exit rule on the index. Lot size follows NSE's revisions (75 until Jul 2021, 50, 25 from Apr 2024, 75 from Nov 2024, 65 from Dec 2025). Excludes brokerage, taxes and slippage.${dayCount(ui.startDate,ui.endDate)>OPTION_MAX_DAYS?html` <b>Choose up to ${OPTION_MAX_DAYS} days in this mode.</b>`:''}</p>`:''}
        ${ui.stopLogic==='breakoutCandle'?html`<p class="bt-muted">Stop loss: CE stop at the 1-minute breakout candle's low, PE stop at its high. Price coming back through it means the 5-minute range breakout was rejected. From the candle after entry, a wick touch exits at the stop and a gap through it fills at that candle's open. Checked alongside the exit rule; whichever is hit first closes the trade (the stop wins if both fall on the same candle).</p>`:''}
        ${ui.exitLogic==='emaZone'?html`<p class="bt-muted">Exit on the first later 1-minute candle close between EMA45 and EMA105. If price does not close in the zone, the trade exits at that session's last candle.</p>`:''}
        ${ui.exitLogic==='levelReject'?html`<p class="bt-muted">Exit when price bounces off the floor of the move ${LEVEL_REJECT.touches} times. PE: the floor is the lowest low since entry, and a touch is a 1-minute swing low (below the candle before it, not above the candle after it) within ${LEVEL_REJECT.band} points of that floor. Bounces in the middle of a range, above a lower low, do not count, and a new low moves the floor. Once ${LEVEL_REJECT.touches} swing lows sit at the floor, exit at the close of the candle that confirms the latest one. CE mirrors this with the highest high and swing highs. With no rejection the trade exits at the session's last candle.</p>`:''}
        ${ui.exitLogic==='swingSL'?html`<p class="bt-muted">Stop is set at the latest confirmed 2-bar swing before entry: swing low for CE and swing high for PE. A later candle wick touching the stop exits at the stop price; a gap through it fills at the candle open. If the stop is not hit, the trade exits at the session close.</p>`:''}
        <p class="strategy-footnote">Dhan minute history covers the latest five years (start date from ${earliestIntradayDate()}) and is fetched in batches of up to 90 days. A full five-year run may take longer while its history loads. ${ui.exitLogic==='emaZone'?'EMA-zone trades exit on the first later close inside the band or at the session close.':ui.exitLogic==='swingSL'?'Swing-stop trades use a confirmed 2-bar pivot and exit on a wick touch or at the session close.':'Fixed-time trades exit at the selected horizon\'s NIFTY close.'} Results exclude option premium, fees and slippage.</p></div>`}
      </section>
      ${result&&result.strategy===CUSTOM_KEY ? html`<section class="bt-results">${runStrip(result)}${customResults(ui,result)}</section>` : result&&result.strategy===GAP_KEY ? html`<section class="bt-results">${runStrip(result)}${gapResults(ui,result)}</section>` : result&&result.strategy===EMA915_KEY ? html`<section class="bt-results">${runStrip(result)}${ema915Results(ui,result)}</section>` : result&&result.strategy===ORB5_KEY ? html`<section class="bt-results">${runStrip(result)}${orbResults(ui,result)}</section>` : result ? html`<section class="bt-results">${runStrip(result)}
        <div class="bt-result-head"><div><span class="eyebrow">${selectedName}</span><h3>Backtest results</h3><small>${result.oneMinuteBars.toLocaleString('en-IN')} one-minute bars | ${result.startDate} to ${result.endDate} IST | Exit: ${resultExit} | ${stopRuleLabel(result.stopLogic)} | saved ${stamp(result.createdAt/1000)}</small></div><span class="pill sm ${metrics.trades.length?'':'grey'}">${metrics.trades.length} CLOSED ${metrics.trades.length===1?'TRADE':'TRADES'}</span></div>
        ${metrics.option?html`<div class="bt-metrics"><article><small>Capital ${money(metrics.option.capital)} → </small><b class="${(metrics.option.endCapital??metrics.option.capital)>=metrics.option.capital?'pos':'neg'}">${money(metrics.option.endCapital??metrics.option.capital+metrics.option.totalPnl)}${Number.isFinite(metrics.option.returnPct)?html` <small>(${metrics.option.returnPct>=0?'+':''}${metrics.option.returnPct.toFixed(1)}%)</small>`:''}</b></article><article><small>Net P&amp;L (ATM option)</small><b class="${metrics.option.totalPnl>=0?'pos':'neg'}">${metrics.option.traded?rupee(metrics.option.totalPnl):'-'}</b></article><article><small>Option win rate</small><b>${metrics.option.traded?`${metrics.option.winRate.toFixed(1)}%`:'-'}</b></article><article><small>Wins / losses</small><b>${metrics.option.wins} / ${metrics.option.losses}</b></article><article><small>Avg P&amp;L / trade</small><b>${metrics.option.traded?rupee(metrics.option.averagePnl):'-'}</b></article><article><small>Max drawdown</small><b class="neg">${metrics.option.traded?`₹${Math.round(metrics.option.maxDrawdown).toLocaleString('en-IN')}${Number.isFinite(metrics.option.maxDrawdownPct)?` (${metrics.option.maxDrawdownPct.toFixed(1)}%)`:''}`:'-'}</b></article></div><p class="bt-muted">${metrics.option.sizing?sizingLabel(metrics.option.sizing):'fixed capital per trade'} | ${metrics.option.traded} option trades${metrics.option.unaffordable?` | ${metrics.option.unaffordable} skipped: one lot cost more than the capital`:''}${metrics.option.unavailable?` | ${metrics.option.unavailable} without option prices`:''} | SL and exit read from the option chart; the index supplies the entry</p>`:''}
        ${metrics.option?'':html`<div class="bt-metrics"><article><small>Win rate</small><b>${metrics.trades.length?`${metrics.winRate.toFixed(1)}%` : '-'}</b></article><article><small>Net index points</small><b class="${metrics.totalPoints>=0?'pos':'neg'}">${metrics.trades.length?signed(metrics.totalPoints) : '-'}</b></article><article><small>Wins / losses</small><b>${metrics.wins} / ${metrics.losses}</b></article><article><small>Avg points / trade</small><b>${metrics.trades.length?signed(metrics.averagePoints) : '-'}</b></article></div>`}
        ${ui.strategy==='openingRange'?html`<p class="bt-muted">Opening ranges found: ${result.rangeSessions} | breakout signals: ${result.signalCount}</p>`:html`<p class="bt-muted">${ui.strategy==='previousDay'?'Previous day breakout':'Confirmed EMA45'} signals: ${result.signalCount}</p>`}
        ${metrics.noSwingStop?html`<p class="bt-muted">${metrics.noSwingStop} signal${metrics.noSwingStop===1?' was':'s were'} skipped because there was no confirmed 2-bar swing before entry to place a stop.</p>`:''}
        ${unavailableExits?html`<p class="bt-muted">${unavailableExits} signal${unavailableExits===1?'':'s'} skipped because no valid later exit candle was available in that session.</p>`:''}
        ${metrics.trades.length&&metrics.option?optionTable(metrics,ui):metrics.trades.length?html`<div class="bt-table-wrap"><table class="bt-table"><thead><tr><th>Entry time (IST)</th><th>Side</th><th>Entry</th><th>Exit time</th><th>Exit</th>${ui.exitLogic==='swingSL'?html`<th>Stop level</th>`:''}${result.stopLogic==='breakoutCandle'?html`<th>SL</th>`:''}<th>Exit rule</th><th>Points</th><th>Result</th><th>Chart</th></tr></thead><tbody>${metrics.trades.slice().reverse().map((trade,displayIndex)=>html`<tr><td>${stamp(trade.entryAt||trade.time)}</td><td><span class="bt-side ${trade.direction.toLowerCase()}">${trade.direction} BUY</span></td><td>${trade.entry.toFixed(2)}</td><td>${stamp(trade.exitAt)}</td><td>${trade.exit.toFixed(2)}</td>${ui.exitLogic==='swingSL'?html`<td>${Number.isFinite(trade.stopLevel)?trade.stopLevel.toFixed(2):'-'}</td>`:''}${result.stopLogic==='breakoutCandle'?html`<td>${Number.isFinite(trade.slLevel)?trade.slLevel.toFixed(2):'-'}</td>`:''}<td>${trade.exitReason||resultExit}</td><td class="${trade.points>=0?'pos':'neg'}">${signed(trade.points)}</td><td><span class="bt-outcome ${trade.result.toLowerCase()}">${trade.result}</span></td><td><button class="btn bt-chart-btn" data-bt-chart-index="${metrics.trades.length-1-displayIndex}" ${ui.chartLoading!=null?'disabled':''}>View chart</button></td></tr>`)}</tbody></table></div>`:html`<div class="bt-empty">${icon('radar')}<b>No completed trades.</b><span>${emptyReason}</span></div>`}
        ${ui.chartLoading!=null?html`<div class="bt-chart-loading">Loading the saved trade chart...</div>`:''}
        ${ui.chartData?html`<section class="bt-trade-chart"><div class="bt-chart-head"><div><h4>Trade chart - ${chartStamp(ui.chartData.trade.time*1000)}</h4><small>${ui.chartData.trade.direction} | ${ui.chartData.day} IST</small></div><button class="btn bt-chart-btn" data-bt-close-chart>Close chart</button></div>${ui.chartData.trade.option&&!ui.chartData.trade.option.skipped?html`<div class="bt-chart-prices"><span>Option <b>${ui.chartData.trade.option.strike} ${ui.chartData.trade.direction}</b> | expiry ${optionExpiryText(ui.chartData.trade.option.expiry)} | ${ui.chartData.trade.option.lots} × ${ui.chartData.trade.option.lotSize}</span><span>Entry ₹<b>${ui.chartData.trade.option.entry.toFixed(2)}</b></span>${Number.isFinite(ui.chartData.trade.option.sl)?html`<span>SL ₹<b>${ui.chartData.trade.option.sl.toFixed(2)}</b></span>`:''}<span>Exit ₹<b>${ui.chartData.trade.option.exit.toFixed(2)}</b> | ${stamp(ui.chartData.trade.option.exitAt)}</span><span>Exit rule <b>${ui.chartData.trade.option.exitReason}</b></span><span class="${ui.chartData.trade.option.pnl>=0?'pos':'neg'}">${rupee(ui.chartData.trade.option.pnl)}${Number.isFinite(ui.chartData.trade.option.returnPct)?` (${ui.chartData.trade.option.returnPct>=0?'+':''}${ui.chartData.trade.option.returnPct.toFixed(1)}% premium)`:''}</span></div>`:''}<div class="bt-chart-prices"><span>Entry <b>${ui.chartData.trade.entry.toFixed(2)}</b> | ${stamp(ui.chartData.trade.entryAt||ui.chartData.trade.time)}</span>${ui.chartData.exitLogic==='swingSL'&&Number.isFinite(ui.chartData.trade.stopLevel)?html`<span>Swing stop <b>${ui.chartData.trade.stopLevel.toFixed(2)}</b></span>`:''}${Number.isFinite(ui.chartData.trade.slLevel)?html`<span>SL <b>${ui.chartData.trade.slLevel.toFixed(2)}</b></span>`:''}<span>Exit <b>${ui.chartData.trade.exit.toFixed(2)}</b> | ${stamp(ui.chartData.trade.exitAt)}</span><span>Exit rule <b>${ui.chartData.trade.exitReason||resultExit}</b></span><span class="${ui.chartData.trade.points>=0?'pos':'neg'}">${signed(ui.chartData.trade.points)} points</span></div>${ui.chartData.exitLogic==='emaZone'?html`<div class="bt-chart-ema-legend"><span><i class="ema45"></i>EMA45</span><span><i class="ema105"></i>EMA105</span><span class="zone">Band between lines is the exit zone</span>${ui.chartData.emaApproximate?html`<small>EMA values estimated because prior chart history is unavailable.</small>`:''}</div>`:ui.chartData.exitLogic==='swingSL'?html`<div class="bt-chart-ema-legend"><span><i class="swing-stop"></i>Previous swing stop</span><span class="zone">CE: swing low | PE: swing high</span></div>`:''}<div id="bt-trade-chart" class="bt-chart-host" role="img" aria-label="One-minute NIFTY candles with entry, swing stop and exit markers"></div>${ui.chartData.trade.option&&!ui.chartData.trade.option.skipped?html`<h5 class="bt-chart-sub">NIFTY ${ui.chartData.trade.option.strike} ${ui.chartData.trade.direction} · expiry ${optionExpiryText(ui.chartData.trade.option.expiry)} · option premium (1 min)</h5>${ui.chartData.optionCandles?.length?html`<div id="bt-option-chart" class="bt-chart-host bt-option-chart" role="img" aria-label="One-minute option premium candles with buy, SL and exit"></div>`:html`<p class="bt-muted">Option candles were not saved with this run. Run the backtest again to see the premium chart.</p>`}`:''}</section>`:''}
      </section>`:''}
      ${ui.savedRuns?.length?savedSide(ui):''}
    </div>`;
  },
  mount(ctx) {
    const {el,signal,ui}=ctx;
    signal.addEventListener('abort',()=>clearTradeChart(ui),{once:true});
    on(el,'change','[data-orb-field]',(_,field)=>{
      if(!orbFieldChange(ui,field))return;
      ui.result=null;ui.chartData=null;ui.chartLoading=null;ui.chartRequest=(ui.chartRequest||0)+1;ui.chartError='';ctx.paint();
    },signal);
    on(el,'change','[data-gap-field]',(_,field)=>{
      if(!gapFieldChange(ui,field))return;
      ui.result=null;ui.error='';ctx.paint();
    },signal);
    on(el,'change','[data-ema915-field]',(_,field)=>{
      if(!ema915FieldChange(ui,field))return;
      ui.result=null;ui.error='';ctx.paint();
    },signal);
    on(el,'click','[data-ema915-csv]',()=>{ if(ui.result?.strategy===EMA915_KEY) downloadCsv(`ema-9-15-5m-${ui.result.startDate}-to-${ui.result.endDate}.csv`,ema915Csv(ui.result)); },signal);
    on(el,'change','[data-custom-field]',(_,field)=>{
      if(!customFieldChange(ui,field))return;
      ui.result=null;ui.error='';ctx.paint();
    },signal);
    on(el,'click','[data-custom-csv]',()=>{ if(ui.result?.strategy===CUSTOM_KEY) downloadCsv(`my-strategy-${ui.result.startDate}-to-${ui.result.endDate}.csv`,customCsv(ui.result)); },signal);
    on(el,'click','[data-gap-view]',(_,button)=>{ ui.gapView=button.dataset.gapView;ctx.paint(); },signal);
    on(el,'click','[data-gap-csv]',()=>{ if(ui.result?.strategy===GAP_KEY) downloadCsv(`gap-open-0915-${ui.result.startDate}-to-${ui.result.endDate}.csv`,gapCsv(ui.result)); },signal);
    on(el,'click','[data-orb-csv]',()=>{ if(ui.result?.strategy===ORB5_KEY) downloadCsv(`nifty-5min-orb-${ui.result.startDate}-to-${ui.result.endDate}.csv`,orbCsv(ui.result)); },signal);
    const openSaved=run=>{
      if(run) {ui.result=run;ui.strategy=run.strategy;ui.startDate=run.startDate;ui.endDate=run.endDate;ui.horizon=run.horizon;ui.exitLogic=run.exitLogic||'horizon';ui.stopLogic=run.stopLogic||'none';ui.resultMode=run.metrics.option?'option':'index';if(run.metrics.option){ui.capital=run.metrics.option.capital;ui.sizing=run.metrics.option.sizing||'fixed';}ui.range='custom';if(run.strategy===ORB5_KEY)orbFromRun(ui,run);if(run.strategy===GAP_KEY)gapFromRun(ui,run);if(run.strategy===EMA915_KEY)ema915FromRun(ui,run);if(run.strategy===CUSTOM_KEY)customFromRun(ui,run);}
      else ui.result=null;
      ui.chartData=null;ui.chartLoading=null;ui.chartError='';ui.chartRequest=(ui.chartRequest||0)+1;ctx.paint();
      if(run) requestAnimationFrame(()=>el.querySelector('.bt-results')?.scrollIntoView({behavior:'smooth',block:'start'}));
    };
    const openCard=card=>{ const run=ui.savedRuns.find(row=>row.id===Number(card.dataset.btOpenRun)); if(run&&run.id!==ui.result?.id) openSaved(run); };
    on(el,'click','[data-bt-open-run]',(_,card)=>openCard(card),signal);
    on(el,'keydown','[data-bt-open-run]',(e,card)=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); openCard(card); } },signal);
    on(el,'change','[data-bt-field]',(_,field)=>{
      const key=field.dataset.btField;
      if(key==='range') { ui.range=field.value; if(field.value!=='custom') ui.startDate=quickRangeStart(ui.endDate,field.value); }
      else if(key==='endDate') { ui.endDate=field.value; if(ui.range!=='custom') ui.startDate=quickRangeStart(ui.endDate,ui.range); else if(ui.startDate>ui.endDate) ui.startDate=ui.endDate; }
      else if(key==='startDate') { ui.startDate=field.value;ui.range='custom';if(ui.startDate>ui.endDate)ui.endDate=ui.startDate; }
      else ui[key]=['strategy','exitLogic','stopLogic','resultMode','sizing'].includes(key)?field.value:Number(field.value);
      // A built-in crossover from the Strategy list runs as "My strategy" with that built-in chosen.
      if(key==='strategy'&&builtIns(ui).some(x=>x.id===field.value)) { ui.strategy=CUSTOM_KEY; ui.custom.strategyId=field.value; }
      else if(key==='strategy'&&field.value===CUSTOM_KEY&&builtInPicked(ui)) ui.custom.strategyId=(ui.caps?.custom?.strategies||[]).find(x=>!x.builtIn)?.id??ui.custom.strategyId;
      if(key==='strategy'&&field.value!=='openingRange') ui.stopLogic='none';
      if(key==='resultMode'&&field.value==='option'&&ui.exitLogic==='emaZone') ui.exitLogic='levelReject';
      ui.result=null;ui.chartData=null;ui.chartLoading=null;ui.chartRequest=(ui.chartRequest||0)+1;ui.chartError='';ctx.paint();
    },signal);
    on(el,'click','#bt-run',async()=>{
      if(ui.running)return;
      ui.running=true;ui.error='';ui.chartError='';ui.result=null;ui.chartData=null;clearTradeChart(ui);ctx.paint();
      const {strategy,startDate,endDate,horizon,exitLogic,resultMode,capital,sizing}=ui,stopLogic=ui.strategy==='openingRange'?ui.stopLogic:'none';
      try {
        const run=await post('/scalper/backtest-runs',strategy===ORB5_KEY?orbPayload(ui):strategy===GAP_KEY?gapPayload(ui):strategy===EMA915_KEY?ema915Payload(ui):strategy===CUSTOM_KEY?customPayload(ui):{strategy,startDate,endDate,horizon,exitLogic,stopLogic,resultMode,capital,sizing});
        ui.savedRuns=[run,...(ui.savedRuns||[]).filter(row=>row.id!==run.id)].slice(0,20);
        if(strategy===ORB5_KEY&&ui.strategy===ORB5_KEY) ui.result=run;
        if(strategy===GAP_KEY&&ui.strategy===GAP_KEY) ui.result=run;
        if(strategy===EMA915_KEY&&ui.strategy===EMA915_KEY) ui.result=run;
        if(strategy===CUSTOM_KEY&&ui.strategy===CUSTOM_KEY) ui.result=run;
        if(strategy===ui.strategy&&startDate===ui.startDate&&endDate===ui.endDate&&horizon===ui.horizon&&exitLogic===ui.exitLogic&&stopLogic===(ui.strategy==='openingRange'?ui.stopLogic:'none')) ui.result=run;
      } catch(error) { ui.error=error.message||'Could not save this backtest.'; }
      finally { ui.running=false;ctx.paint(); }
    },signal);
    on(el,'click','[data-bt-chart-index]',async(_,button)=>{
      const index=Number(button.dataset.btChartIndex),runId=ui.result?.id;
      if(!runId||ui.chartLoading!=null)return;
      const request=ui.chartRequest=(ui.chartRequest||0)+1;
      ui.chartData=null;ui.chartLoading=index;ui.chartError='';ctx.paint();
      try {
        const chart=await get(`/scalper/backtest-runs/${runId}/chart?tradeIndex=${index}`);
        if(request===ui.chartRequest)ui.chartData=chart;
      } catch(error) { if(request===ui.chartRequest)ui.chartError=error.message||'Could not load the saved trade chart.'; }
      finally { if(request===ui.chartRequest){ui.chartLoading=null;ctx.paint();} }
    },signal);
    on(el,'click','[data-bt-close-chart]',()=>{ui.chartRequest=(ui.chartRequest||0)+1;ui.chartData=null;ui.chartLoading=null;ui.chartError='';ctx.paint();},signal);
  },
  draw(ctx) {
    const {ui,el}=ctx,host=$('#bt-trade-chart',el),data=ui.chartData;
    if(ui.result?.strategy===CUSTOM_KEY) {
      const equityHost=$('#bt-custom-equity',el);
      if(ui.equityHost!==equityHost||!ui.equityView) { ui.equityView?.remove(); ui.equityView=equityHost?drawCustomEquity(equityHost,ui.result,chartTheme()):null; ui.equityHost=equityHost; }
      clearTradeChart(ui);
      return;
    }
    if(ui.result?.strategy===EMA915_KEY) {
      const equityHost=$('#bt-ema915-equity',el);
      if(ui.equityHost!==equityHost||!ui.equityView) { ui.equityView?.remove(); ui.equityView=equityHost?drawEma915Equity(equityHost,ui.result,chartTheme()):null; ui.equityHost=equityHost; }
      clearTradeChart(ui);
      return;
    }
    if(ui.result?.strategy===GAP_KEY) {
      const equityHost=$('#bt-gap-equity',el);
      if(ui.equityHost!==equityHost||!ui.equityView) { ui.equityView?.remove(); ui.equityView=equityHost?drawGapEquity(equityHost,ui.result,chartTheme()):null; ui.equityHost=equityHost; }
      clearTradeChart(ui);
      return;
    }
    if(ui.result?.strategy===ORB5_KEY) {
      const equityHost=$('#bt-orb-equity',el);
      if(ui.equityHost!==equityHost||!ui.equityView) { ui.equityView?.remove(); ui.equityView=equityHost?drawOrbEquity(equityHost,ui.result,chartTheme()):null; ui.equityHost=equityHost; }
      if(!host||!data){clearTradeChart(ui);return;}
      if(ui.chartHost===host&&ui.chartView)return;
      clearTradeChart(ui);
      ui.chartView=drawOrbTradeChart(host,data,chartTheme(),candleStyle);ui.chartHost=host;
      const optionHost=$('#bt-option-chart',el);
      if(optionHost&&data.optionCandles?.length) { ui.optionChartView=drawOptionChart(optionHost,data); syncTime(ui.chartView,ui.optionChartView); }
      return;
    }
    ui.equityView?.remove();ui.equityView=null;ui.equityHost=null;
    if(!host||!data){clearTradeChart(ui);return;}
    if(ui.chartHost===host&&ui.chartView)return;
    clearTradeChart(ui);
    const chart=createChart(host,chartTheme());
    const series=chart.addSeries(CandlestickSeries,candleStyle);
    series.setData(data.candles);
    const trade=data.trade,entryAt=trade.entryAt||trade.time;
    if(data.exitLogic==='emaZone') {
      const ema45=chart.addSeries(LineSeries,{title:'EMA45',color:'#21d3a3',lineWidth:2,priceLineVisible:false,lastValueVisible:true,crosshairMarkerVisible:false});
      const ema105=chart.addSeries(LineSeries,{title:'EMA105',color:'#ffbf47',lineWidth:2,priceLineVisible:false,lastValueVisible:true,crosshairMarkerVisible:false});
      ema45.setData(data.candles.filter(candle=>Number.isFinite(candle.ema45)).map(candle=>({time:candle.time,value:candle.ema45})));
      ema105.setData(data.candles.filter(candle=>Number.isFinite(candle.ema105)).map(candle=>({time:candle.time,value:candle.ema105})));
    }
    const zoneExit=trade.exitReason==='EMA45/EMA105 zone';
    const swingStopExit=trade.exitReason==='Previous swing stop'||trade.exitReason==='Stop loss (breakout candle)',levelExit=trade.exitReason==='Level rejection';
    createSeriesMarkers(series,[
      // Opening-range trades: the breakout candle closes beyond the range, the next candle triggers entry.
      ...(trade.breakoutAt&&trade.breakoutAt!==entryAt?[{time:trade.breakoutAt,position:trade.direction==='CE'?'aboveBar':'belowBar',color:'#ffbf47',shape:'square',text:'BREAKOUT',size:1}]:[]),
      {time:entryAt,position:trade.direction==='CE'?'belowBar':'aboveBar',color:'#21d3a3',shape:trade.direction==='CE'?'arrowUp':'arrowDown',text:`ENTRY ${trade.direction}`,size:2},
      ...(Number.isFinite(trade.exit)?[{time:trade.exitAt,position:trade.points>=0?'aboveBar':'belowBar',color:zoneExit||swingStopExit||levelExit?'#ffbf47':trade.points>=0?'#5da9ff':'#ff536f',shape:'circle',text:`${trade.option?'OPTION EXIT':zoneExit?'EMA ZONE EXIT':swingStopExit?'SL HIT':levelExit?'LEVEL REJECT':'EXIT'} ${trade.exit.toFixed(2)}`,size:2}]:[]),
    ].sort((a,b)=>a.time-b.time));
    series.createPriceLine({price:trade.entry,color:'#21d3a3',lineWidth:2,lineStyle:0,axisLabelVisible:true,title:`ENTRY ${trade.entry.toFixed(2)}`});
    if(Number.isFinite(trade.exit))series.createPriceLine({price:trade.exit,color:'#5da9ff',lineWidth:2,lineStyle:2,axisLabelVisible:true,title:`${trade.option?'AT OPTION EXIT':'EXIT'} ${trade.exit.toFixed(2)}`});
    if(data.exitLogic==='swingSL'&&Number.isFinite(trade.stopLevel))series.createPriceLine({price:trade.stopLevel,color:'#ffbf47',lineWidth:2,lineStyle:2,axisLabelVisible:true,title:`SWING SL ${trade.stopLevel.toFixed(2)}`});
    if(Number.isFinite(trade.slLevel))series.createPriceLine({price:trade.slLevel,color:'#ff536f',lineWidth:2,lineStyle:2,axisLabelVisible:true,title:`SL ${trade.slLevel.toFixed(2)}`});
    if(data.exitLogic==='levelReject'&&Number.isFinite(trade.rejectLevel))series.createPriceLine({price:trade.rejectLevel,color:'#c6ff4f',lineWidth:2,lineStyle:0,axisLabelVisible:true,title:`REJECT LEVEL ${trade.rejectLevel.toFixed(2)}`});
    const levelName=data.strategy==='previousDay'?'Prev day':data.strategy==='openingRange'?'Opening range':null;
    if(levelName&&trade.rangeHigh)series.createPriceLine({price:trade.rangeHigh,color:'#ffbf47',lineWidth:1,lineStyle:2,axisLabelVisible:true,title:levelName+' high'});
    if(levelName&&trade.rangeLow)series.createPriceLine({price:trade.rangeLow,color:'#a98cff',lineWidth:1,lineStyle:2,axisLabelVisible:true,title:levelName+' low'});
    chart.timeScale().fitContent();ui.chartHost=host;ui.chartView=chart;
    const optionHost=$('#bt-option-chart',el);
    if(optionHost&&data.trade.option&&!data.trade.option.skipped&&data.optionCandles?.length) {
      ui.optionChartView=drawOptionChart(optionHost,data);
      syncTime(chart,ui.optionChartView);
    }
  },
};
