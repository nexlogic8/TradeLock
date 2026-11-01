import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { MIGRATIONS } from '../src/db/schema.js';

test('backtest exit migration preserves saved runs and allows swing stops',()=>{
  const db=new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for(const sql of MIGRATIONS.slice(0,-1)) db.transaction(()=>db.exec(sql))();
  db.prepare('INSERT INTO users (email,password_hash,name,created_at) VALUES (?,?,?,?)').run('test@example.com','hash','Test',1);
  const insert=db.prepare(`INSERT INTO backtest_runs
    (user_id,strategy,start_date,end_date,horizon_bars,created_at,as_of,one_minute_bars,range_sessions,signal_count,metrics_json,candles_gzip,exit_logic)
    VALUES (1,'openingRange','2026-10-12','2026-10-12',10,2,2,100,1,1,'{}',?,'emaZone')`);
  insert.run(Buffer.from('saved candles'));
  db.transaction(()=>db.exec(MIGRATIONS.at(-1)))();
  assert.equal(db.prepare('SELECT exit_logic FROM backtest_runs WHERE id=1').get().exit_logic,'emaZone');
  db.prepare(`INSERT INTO backtest_runs
    (user_id,strategy,start_date,end_date,horizon_bars,created_at,as_of,one_minute_bars,range_sessions,signal_count,metrics_json,candles_gzip,exit_logic)
    VALUES (1,'openingRange','2026-10-12','2026-10-12',10,3,3,100,1,1,'{}',?,'swingSL')`).run(Buffer.from('swing candles'));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM backtest_runs').get().count,2);
  db.close();
});
