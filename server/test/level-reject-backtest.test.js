import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { MIGRATIONS } from '../src/db/schema.js';
import { backtestSignals, levelRejectionExit } from '../../web/js/pages/scalper-chart-signals.js';

const start=Date.parse('2026-10-14T13:00:00+05:30')/1000;
const bar=(i,low,high,close,open=close)=>({time:start+i*60,open,high,low,close});

// Real NIFTY 1m candles, 14 Oct 2026, after the 13:01 PE entry at 22640.30 (low, high, close).
const real=[
  ['13:01',22629.5,22641.9,22631],['13:02',22624.9,22652.8,22625.35],['13:03',22614.3,22628.7,22615.35],['13:04',22605.55,22617.45,22611.7],
  ['13:05',22607.05,22618.1,22617.05],['13:06',22599.05,22619.55,22603],['13:07',22585.4,22609.05,22585.45],['13:08',22574.4,22597.25,22589.25],
  ['13:09',22589.75,22604.9,22590.5],['13:10',22576.7,22594.75,22577.6],['13:11',22568.9,22580.5,22570.55],['13:12',22565.45,22580.2,22571.15],
  ['13:13',22560.75,22571.4,22566.65],['13:14',22560.6,22572,22561.75],['13:15',22558.95,22589.8,22583.4],['13:16',22568.25,22583.7,22579.8],
  ['13:17',22568,22581.95,22573.55],['13:18',22570.35,22581.5,22579.65],['13:19',22573.45,22586.75,22574.1],['13:20',22570.95,22578.1,22577.55],
  ['13:21',22570.85,22578.25,22572.95],['13:22',22566.4,22578.4,22577.55],['13:23',22569.15,22578.15,22575.5],['13:24',22575.5,22591.9,22584.45],
  ['13:25',22579,22588.7,22583.15],['13:26',22577.65,22586.2,22585.8],['13:27',22581.6,22587.85,22583.6],['13:28',22581.15,22593,22592.2],
  ['13:29',22592,22602.1,22594.65],['13:30',22572.9,22595.75,22575],['13:31',22570.55,22580.15,22575.5],['13:32',22573.55,22579.6,22576.3],
  ['13:33',22576.05,22590.9,22586.55],
].map(([hhmm,low,high,close],i)=>({hhmm,...bar(i,low,high,close)}));

test('bounces above a lower low are mid-range and do not exit (real 14 Oct candles)',()=>{
  // Swing lows after entry: 22605.55, 22574.4, 22558.95 (13:15, the floor), 22568, 22566.4, 22570.55.
  // Only the 13:15 low is within 5 points of the floor; the later bounces sit 7-15 points above it.
  assert.equal(levelRejectionExit(real,0,'PE'),null);
});

// Real NIFTY 1m candles, 15 Sept 2026, after the 09:23 PE entry at 23481.45 (low, high, close).
const sept15=[
  ['09:23',23476,23493,23478],['09:24',23473.15,23493.35,23474.2],['09:25',23462.7,23474.05,23464.8],['09:26',23457.05,23468.85,23459.1],
  ['09:27',23457.9,23469,23460],['09:28',23453.65,23462.1,23455.9],['09:29',23452.05,23464.35,23463.9],['09:30',23456.8,23465.7,23461.95],
  ['09:31',23451.9,23464.6,23452.4],['09:32',23446.45,23460.1,23455.55],['09:33',23447.95,23457.75,23456.2],['09:34',23454.05,23460.75,23455.55],
  ['09:35',23453.55,23465,23455.25],['09:36',23441.85,23453.9,23443.75],['09:37',23439.05,23450,23441.3],['09:38',23439.5,23447.25,23442.7],
  ['09:39',23441.85,23456.75,23456.75],['09:40',23450.25,23458.45,23452.9],['09:41',23448.8,23455.15,23454.05],['09:42',23451.55,23458.35,23455.6],
  ['09:43',23453.8,23466.45,23461.6],['09:44',23446.25,23466.35,23448.1],['09:45',23434.35,23448.05,23439.55],['09:46',23436.75,23445.3,23438.1],
].map(([hhmm,low,high,close],i)=>({hhmm,time:Date.parse(`2026-09-15T${hhmm}:00+05:30`)/1000,open:close,high,low,close}));

test('the 15 Sept mid-range cluster no longer exits; a cluster at the floor does',()=>{
  // 09:29, 09:32 and 09:41 swing lows sit within 5 points of each other, but 09:37 had already gone to
  // 23439.05: those bounces were in the middle. The old rule exited at 09:42.
  assert.equal(levelRejectionExit(sept15,0,'PE'),null);
  const floor=[bar(0,118,122,120), bar(1,100,119,102), bar(2,106,110,109), bar(3,101,109,103), bar(4,107,112,111),
    bar(5,102,108,104), bar(6,108,113,112)];
  // Swing lows 100, 101 and 102 all sit within 5 points of the 100 floor; bar 6 confirms the third.
  assert.deepEqual(levelRejectionExit(floor,0,'PE'),{index:6,level:100,touches:3});
  const result=backtestSignals([{time:floor[0].time,direction:'PE',entry:120}],floor,{exitLogic:'levelReject'});
  assert.equal(result.trades[0].exitReason,'Level rejection');
  assert.equal(result.trades[0].exit,112);
  assert.equal(result.trades[0].rejectLevel,100);
});

test('a new low moves the floor and earlier bounces drop out',()=>{
  const rows=[bar(0,118,122,120), bar(1,100,119,102), bar(2,106,110,109), bar(3,101,109,103), bar(4,107,112,111),
    bar(5,90,108,92), bar(6,96,100,99), bar(7,91,98,93), bar(8,97,101,100)];
  // 100 and 101 were at the old floor; after 90 they are 10+ points up. 90 and 91 make only two touches.
  assert.equal(levelRejectionExit(rows,0,'PE'),null);
});

test('swing lows more than 5 points apart do not count as the same level',()=>{
  const rows=[bar(0,118,122,120), bar(1,100,119,102), bar(2,106,110,109), bar(3,107,112,111), bar(4,108,113,112),
    bar(5,114,118,117), bar(6,116,120,119)];
  // Swing lows 100 and 107 are 7 apart; none of the rest are swings.
  assert.equal(levelRejectionExit(rows,0,'PE'),null);
  const two=[bar(0,118,122,120), bar(1,100,119,102), bar(2,106,110,109), bar(3,103,109,104), bar(4,107,112,111)];
  assert.equal(levelRejectionExit(two,0,'PE'),null,'two touches are not enough');
});

test('CE mirrors with swing highs and exits on the third one',()=>{
  const ce=[
    bar(0,98,102,100), bar(1,101,120,118), bar(2,110,114,111), bar(3,112,118,117), bar(4,108,113,109),
    bar(5,113,121,114), bar(6,110,116,112),
  ];
  // Swing highs 120, 118 and 121 all sit within 5 points of the 121 ceiling; bar 6 confirms the third.
  assert.deepEqual(levelRejectionExit(ce,0,'CE'),{index:6,level:121,touches:3});
  const result=backtestSignals([{time:ce[0].time,direction:'CE',entry:100}],ce,{exitLogic:'levelReject'});
  assert.equal(result.trades[0].exit,112);
  assert.equal(result.trades[0].points,12);
});

test('without a rejection the trade exits at the session close',()=>{
  const rows=[bar(0,118,122,120), bar(1,110,119,112), bar(2,100,111,101), bar(3,90,101,91)];
  const result=backtestSignals([{time:rows[0].time,direction:'PE',entry:120}],rows,{exitLogic:'levelReject'});
  assert.equal(result.trades[0].exitReason,'Session close');
  assert.equal(result.trades[0].exit,91);
});

test('saved backtests accept the level-rejection exit after migration and keep older runs',()=>{
  const db=new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const levelRejectMigration=MIGRATIONS.findIndex(sql=>sql.includes('backtest_runs_before_level_reject'));
  for(const sql of MIGRATIONS.slice(0,levelRejectMigration)) db.transaction(()=>db.exec(sql))();
  db.prepare('INSERT INTO users (email,password_hash,name,created_at) VALUES (?,?,?,?)').run('t@example.com','hash','T',1);
  const insert=exit=>db.prepare(`INSERT INTO backtest_runs
    (user_id,strategy,start_date,end_date,horizon_bars,created_at,as_of,one_minute_bars,range_sessions,signal_count,metrics_json,candles_gzip,exit_logic)
    VALUES (1,'openingRange','2026-10-14','2026-10-14',10,2,2,100,1,1,'{}',?,?)`).run(Buffer.from('c'),exit);
  insert('swingSL');
  assert.throws(()=>insert('levelReject'),/CHECK constraint/);
  for(const sql of MIGRATIONS.slice(levelRejectMigration)) db.transaction(()=>db.exec(sql))();
  insert('levelReject');
  assert.deepEqual(db.prepare('SELECT exit_logic FROM backtest_runs ORDER BY id').all().map(r=>r.exit_logic),['swingSL','levelReject']);
  db.close();
});
