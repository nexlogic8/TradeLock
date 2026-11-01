process.env.DB_PATH=':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('backtest history accepts a manual date range and fetches Dhan candles in at most 90-day chunks',async()=>{
  const calls=[];
  const adapter={async intradayCandles(spec){calls.push(spec);return {timestamp:[],open:[],high:[],low:[],close:[],volume:[]};}};
  globalThis.__scalperBacktestRouteTest={accountFor:()=>({status:'connected',broker:'dhan',token_enc:'test'}),adapterFor:()=>adapter};
  const file=new URL('../src/modules/scalper/routes.js',import.meta.url);
  let source=readFileSync(file,'utf8').replace("import { accountFor, adapterFor } from '../broker/registry.js';",'const {accountFor,adapterFor}=globalThis.__scalperBacktestRouteTest;');
  source=source.replace(/from '([^']+)'/g,(_,path)=>`from '${new URL(path,file).href}'`);
  const {scalperRoutes}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const routes=new Map();scalperRoutes({get:(path,fn)=>routes.set(path,fn),post:()=>{}});
  try {
    const result=await routes.get('/api/scalper/backtest-candles')({user:{id:765432},query:{startDate:'2026-01-01',endDate:'2026-07-01'}});
    assert.equal(result.startDate,'2026-01-01');assert.equal(result.endDate,'2026-07-01');
    assert.equal(calls.length,6,'three date chunks are loaded for each timeframe');
    assert.deepEqual(calls.filter(c=>c.interval==='1').map(c=>[c.fromDate.slice(0,10),c.toDate.slice(0,10)]),[
      ['2026-01-01','2026-03-31'],['2026-04-01','2026-06-29'],['2026-06-30','2026-07-01'],
    ]);
    assert.ok(calls.every(c=>c.exchangeSegment==='IDX_I'&&c.securityId==='13'));
    calls.length=0;
    const warmed=await routes.get('/api/scalper/backtest-candles')({user:{id:765432},query:{startDate:'2026-07-06',endDate:'2026-07-07',strategy:'previousDay'}});
    assert.equal(warmed.startDate,'2026-07-06','warmup must preserve the requested result range');
    assert.equal(calls.length,2);
    assert.ok(calls.every(c=>c.fromDate==='2026-06-22 09:00:00'&&c.toDate==='2026-07-07 15:30:00'));
  } finally { delete globalThis.__scalperBacktestRouteTest; }
});

test('backtest history rejects malformed, future, and over-one-year date ranges',async()=>{
  const adapter={async intradayCandles(){assert.fail('invalid ranges must not fetch data');}};
  globalThis.__scalperBacktestRouteTest={accountFor:()=>({status:'connected',broker:'dhan',token_enc:'test'}),adapterFor:()=>adapter};
  const file=new URL('../src/modules/scalper/routes.js',import.meta.url);
  let source=readFileSync(file,'utf8').replace("import { accountFor, adapterFor } from '../broker/registry.js';",'const {accountFor,adapterFor}=globalThis.__scalperBacktestRouteTest;');
  source=source.replace(/from '([^']+)'/g,(_,path)=>`from '${new URL(path,file).href}'`);
  const {scalperRoutes}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const routes=new Map();scalperRoutes({get:(path,fn)=>routes.set(path,fn),post:()=>{}});
  const handler=routes.get('/api/scalper/backtest-candles'),ctx={user:{id:765433}};
  try {
    await assert.rejects(handler({...ctx,query:{startDate:'2026-02-30',endDate:'2026-03-01'}}),/valid start and end dates/);
    await assert.rejects(handler({...ctx,query:{startDate:'2026-10-13',endDate:'2026-10-14'}}),/valid start and end dates/);
    await assert.rejects(handler({...ctx,query:{startDate:'2021-01-01',endDate:'2026-10-13'}}),/last five years/);
  } finally { delete globalThis.__scalperBacktestRouteTest; }
});
