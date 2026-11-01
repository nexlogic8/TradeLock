import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orb5Backtest } from '../src/modules/scalper/orb5.js';

const page=(await import('../../web/js/pages/backtest.js')).default;
const { orbCsv, orbDefaults } = await import('../../web/js/pages/backtest-orb5.js');

const at=(day,hhmm)=>Date.parse(`${day}T${hhmm}:00+05:30`)/1000;
const rows=[['09:15',100,104,98,102],['09:16',102,103,95,101],['09:17',101,110,100,104],['09:18',104,106,101,103],['09:19',103,105,100,104],
  ['09:20',108,112,107,111],['09:21',111,113,110.5,112],['09:22',112,130,106,119.5]]   // 09:22 touches stop and target: ambiguous
  .map(([t,o,h,l,c])=>({time:at('2026-10-13',t),open:o,high:h,low:l,close:c}));
// 12 Oct has only two opening candles: skipped and reported.
rows.unshift({time:at('2026-10-12','09:15'),open:100,high:101,low:99,close:100},{time:at('2026-10-12','09:16'),open:100,high:101,low:99,close:100});
const run=orb5Backtest(rows,{startDay:'2026-10-12',endDay:'2026-10-13',now:at('2026-10-14','09:00')*1000});
const result={id:1,strategy:'orb5',startDate:'2026-10-12',endDate:'2026-10-13',oneMinuteBars:8,createdAt:Date.now(),
  metrics:{orb5:true,mode:'directional',settings:run.settings,summary:run.summary,days:run.days,
    trades:run.trades,skippedSignals:[],equityCurve:run.equityCurve,totalPoints:run.summary.net}};

test('Nifty 5-Min ORB form, results, counts and CSV render from a saved run',()=>{
  const ui={strategy:'orb5',startDate:'2026-10-12',endDate:'2026-10-13',range:'custom',result,savedRuns:[result],caps:{optionsData:{available:false,reason:'Connect or reconnect Dhan to open Power Scalper.'}}};
  orbDefaults(ui);
  const view=String(page.view({ui,el:{}}));
  assert.match(view,/<option value="orb5" selected>Nifty 5-Min ORB<\/option>/);
  assert.match(view,/data-orb-field="riskReward" value="2"/);
  assert.match(view,/data-orb-field="maxEntriesPerDay" value="2"/);
  assert.match(view,/data-orb-field="squareOff" value="15:15"/);
  assert.match(view,/Actual options \(₹\) - unavailable<\/option>/,'options mode is disabled with an explanation');
  assert.match(view,/Actual-options mode is unavailable: Connect or reconnect Dhan/);
  assert.match(view,/Underlying directional backtest: CE = long NIFTY, PE = short NIFTY/);
  assert.match(view,/skipped days 1/);
  assert.match(view,/ambiguous trades 1/);
  assert.match(view,/Profit factor/);
  assert.match(view,/data-orb-csv/);
  assert.match(view,/bt-orb-equity/);
  assert.doesNotMatch(view,/data-bt-field="exitLogic"/,'the generic exit controls are replaced');
  const csv=orbCsv(result).split('\n');
  assert.equal(csv[0],'date,direction,signal_time,execution_time,entry,stop,target,exit,exit_time,exit_reason,ambiguous,slippage_points,points,r,result');
  assert.match(csv[1],/^2026-10-13,CE,.*,111,107,119,107,.*,Stop,yes,0,-4,-1,LOSS$/);
});
