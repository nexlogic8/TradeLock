import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previousDayBreakoutSignals, backtestSignals } from '../../web/js/pages/scalper-chart-signals.js';
const bar=(day,minute,close,high=close,low=close)=>({time:Date.parse(`2026-10-${day}T09:${minute}:00+05:30`)/1000,open:close,high,low,close});
const prior=[bar('09','15',100,110,90),bar('09','16',100,105,95)];
const now=Date.parse('2026-10-14T00:00:00+05:30');
test('previous session levels span weekends, ignore wicks and equality, and take only first breakout',()=>{
 const rows=[...prior,bar('12','15',110,115,95),bar('12','16',111),bar('12','17',89)];
 const signals=previousDayBreakoutSignals(rows,{now});
 assert.equal(signals.length,1);assert.equal(signals[0].direction,'CE');assert.equal(signals[0].entry,111);
 assert.equal(signals[0].rangeHigh,110);assert.equal(signals[0].rangeLow,90);
 assert.equal(backtestSignals(signals,rows,{horizonBars:1}).totalPoints,-22);
});
test('opening gap below previous low confirms PE at close',()=>{
 const signals=previousDayBreakoutSignals([...prior,bar('12','15',88)],{now});
 assert.equal(signals.length,1);assert.equal(signals[0].direction,'PE');assert.equal(signals[0].entry,88);
});
test('missing prior session and incomplete candles cannot generate a signal',()=>{
 assert.equal(previousDayBreakoutSignals(prior,{now}).length,0);
 const next=bar('12','15',111);
 assert.equal(previousDayBreakoutSignals([...prior,next],{now:next.time*1000+59000}).length,0);
});
test('levels roll forward without looking ahead and exclude outside-session candles',()=>{
 const outside={...bar('09','15',1000),time:Date.parse('2026-10-09T16:00:00+05:30')/1000};
 const signals=previousDayBreakoutSignals([...prior,outside,bar('12','15',100,108,92),bar('13','15',109)],{now});
 assert.equal(signals.length,1);assert.equal(signals[0].rangeHigh,108);
});
