import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signalBudget, sizeSwingTrade, swingStopFor } from '../src/modules/scalper/signal-risk.js';
import { parseInstruments } from '../src/modules/scalper/instruments.js';
import { signalPanel } from '../../web/js/pages/scalper-signal.js';

const rules = { maxLoss:{ on:true, mode:'percent', value:5 }, maxTrades:{ on:true, value:3 } };
test('saved daily percentage divided by trades gives capital risk, capped by remaining loss', () => {
  const risk = signalBudget(rules, 229428);
  assert.equal(risk.daily, 11471.4);
  assert.equal(risk.perTrade, 3823.8);
  assert.ok(Math.abs(risk.percent - 5/3) < 1e-10);
  assert.ok(Math.abs(signalBudget(rules,229428,-11000).available-471.4) < 1e-9);
  assert.equal(signalBudget(rules,229428,10000).available,3823.8);
  assert.equal(signalBudget(rules,229428,-12000).available,0);
  assert.equal(signalBudget(rules,null),null);
  assert.equal(signalBudget({...rules,maxTrades:{on:false,value:3}},229428)?.trades,3,"trade cap off still sizes per trade");
  assert.equal(signalBudget({...rules,maxLoss:{on:true,mode:'amount',value:9000}},229428).perTrade,3000);
});

const now = 1800000000000;
const candles = [120,110,100,111,115].map((low,i) => ({time:now-(5-i)*300000, low,high:130,open:125,close:126}));
const args = { entry:125,tickSize:.05,lotSize:50,budget:3823.8,funds:229428,now };
test('stop below confirmed option swing sizes whole lots inside risk and funds', () => {
  const result = sizeSwingTrade(candles,args);
  assert.equal(result.stop,99.95);
  assert.equal(result.quantity,150);
  assert.equal(result.lots,3);
  assert.equal(result.risk,3757.5);
  assert.ok(result.risk <= args.budget);
  assert.equal(sizeSwingTrade(candles,{...args,funds:7000}).quantity,50);
  assert.equal(sizeSwingTrade(candles,{...args,budget:1000}),null);
  assert.equal(sizeSwingTrade(candles,{...args,lotSize:0}),null);
});
test('Dhan paise tick size produces a one-tick stop below the previous option swing', () => {
  const swingCandles = [12,11,9.1,11,12].map((low,i) => ({
    time:now-(5-i)*300_000, low, high:13, open:12, close:12
  }));
  const swing = swingStopFor(swingCandles,{entry:13.65,tickSize:.05,lotSize:65,now});
  assert.equal(swing.swingLow,9.1);
  assert.equal(swing.stop,9.05);
  assert.equal(swing.oneLotRisk,299);
});
test('unconfirmed, stale, broken or invalid swings cannot produce a signal', () => {
  assert.equal(sizeSwingTrade(candles.slice(0,4),args),null);
  assert.equal(sizeSwingTrade(candles,{...args,now:now+900001}),null);
  assert.equal(sizeSwingTrade(candles,{...args,entry:99}),null);
  assert.equal(sizeSwingTrade([...candles,{...candles[4],time:now,low:90}],{...args,now:now+300000}),null);
  assert.equal(sizeSwingTrade(candles.map(c=>({...c,time:c.time+300000})),args),null);
});
test('instrument master converts Dhan NIFTY option paise ticks to rupee prices and filters other products', () => {
  const data = parseInstruments('EXCH_ID,INSTRUMENT,UNDERLYING_SYMBOL,SECURITY_ID,LOT_SIZE,TICK_SIZE,SM_EXPIRY_DATE,STRIKE_PRICE,OPTION_TYPE,DISPLAY_NAME\nNSE,OPTIDX,NIFTY,123,65,5.0000,2026-10-20,22500,CE,"NIFTY, CALL"\nBSE,OPTIDX,NIFTY,456,10,0.05,2026-10-20,22500,CE,Other');
  assert.equal(data.size,1);
  assert.deepEqual(data.get('123'),{lotSize:65,tickSize:.05,expiry:'2026-10-20',strike:22500,option:'CE'});
});
test('AI panel displays derived risk, suggested entry and swing stop, and hides expired buys', () => {
  const risk = {budget:signalBudget(rules,229428),reason:''};
  const ui = {signalRisk:risk,aiSignal:{action:'BUY_CE',contract:{...sizeSwingTrade(candles,args),entryAllowed:true,capitalRequired:sizeSwingTrade(candles,args).premium,strike:22500,option:'CE',expiry:'2026-10-20'},confidence:.8,rationale:'Confirmed swing',asOf:Date.now(),expiresAt:Date.now()+60000}};
  let view = String(signalPanel(ui));
  assert.match(view,/5% ÷ 3 trades = 1.67%/);
  assert.match(view,/BUY 22500 CE/); assert.match(view,/99.95/); assert.match(view,/150 \(3 lots\)/); assert.match(view,/Capital needed <b>₹18,750<\/b>/);
  ui.aiSignal.setup = {stale:true}; ui.aiSignal.contract.entryAllowed = false;
  ui.aiSignal.contract.blockReason = 'Historical first-trade analysis only; breakout entry is stale.';
  view = String(signalPanel(ui));
  assert.match(view,/Entry after first breakout/); assert.match(view,/150 \(3 lots\) · historical/);
  assert.match(view,/Historical first-trade analysis only/);
  ui.aiSignal.expiresAt = Date.now()-1;
  view = String(signalPanel(ui));
  assert.match(view,/Signal expired/); assert.doesNotMatch(view,/BUY 22500/);
  assert.match(String(signalPanel({signalRisk:{...risk,reason:'Broker locked'}})),/disabled/);
});
