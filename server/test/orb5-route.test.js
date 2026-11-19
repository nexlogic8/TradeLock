process.env.DB_PATH = ':memory:';
// The ORB backtest is for administrators (users get the Gap open 09:15 one): the test users are administrators.
process.env.ADMIN_EMAILS = 'orb1@test.local,orb2@test.local,orb3@test.local,orb4@test.local';
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { readFileSync } = await import('node:fs');
const { stmt } = await import('../src/db/index.js');

const at=hhmm=>Date.parse(`2026-10-13T${hhmm}:00+05:30`)/1000;
// 09:15-09:19 range 110/95; 09:20 closes 111 (CE signal, low 107); 09:21 opens 111 (entry, target 111 + 2×4 = 119); 09:22 reaches 120.
const bars=[['09:15',100,104,98,102],['09:16',102,103,95,101],['09:17',101,110,100,104],['09:18',104,106,101,103],['09:19',103,105,100,104],
  ['09:20',108,112,107,111],['09:21',111,113,110.5,112],['09:22',112,120,111.5,119.5],['09:23',119.5,120,118,119]];
const dhan=rows=>({timestamp:rows.map(r=>at(r[0])),open:rows.map(r=>r[1]),high:rows.map(r=>r[2]),low:rows.map(r=>r[3]),close:rows.map(r=>r[4]),volume:rows.map(()=>0)});

async function harness(adapter) {
  const state=globalThis.__orbRouteTest={connected:true,adapterFor:()=>adapter,
    accountFor:()=>state.connected?{status:'connected',broker:'dhan',token_enc:'test'}:null};
  const file=new URL('../src/modules/scalper/routes.js',import.meta.url);
  let source=readFileSync(file,'utf8').replace("import { accountFor, adapterFor } from '../broker/registry.js';",'const {accountFor,adapterFor}=globalThis.__orbRouteTest;');
  source=`// orb5 route test ${Math.random()}\n${source.replace(/from '([^']+)'/g,(_,path)=>`from '${new URL(path,file).href}'`)}`;
  const {scalperRoutes}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const routes=new Map();
  scalperRoutes({get:(path,fn)=>routes.set(`GET ${path}`,fn),post:(path,fn)=>routes.set(`POST ${path}`,fn),put:(path,fn)=>routes.set(`PUT ${path}`,fn)});
  return routes;
}
// One user per test: the save route allows 6 runs a minute per user.
const newUser=email=>Number(stmt('INSERT INTO users (email,password_hash,name,created_at) VALUES (?,?,?,?)').run(email,'x','ORB',1).lastInsertRowid);
const userId=newUser('orb1@test.local');
const body={strategy:'orb5',startDate:'2026-10-13',endDate:'2026-10-13',mode:'directional',riskReward:2,maxEntriesPerDay:2,squareOff:'15:15'};

test('ORB settings are validated before any history is loaded',async()=>{
  const routes=await harness({async intradayCandles(){assert.fail('invalid settings must not fetch data');}});
  const run=extra=>routes.get('POST /api/scalper/backtest-runs')({user:{id:userId,email:'orb1@test.local'},body:{...body,...extra}});
  await assert.rejects(run({squareOff:'09:10'}),/Square-off time/);
  await assert.rejects(run({riskReward:0}),/Risk-reward/);
  await assert.rejects(run({maxEntriesPerDay:1.5}),/Maximum entries/);
  await assert.rejects(run({mode:'options',options:{expiry:'W9'}}),/supported expiry/);
  await assert.rejects(run({mode:'options',startDate:'2026-08-01'}),/up to 60 days/);
  delete globalThis.__orbRouteTest;
});

test('a directional ORB run is saved with its trades, days and chart candles',async()=>{
  const userId=newUser('orb2@test.local');
  const routes=await harness({async intradayCandles(){ return dhan(bars); }});
  const run=await routes.get('POST /api/scalper/backtest-runs')({user:{id:userId,email:'orb1@test.local'},body});
  assert.equal(run.strategy,'orb5');
  const {metrics}=run;
  assert.equal(metrics.mode,'directional');
  assert.deepEqual(metrics.days.map(d=>[d.day,d.rangeHigh,d.rangeLow,d.trades]),[['2026-10-13',110,95,1]]);
  const [trade]=metrics.trades;
  assert.deepEqual([trade.direction,trade.entry,trade.stop,trade.target,trade.exit,trade.exitReason,trade.r],['CE',111,107,119,119,'Target',2]);
  assert.equal(metrics.summary.net,8);
  const chart=await routes.get('GET /api/scalper/backtest-runs/:id/chart')({user:{id:userId,email:'orb1@test.local'},params:{id:String(run.id)},query:{tradeIndex:'0'}});
  assert.equal(chart.day,'2026-10-13');
  assert.equal(chart.candles.length,bars.length);
  assert.equal(chart.trade.rangeHigh,110);
  delete globalThis.__orbRouteTest;
});

test('actual-options mode prices the NIFTY trade with the selected contract premiums',async()=>{
  const userId=newUser('orb3@test.local');
  const premium=(hhmm,o,c,strike=23500)=>({time:at(hhmm),open:o,high:Math.max(o,c)+1,low:Math.min(o,c)-1,close:c,strike});
  const adapter={
    async intradayCandles(){ return dhan(bars); },
    async rollingOption({strike,option,expiryFlag,expiryCode}){
      assert.deepEqual([option,expiryFlag,expiryCode],['CE','WEEK',1]);
      return strike==='ATM'?[premium('09:20',100,101),premium('09:21',102,104),premium('09:22',104,121)]:[];
    },
  };
  const routes=await harness(adapter);
  const run=await routes.get('POST /api/scalper/backtest-runs')({user:{id:userId,email:'orb1@test.local'},body:{...body,mode:'options',options:{expiry:'W1',moneyness:0,lots:1,brokeragePerOrder:20,slippagePerUnit:0,statutoryCharges:false}}});
  const o=run.metrics.trades[0].option;
  assert.deepEqual([o.strike,o.entry,o.exit,o.exitPriceFrom],[23500,102,121,'close'],'buy at the 09:21 open, sell at the 09:22 close when NIFTY hit the target');
  assert.equal(o.pnl,(121-102)*65-40);
  assert.equal(run.metrics.optionSummary.net,o.pnl);
  const caps=await routes.get('GET /api/scalper/backtest-capabilities')({user:{id:userId,email:'orb1@test.local'}});
  assert.equal(caps.optionsData.available,true,'option candles were returned');
  globalThis.__orbRouteTest.connected=false;
  const offline=await routes.get('GET /api/scalper/backtest-capabilities')({user:{id:userId,email:'orb1@test.local'}});
  assert.equal(offline.optionsData.available,false);
  assert.match(offline.optionsData.reason,/Connect or reconnect Dhan/);
  delete globalThis.__orbRouteTest;
});
