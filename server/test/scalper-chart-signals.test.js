import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emaRejectionMarkers } from '../../web/js/pages/scalper-chart-signals.js';

const emaValue = (rows, period = 45) => {
  const k=2/(period+1); let value;
  for (const {close} of rows) value=value == null ? close : close*k + value*(1-k);
  return value;
};

function trendRows(direction=1) {
  return Array.from({length:120},(_,i)=>{
    const close=direction > 0 ? 100+i*.5 : 300-i*.5;
    const time=Date.UTC(2026,9,13,3,45)/1000+i*60;
    return direction > 0
      ? {time,open:close-.1,high:close+.3,low:close-.3,close}
      : {time,open:close+.1,high:close+.3,low:close-.3,close};
  });
}

function addBullishHammerAndBreakout(rows, color='green', breakout=true) {
  const ema=emaValue(rows), time=rows.at(-1).time+60;
  const open=color==='green' ? ema+2 : ema+3, close=color==='green' ? ema+3 : ema+2;
  const hammer={time,open,close,low:ema-.2,high:Math.max(open,close)+.1};
  rows.push(hammer);
  const nextTime=time+60, nextClose=breakout ? hammer.high+.5 : hammer.high-.1;
  rows.push({time:nextTime,open:hammer.high-.2,high:breakout ? hammer.high+.6 : hammer.high-.1,low:hammer.low+.2,close:nextClose});
  return {hammerTime:time,signalTime:nextTime};
}

function addBearishHammerAndBreakout(rows, color='red', breakout=true) {
  const ema=emaValue(rows), time=rows.at(-1).time+60;
  const open=color==='red' ? ema-2 : ema-3, close=color==='red' ? ema-3 : ema-2;
  const hammer={time,open,close,low:Math.min(open,close)-.1,high:ema+.2};
  rows.push(hammer);
  const nextTime=time+60, nextClose=breakout ? hammer.low-.5 : hammer.low+.1;
  rows.push({time:nextTime,open:hammer.low+.2,high:hammer.high-.2,low:breakout ? hammer.low-.6 : hammer.low+.1,close:nextClose});
  return {hammerTime:time,signalTime:nextTime};
}

test('any-color hammer above EMA45 signals CE when the next completed candle breaks its high',()=>{
  for (const color of ['green','red']) {
    const rows=trendRows(1), {signalTime}=addBullishHammerAndBreakout(rows,color);
    assert.deepEqual(emaRejectionMarkers(rows,{now:(signalTime+60)*1000}),[
      {time:signalTime,position:'belowBar',color:'#21d3a3',shape:'arrowUp',text:'CE BUY · EMA45 BREAKOUT',size:2},
    ]);
  }
});

test('any-color inverted hammer below EMA45 signals PE when the next completed candle breaks its low',()=>{
  for (const color of ['red','green']) {
    const rows=trendRows(-1), {signalTime}=addBearishHammerAndBreakout(rows,color);
    assert.deepEqual(emaRejectionMarkers(rows,{now:(signalTime+60)*1000}),[
      {time:signalTime,position:'aboveBar',color:'#ff536f',shape:'arrowDown',text:'PE BUY · EMA45 BREAKOUT',size:2},
    ]);
  }
});

test('does not signal without a breakout or before the confirming candle completes',()=>{
  const rows=trendRows(1), {signalTime}=addBullishHammerAndBreakout(rows,'green',false);
  assert.deepEqual(emaRejectionMarkers(rows,{now:(signalTime+60)*1000}),[]);
  const breakout=trendRows(1), {signalTime:breakTime}=addBullishHammerAndBreakout(breakout);
  assert.deepEqual(emaRejectionMarkers(breakout,{now:breakTime*1000+30_000}),[]);
});

test('rejects the setup when the candle before the hammer has a body inside the EMA45/105 zone',()=>{
  const rows=trendRows(1), previous=rows.at(-1), priorRows=rows.slice(0,-1);
  const fast=emaValue(priorRows,45), slow=emaValue(priorRows,105), midpoint=(fast+slow)/2;
  previous.open=midpoint-.2;
  previous.close=midpoint+.2;
  previous.high=midpoint+.5;
  previous.low=midpoint-.5;
  const {signalTime}=addBullishHammerAndBreakout(rows);
  assert.deepEqual(emaRejectionMarkers(rows,{now:(signalTime+60)*1000}),[]);
});

test('accepts a wick as short as the body and ignores the opposite wick size',()=>{
  const up=trendRows(1), emaUp=emaValue(up), t1=up.at(-1).time+60;
  const hammer={time:t1,open:emaUp+.5,close:emaUp+1.5,low:emaUp-.5,high:emaUp+3};
  up.push(hammer,{time:t1+60,open:hammer.high-.2,high:hammer.high+.1,low:hammer.low+.2,close:hammer.high-.1});
  assert.equal(emaRejectionMarkers(up,{now:(t1+120)*1000})[0]?.text,'CE BUY · EMA45 BREAKOUT');

  const down=trendRows(-1), emaDown=emaValue(down), t2=down.at(-1).time+60;
  const inverse={time:t2,open:emaDown-.5,close:emaDown-1.5,low:emaDown-3,high:emaDown+.5};
  down.push(inverse,{time:t2+60,open:inverse.low+.2,high:inverse.high-.2,low:inverse.low-.1,close:inverse.low+.1});
  assert.equal(emaRejectionMarkers(down,{now:(t2+120)*1000})[0]?.text,'PE BUY · EMA45 BREAKOUT');
});

test('rejects a body touching EMA45, a wick that misses EMA45, and an incomplete hammer',()=>{
  const base=trendRows(1), ema=emaValue(base), time=base.at(-1).time+60;
  const bodyTouches=base.slice();
  bodyTouches.push({time,open:ema-.5,close:ema+2,low:ema-5,high:ema+2.1});
  bodyTouches.push({time:time+60,open:ema+2,close:ema+3,low:ema+1,high:ema+3.1});
  assert.deepEqual(emaRejectionMarkers(bodyTouches,{now:(time+120)*1000}),[]);

  const missesEma=base.slice();
  missesEma.push({time,open:ema+2,close:ema+3,low:ema+1,high:ema+3.1});
  missesEma.push({time:time+60,open:ema+3,close:ema+4,low:ema+2,high:ema+4.2});
  assert.deepEqual(emaRejectionMarkers(missesEma,{now:(time+120)*1000}),[]);
});
