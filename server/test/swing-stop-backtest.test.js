import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backtestSignals } from '../../web/js/pages/scalper-chart-signals.js';

const start=Date.parse('2026-10-13T09:15:00+05:30')/1000;
function candle(index,{open=100,high=105,low=95,close=100}={}) {
  return {time:start+index*60,open,high,low,close};
}

test('long swing stop uses the last confirmed prior swing low and exits on wick touch',()=>{
  const rows=[
    candle(0,{low:100}),candle(1,{low:95}),candle(2,{low:90}),candle(3,{low:96}),
    candle(4,{low:99}),candle(5,{low:100,close:110}),candle(6,{open:92,high:100,low:89,close:95}),
  ];
  const result=backtestSignals([{time:rows[5].time,direction:'CE',entry:110}],rows,{exitLogic:'swingSL'});
  assert.equal(result.trades.length,1);
  assert.equal(result.trades[0].stopLevel,90);
  assert.equal(result.trades[0].exit,90);
  assert.equal(result.trades[0].exitReason,'Previous swing stop');
  assert.equal(result.trades[0].points,-20);
});

test('short swing stop uses the last confirmed prior swing high and gaps fill at candle open',()=>{
  const rows=[
    candle(0,{high:100}),candle(1,{high:105}),candle(2,{high:110}),candle(3,{high:104}),
    candle(4,{high:101}),candle(5,{high:99,close:90}),candle(6,{open:112,high:115,low:108,close:110}),
  ];
  const result=backtestSignals([{time:rows[5].time,direction:'PE',entry:90}],rows,{exitLogic:'swingSL'});
  assert.equal(result.trades.length,1);
  assert.equal(result.trades[0].stopLevel,110);
  assert.equal(result.trades[0].exit,112);
  assert.equal(result.trades[0].exitReason,'Previous swing stop');
  assert.equal(result.trades[0].points,-22);
});

test('swing-stop backtest skips a signal with no confirmed pivot before entry',()=>{
  const rows=[candle(0,{low:100}),candle(1,{low:99}),candle(2,{low:98}),candle(3,{low:97}),candle(4,{low:96})];
  const result=backtestSignals([{time:rows[4].time,direction:'CE',entry:100}],rows,{exitLogic:'swingSL'});
  assert.equal(result.trades.length,0);
  assert.equal(result.noSwingStop,1);
  assert.equal(result.unavailable,1);
});
