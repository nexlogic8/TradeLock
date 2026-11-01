import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { MIGRATIONS } from '../src/db/schema.js';
import { backtestSignals, openingRangeFirstTradeSignals } from '../../web/js/pages/scalper-chart-signals.js';

const at=(h,m)=>Date.UTC(2026,9,14,h,m)/1000;   // UTC; 03:45 = 09:15 IST
const bar=(h,m,open,high,low,close)=>({time:at(h,m),open,high,low,close});
const five=[{time:at(3,45),open:100,high:105,low:95,close:102}];
// Breakout candle 09:21 closes 106 (low 103, high 107); 09:22 breaks 107 and closes green: CE entry at its 107.5 close, SL = 103.
const setup=[bar(3,50,102,104,101,103), bar(3,51,104,107,103,106), bar(3,52,106,108,105,107.5)];
const now=at(5,0)*1000;

test('CE stop sits at the breakout candle low and exits on a wick touch',()=>{
  const one=[...setup, bar(3,53,107.5,109,104,105), bar(3,54,105,106,102.5,103), bar(3,55,103,104,100,101)];
  const signals=openingRangeFirstTradeSignals(one,five,{now});
  assert.equal(signals[0].entry,107.5);
  const plain=backtestSignals(signals,one,{horizonBars:3});
  assert.equal(plain.trades[0].exitReason,'3m close','without a stop the fixed-time exit applies');
  const result=backtestSignals(signals,one,{horizonBars:3,stopLogic:'breakoutCandle'});
  const [trade]=result.trades;
  assert.equal(trade.slLevel,103);
  assert.equal(trade.exitReason,'Stop loss (breakout candle)');
  assert.equal(trade.exitAt,at(3,54));
  assert.equal(trade.exit,103);
  assert.equal(trade.points,-4.5);
});

test('a gap through the stop fills at the open; the exit rule still applies if the stop holds',()=>{
  const gap=[...setup, bar(3,53,107.5,109,104,105), bar(3,54,101,102,99,100)];
  assert.equal(backtestSignals(openingRangeFirstTradeSignals(gap,five,{now}),gap,{horizonBars:2,stopLogic:'breakoutCandle'}).trades[0].exit,101);
  const holds=[...setup, bar(3,53,107.5,110,106,109), bar(3,54,109,112,108,111)];
  const result=backtestSignals(openingRangeFirstTradeSignals(holds,five,{now}),holds,{horizonBars:2,stopLogic:'breakoutCandle'});
  assert.equal(result.trades[0].exitReason,'2m close');
  assert.equal(result.trades[0].points,3.5);
});

test('PE stop sits at the breakout candle high',()=>{
  // 09:21 closes 94 below the 95 range low (high 97); 09:22 breaks 93 and closes red: PE entry at its 92 close, SL = 97.
  const one=[bar(3,50,98,99,96,97), bar(3,51,96,97,93,94), bar(3,52,94,95,91,92), bar(3,53,92,98,91,97.5), bar(3,54,97,98,96,97)];
  const result=backtestSignals(openingRangeFirstTradeSignals(one,five,{now}),one,{exitLogic:'levelReject',stopLogic:'breakoutCandle'});
  assert.equal(result.trades[0].slLevel,97);
  assert.equal(result.trades[0].exit,97);
  assert.equal(result.trades[0].points,-5);
});

test('saved backtests store the stop rule after migration and older runs default to none',()=>{
  const db=new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for(const sql of MIGRATIONS.slice(0,-1)) db.transaction(()=>db.exec(sql))();
  db.prepare('INSERT INTO users (email,password_hash,name,created_at) VALUES (?,?,?,?)').run('t@example.com','hash','T',1);
  db.prepare(`INSERT INTO backtest_runs (user_id,strategy,start_date,end_date,horizon_bars,created_at,as_of,one_minute_bars,range_sessions,signal_count,metrics_json,candles_gzip,exit_logic)
    VALUES (1,'openingRange','2026-10-14','2026-10-14',10,2,2,100,1,1,'{}',?,'levelReject')`).run(Buffer.from('c'));
  db.transaction(()=>db.exec(MIGRATIONS.at(-1)))();
  assert.equal(db.prepare('SELECT stop_logic FROM backtest_runs WHERE id=1').get().stop_logic,'none');
  db.prepare(`INSERT INTO backtest_runs (user_id,strategy,start_date,end_date,horizon_bars,created_at,as_of,one_minute_bars,range_sessions,signal_count,metrics_json,candles_gzip,exit_logic,stop_logic)
    VALUES (1,'openingRange','2026-10-14','2026-10-14',10,3,3,100,1,1,'{}',?,'emaZone','breakoutCandle')`).run(Buffer.from('c'));
  assert.throws(()=>db.prepare(`UPDATE backtest_runs SET stop_logic='other' WHERE id=1`).run(),/CHECK constraint/);
  db.close();
});
