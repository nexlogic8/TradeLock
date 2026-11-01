import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backtestSignals, confirmedRangeBreakout, openingRangeFirstTradeSignals, normalizeBacktestCandles } from '../../web/js/pages/scalper-chart-signals.js';

const seconds = (hour, minute) => Date.UTC(2026,9,13,hour,minute)/1000;

test('opening-range entry needs the next candle to break the breakout candle high',()=>{
  const rangeTime=seconds(3,45); // 09:15 IST
  const five=[{time:rangeTime,open:100,high:105,low:95,close:102}];
  const one=[
    {time:seconds(3,50),open:102,high:104,low:101,close:103},
    {time:seconds(3,51),open:104,high:107,low:103,close:106},   // breakout candle: closes above 105
    {time:seconds(3,52),open:106,high:108,low:105,close:107},   // breaks 107 and closes green: entry at its close
    {time:seconds(3,53),open:107,high:109,low:106,close:108},
    {time:seconds(3,54),open:108,high:110,low:107,close:109},
  ];
  const signals=openingRangeFirstTradeSignals(one,five,{now:seconds(4,0)*1000});
  assert.equal(signals.length,1);
  assert.equal(signals[0].direction,'CE');
  assert.equal(signals[0].breakoutAt,seconds(3,51));
  assert.equal(signals[0].time,seconds(3,52),'the trade starts on the confirming candle');
  assert.equal(signals[0].entry,107,'entry is the confirming candle close');
  assert.equal(signals[0].stop,95);
  const result=backtestSignals(signals,one,{horizonBars:2});
  assert.equal(result.trades.length,1);
  assert.equal(result.totalPoints,2);
  assert.equal(result.wins,1);
});

test('an unconfirmed breakout is skipped and the first confirmed one (here a PE) is traded',()=>{
  const five=[{time:seconds(3,45),open:100,high:105,low:95,close:102}];
  const one=[
    {time:seconds(3,50),open:102,high:104,low:101,close:103},
    {time:seconds(3,51),open:104,high:107,low:103,close:106},   // closes above range...
    {time:seconds(3,52),open:106,high:106.5,low:104,close:104}, // ...but next candle never takes 107
    {time:seconds(3,53),open:104,high:104,low:96,close:97},
    {time:seconds(3,54),open:97,high:97,low:93,close:94},       // closes below 95: breakout candle
    {time:seconds(3,55),open:94,high:95,low:92,close:92.5},     // breaks 93 and closes red: PE entry at 92.5
  ];
  const [signal,...rest]=openingRangeFirstTradeSignals(one,five,{now:seconds(4,0)*1000});
  assert.equal(rest.length,0);
  assert.equal(signal.direction,'PE');
  assert.equal(signal.time,seconds(3,55));
  assert.equal(signal.entry,92.5);
  assert.equal(signal.stop,105);
});

test('the confirming candle must close in the trade colour; entry is its close; a forming one only waits',()=>{
  const range={high:105,low:95,end:seconds(3,50)};
  const base=[
    {time:seconds(3,50),open:102,high:104,low:101,close:103},
    {time:seconds(3,51),open:104,high:107,low:103,close:106},   // breakout candle: closes above 105, high 107
  ];
  const now={now:seconds(3,56)*1000};
  // 25 Sept pattern: the next candle trades above 107 but closes red, so the CE is not taken.
  const red=[...base,{time:seconds(3,52),open:106.5,high:108,low:104,close:105.5}];
  assert.equal(confirmedRangeBreakout(red,range,now).signal,undefined);
  const green=[...base,{time:seconds(3,52),open:108,high:109,low:107.5,close:108.5}];
  assert.equal(confirmedRangeBreakout(green,range,now).signal.entry,108.5,'gap above 107 that closes green: entry at the close');
  // Live: the confirming candle has started; its colour is not final, so the scan waits.
  const forming=[...base,{time:seconds(3,52),open:106,high:107.8,low:105.5,close:107.6}];
  const live=confirmedRangeBreakout(forming,range,{now:(seconds(3,52)+20)*1000});
  assert.equal(live.signal,undefined);
  assert.equal(live.pending.level,107);
});
test('backtest skips trades without a full same-session exit horizon',()=>{
  const signal={time:seconds(3,53),direction:'PE',entry:100};
  const rows=[{time:signal.time,close:100}];
  assert.equal(backtestSignals([signal],rows,{horizonBars:2}).unavailable,1);
});

test('opening-range breakout requires the prior close to be available and on the other side of the level',()=>{
  const five=[{time:seconds(3,45),high:105,low:95}];
  const missingPrior=[{time:seconds(3,51),close:106},{time:seconds(3,52),close:107}];
  const priorAlreadyAbove=[{time:seconds(3,50),close:106},{time:seconds(3,51),close:107}];
  const now=seconds(4,0)*1000;
  assert.equal(openingRangeFirstTradeSignals(missingPrior,five,{now}).length,0);
  assert.equal(openingRangeFirstTradeSignals(priorAlreadyAbove,five,{now}).length,0);
});

test('Dhan millisecond timestamps normalize before strategy evaluation',()=>{
  const five=normalizeBacktestCandles([{time:seconds(3,45)*1000,open:100,high:105,low:95,close:102}]);
  const one=normalizeBacktestCandles([
    {time:seconds(3,50)*1000,open:102,high:104,low:101,close:103},
    {time:seconds(3,51)*1000,open:104,high:107,low:103,close:106},
    {time:seconds(3,52)*1000,open:106,high:108,low:105,close:107},
  ]);
  assert.equal(one[0].time,seconds(3,50));
  assert.equal(openingRangeFirstTradeSignals(one,five,{now:seconds(4,0)*1000}).length,1);
});

test('a near-doji confirming candle does not confirm: real 25 Sept 09:29-09:30',()=>{
  const at=(h,m)=>Date.parse(`2026-09-25T${h}:${m}:00+05:30`)/1000;
  const range={high:23104.4,low:23030,end:at('09','20')};
  const bars=[
    {time:at('09','28'),open:23097.75,high:23102.95,low:23095.1,close:23102.45},
    {time:at('09','29'),open:23102.25,high:23116.65,low:23101.85,close:23116.65},  // closes above 23104.40: breakout candle
    {time:at('09','30'),open:23116.5,high:23118.55,low:23105.55,close:23116.8},    // takes 23116.65, green by 0.30 of a 13-point range
    {time:at('09','31'),open:23117,high:23121.6,low:23107.1,close:23108.7},
  ];
  assert.equal(confirmedRangeBreakout(bars,range,{now:at('09','40')*1000}).signal,undefined);
});
