process.env.DB_PATH = ':memory:';
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { readFileSync } = await import('node:fs');
// Instrument master stub (the route caches it, so every test sees the same list). No network in tests.
const INSTRUMENTS=['EXCH_ID,SECURITY_ID,INSTRUMENT,UNDERLYING_SYMBOL,LOT_SIZE,TICK_SIZE',
  ...['101','102','301','302','401','402'].map(id=>`NSE,${id},OPTIDX,NIFTY,65,5`)].join('\n');
globalThis.fetch = async () => new Response(INSTRUMENTS);

test('Scalper routes reuse histories and chain, refresh explicitly, and check connection before cache access', async () => {
  let connected = true, calls = [];
  const today=new Date(Date.now()+330*60_000).toISOString().slice(0,10);
  const priorExpiry=new Date(Date.parse(`${today}T00:00:00Z`)-86_400_000).toISOString().slice(0,10);
  const nextExpiry=new Date(Date.parse(`${today}T00:00:00Z`)+86_400_000).toISOString().slice(0,10);
  const adapter = {
    async optionExpiries() { calls.push('expiries'); return [nextExpiry,priorExpiry]; },
    async optionChain() { calls.push('chain'); return {last_price:22500,oc:{22500:{ce:{security_id:'101',last_price:100},pe:{security_id:'102',last_price:110}}}}; },
    async intradayCandles(spec) { calls.push(`chart:${spec.securityId}:${spec.interval}`); return {timestamp:[Date.now()],open:[100],high:[110],low:[90],close:[105],volume:[10]}; },
  };
  globalThis.__scalperRouteTest = {accountFor:()=>connected ? {status:'connected',broker:'dhan',token_enc:'test'} : null,adapterFor:()=>adapter};
  const file = new URL('../src/modules/scalper/routes.js', import.meta.url);
  let source = readFileSync(file,'utf8').replace("import { accountFor, adapterFor } from '../broker/registry.js';",'const { accountFor, adapterFor } = globalThis.__scalperRouteTest;');
  source = source.replace(/from '([^']+)'/g,(_,path)=>`from '${new URL(path,file).href}'`);
  const {scalperRoutes} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const routes = new Map();
  scalperRoutes({get:(path,fn)=>routes.set(path,fn),post:()=>{},put:()=>{}});
  const page = routes.get('/api/scalper'), chart = routes.get('/api/scalper/candles');
  const ctx = {user:{id:91234},query:{interval:'5'}};
  try {
    const cold = await page(ctx);
    assert.equal(cold.expiry,nextExpiry,'default chain selects the nearest active expiry, not Dhan’s first (possibly stale) item');
    assert.deepEqual(cold.expiries,[nextExpiry]);
    assert.equal(calls.length,5);
    assert.equal(calls[0],'chart:13:5','Index history starts without waiting for the expiry list');
    const warm = await page(ctx);
    assert.equal(calls.length,5,'Warm load makes no Dhan requests');
    assert.equal(warm.asOf,cold.asOf,'Cache does not relabel an old quote as newly fetched');
    const expiredSelection=await page({...ctx,query:{interval:'5',expiry:priorExpiry}});
    assert.equal(expiredSelection.expiry,nextExpiry,'a stale open page rolls forward to the next active expiry');
    const switched = await chart({...ctx,query:{securityId:'101',interval:'5'}});
    assert.equal(switched.asOf,cold.historyAsOf.ce);
    assert.equal(calls.length,5,'Chart selection shares initial page history cache');
    await page({...ctx,query:{interval:'5',fresh:'1'}});
    assert.equal(calls.length,9,'Explicit refresh fetches chain and three histories, reuses expiry metadata');
    await page({...ctx,query:{interval:'15'}});
    assert.equal(calls.length,12,'Changing interval only fetches the three new histories');
    connected = false;
    await assert.rejects(page(ctx),/reconnect Dhan/);
    assert.equal(calls.length,12);
  } finally { delete globalThis.__scalperRouteTest; }
});

test('Scalper page still loads the chain when one chart history fails, and charts=0 skips histories', async () => {
  const calls = [];
  const today=new Date(Date.now()+330*60_000).toISOString().slice(0,10);
  const expiry=new Date(Date.parse(`${today}T00:00:00Z`)+86_400_000).toISOString().slice(0,10);
  const adapter = {
    async optionExpiries() { return [expiry]; },
    async optionChain() { return {last_price:22500,oc:{22500:{ce:{security_id:'301',last_price:100},pe:{security_id:'302',last_price:110}}}}; },
    async intradayCandles(spec) {
      calls.push(spec.securityId);
      if (spec.securityId === '301') { const e = new Error('Dhan did not respond within 10 seconds'); e.code = 'NETWORK'; throw e; }
      return {timestamp:[Date.now()],open:[100],high:[110],low:[90],close:[105],volume:[10]};
    },
  };
  globalThis.__scalperRouteTest = {accountFor:()=>({status:'connected',broker:'dhan',token_enc:'test'}),adapterFor:()=>adapter};
  const file = new URL('../src/modules/scalper/routes.js', import.meta.url);
  let source = readFileSync(file,'utf8').replace("import { accountFor, adapterFor } from '../broker/registry.js';",'const { accountFor, adapterFor } = globalThis.__scalperRouteTest;');
  source = `// partial-history test
${source}`;
  source = source.replace(/from '([^']+)'/g,(_,path)=>`from '${new URL(path,file).href}'`);
  const {scalperRoutes} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const routes = new Map();
  scalperRoutes({get:(path,fn)=>routes.set(path,fn),post:()=>{},put:()=>{}});
  const page = routes.get('/api/scalper');
  const warn = console.warn; console.warn = () => {};
  try {
    const chainOnly = await page({user:{id:91235},query:{interval:'5',charts:'0'}});
    assert.equal(chainOnly.strikes.length,1);
    assert.equal(calls.length,0,'charts=0 returns the chain without candle history');
    const loaded = await page({user:{id:91235},query:{interval:'5'}});
    assert.equal(loaded.strikes.length,1);
    assert.deepEqual(loaded.selectedCharts.ce,[]);
    assert.equal(loaded.selectedCharts.pe.length,1);
    assert.match(loaded.historyWarning,/retry automatically/);
    assert.equal(calls.filter(id=>id==='301').length,3,'a transient failure is retried twice');
  } finally { console.warn = warn; delete globalThis.__scalperRouteTest; }
});

test('Scalper margin route sizes lots into units and returns Dhan buy and sell funds', async () => {
  const today=new Date(Date.now()+330*60_000).toISOString().slice(0,10);
  const expiry=new Date(Date.parse(`${today}T00:00:00Z`)+86_400_000).toISOString().slice(0,10);
  const asked=[];
  const adapter = {
    async optionExpiries() { return [expiry]; },
    async optionChain() { return {last_price:22500,oc:{22500:{ce:{security_id:'401',last_price:100},pe:{security_id:'402',last_price:110}}}}; },
    async intradayCandles() { return {timestamp:[Date.now()],open:[100],high:[110],low:[90],close:[105],volume:[10]}; },
    async marginRequired(spec) { asked.push(spec); return { total: spec.side==='BUY' ? spec.qty*spec.price : 150000, available: 200000 }; },
  };
  globalThis.__scalperRouteTest = {accountFor:()=>({status:'connected',broker:'dhan',token_enc:'test'}),adapterFor:()=>adapter};
  const file = new URL('../src/modules/scalper/routes.js', import.meta.url);
  let source = readFileSync(file,'utf8').replace("import { accountFor, adapterFor } from '../broker/registry.js';",'const { accountFor, adapterFor } = globalThis.__scalperRouteTest;');
  source = `// margin test\n${source.replace(/from '([^']+)'/g,(_,path)=>`from '${new URL(path,file).href}'`)}`;
  const {scalperRoutes} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const routes = new Map();
  scalperRoutes({get:(path,fn)=>routes.set(path,fn),post:()=>{},put:()=>{}});
  const user = {id:91236};
  try {
    await assert.rejects(routes.get('/api/scalper/margin')({user,query:{securityId:'401',lots:'1',price:'100'}}),/Reload the option chain/);
    const chain = await routes.get('/api/scalper')({user,query:{interval:'5',charts:'0'}});
    assert.equal(chain.lotSize,65,'the page learns the lot size with the chain');
    await assert.rejects(routes.get('/api/scalper/margin')({user,query:{securityId:'401',lots:'1.5',price:'100'}}),/whole number of lots/);
    assert.equal(asked.length,0,'invalid lots never reach Dhan');
    const ok = await routes.get('/api/scalper/margin')({user,query:{securityId:'401',lots:'2',price:'100'}});
    assert.deepEqual({qty:ok.qty,buy:ok.buy,sell:ok.sell,available:ok.available,lotSize:ok.lotSize},{qty:130,buy:13000,sell:150000,available:200000,lotSize:65});
    assert.deepEqual(asked.map(x=>x.side).sort(),['BUY','SELL']);
  } finally { delete globalThis.__scalperRouteTest; }
});
