process.env.DB_PATH = ':memory:';
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { readFileSync } = await import('node:fs');
const { resolveNiftyExpiry } = await import('../src/modules/scalper/expiry.js');
const { underlyingFor, isIndexId } = await import('../src/modules/scalper/underlyings.js');

// Instrument master stub: SENSEX options on BSE reuse a numeric id that also exists on NSE.
globalThis.fetch = async () => new Response(['EXCH_ID,SECURITY_ID,INSTRUMENT,UNDERLYING_SYMBOL,LOT_SIZE,TICK_SIZE,SM_EXPIRY_DATE',
  'NSE,7001,OPTIDX,NIFTY,65,5,', 'BSE,7001,OPTIDX,SENSEX,20,5,', 'BSE,7002,OPTIDX,SENSEX,20,5,', 'NSE,8001,OPTIDX,BANKNIFTY,30,5,',
  // MCX: an expired and a live CRUDEOILM future, and one of its options (Dhan's lot size 1: quantity in lots).
  'MCX,500001,FUTCOM,CRUDEOILM,1,100,2020-01-17', 'MCX,573423,FUTCOM,CRUDEOILM,1,100,2099-01-19', 'MCX,586215,OPTFUT,CRUDEOILM,1,5,2099-01-15'].join('\n'));

test('index definitions and default expiry per index',()=>{
  assert.deepEqual([underlyingFor('sensex').securityId,underlyingFor('SENSEX').optionSegment],['51','BSE_FNO']);
  assert.deepEqual([underlyingFor('BANKNIFTY').securityId,underlyingFor('BANKNIFTY').optionSegment],['25','NSE_FNO']);
  assert.equal(underlyingFor('unknown').key,'NIFTY');
  assert.ok(isIndexId('13') && isIndexId('25') && isIndexId('51') && !isIndexId('7001'));
  const monday={day:'2026-10-19',minutes:600,weekday:'Mon'}, list=['2026-10-20','2026-10-27'];
  assert.equal(resolveNiftyExpiry(undefined,list,monday,'weekday'),'2026-10-27','NIFTY: 2nd expiry on Monday');
  assert.equal(resolveNiftyExpiry(undefined,list,monday,'nearest'),'2026-10-20','BANKNIFTY/SENSEX: nearest');
});

test('SENSEX chain loads from Dhan index 51 with BSE contracts and the BSE lot size',async t=>{
  // The fixtures' expiries are in late October 2026: the clock is that Monday, so they are still upcoming.
  const realNow=Date.now; t.mock.method(Date,'now',()=>Date.parse('2026-10-19T10:00:00+05:30')+(realNow()%1000));
  const calls=[];
  const adapter={
    async optionExpiries(args){ calls.push(['expiries',args.underlyingScrip]); return ['2026-10-22','2026-10-29']; },
    async optionChain(args){ calls.push(['chain',args.underlyingScrip,args.expiry]);
      return {last_price:72957.94,oc:{'72900.000000':{ce:{security_id:7002,last_price:180},pe:{security_id:7003,last_price:120}},'73000.000000':{ce:{security_id:7001,last_price:145.7},pe:{security_id:7004,last_price:190}}}}; },
    async intradayCandles(spec){ calls.push(['candles',spec.securityId,spec.exchangeSegment]); return {timestamp:[Date.now()/1000-120],open:[1],high:[2],low:[0.5],close:[1.5],volume:[0]}; },
  };
  globalThis.__underlyingRouteTest={accountFor:()=>({status:'connected',broker:'dhan',token_enc:'t'}),adapterFor:()=>adapter};
  const file=new URL('../src/modules/scalper/routes.js',import.meta.url);
  let source=readFileSync(file,'utf8').replace("import { accountFor, adapterFor } from '../broker/registry.js';",'const {accountFor,adapterFor}=globalThis.__underlyingRouteTest;');
  source=`// underlying route test\n${source.replace(/from '([^']+)'/g,(_,path)=>`from '${new URL(path,file).href}'`)}`;
  const {scalperRoutes}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const routes=new Map(); scalperRoutes({get:(path,fn)=>routes.set(path,fn),post:()=>{},put:()=>{}});
  try {
    const data=await routes.get('/api/scalper')({user:{id:4242},query:{underlying:'SENSEX',interval:'5'}});
    assert.deepEqual(calls.filter(c=>c[0]!=='candles').map(c=>c.slice(0,2)),[['expiries',51],['chain',51]]);
    assert.deepEqual([data.underlyingKey,data.optionSegment,data.underlying.symbol,data.underlying.securityId],['SENSEX','BSE_FNO','SENSEX','51']);
    assert.equal(data.expiry,'2026-10-22','nearest expiry for SENSEX');
    const atm=data.strikes.find(r=>r.strike===73000);
    assert.deepEqual([atm.ce.exchangeSegment,atm.ce.symbol],['BSE_FNO','SENSEX 2026-10-22 73000 CE']);
    assert.equal(data.lotSize,20,'BSE:7001 is the SENSEX contract, not NSE:7001 (NIFTY, 65)');
    assert.ok(calls.some(c=>c[0]==='candles'&&c[1]==='51'&&c[2]==='IDX_I'),'SENSEX index candles');
    assert.ok(calls.some(c=>c[0]==='candles'&&c[1]==='7001'&&c[2]==='BSE_FNO'),'option candles from BSE');
    // Candles for that chain's index and its options are allowed; option segment follows the chain.
    calls.length=0;
    await routes.get('/api/scalper/candles')({user:{id:4242},query:{securityId:'7002',interval:'1'}});
    assert.deepEqual(calls.at(-1)?.slice(1),['7002','BSE_FNO']);
  } finally { delete globalThis.__underlyingRouteTest; }
});

test('a Dhan 5xx outage serves the last good chain (marked stale) instead of failing the page',async t=>{
  // The fixtures' expiries are in late October 2026: the clock is that Monday, so they are still upcoming.
  const realNow=Date.now; t.mock.method(Date,'now',()=>Date.parse('2026-10-19T10:00:00+05:30')+(realNow()%1000));
  let down=false, chainCalls=0;
  const fail=()=>Object.assign(new Error('Dhan returned HTTP 500'),{code:'BROKER'});
  const adapter={
    async optionExpiries(){ if(down) throw fail(); return ['2026-10-20','2026-10-27']; },
    async optionChain(){ chainCalls++; if(down) throw fail(); return {last_price:22500,oc:{'22500.000000':{ce:{security_id:9001,last_price:100},pe:{security_id:9002,last_price:90}}}}; },
    async intradayCandles(){ return {timestamp:[],open:[],high:[],low:[],close:[],volume:[]}; },
  };
  globalThis.__underlyingRouteTest={accountFor:()=>({status:'connected',broker:'dhan',token_enc:'t'}),adapterFor:()=>adapter};
  const file=new URL('../src/modules/scalper/routes.js',import.meta.url);
  let source=readFileSync(file,'utf8').replace("import { accountFor, adapterFor } from '../broker/registry.js';",'const {accountFor,adapterFor}=globalThis.__underlyingRouteTest;');
  source=`// stale chain test\n${source.replace(/from '([^']+)'/g,(_,path)=>`from '${new URL(path,file).href}'`)}`;
  const {scalperRoutes}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const routes=new Map(); scalperRoutes({get:(path,fn)=>routes.set(path,fn),post:()=>{},put:()=>{}});
  try {
    const ok=await routes.get('/api/scalper')({user:{id:5151},query:{charts:'0',expiry:'2026-10-20'}});
    assert.equal(ok.stale,false);
    down=true;
    const before=chainCalls;
    const stale=await routes.get('/api/scalper')({user:{id:5151},query:{charts:'0',expiry:'2026-10-20',fresh:'1'}});
    assert.equal(chainCalls-before,3,'retried twice before falling back');
    assert.equal(stale.stale,true);
    assert.equal(stale.strikes[0].ce.securityId,'9001');
    assert.match(stale.historyWarning,/Dhan is not responding right now/);
    // A user with no earlier snapshot still gets the error.
    await assert.rejects(routes.get('/api/scalper')({user:{id:5152},query:{charts:'0'}}),/Dhan could not provide market data/);
  } finally { delete globalThis.__underlyingRouteTest; }
});

test('preloaded indices stay valid together; the named index picks NSE or BSE for a shared id',async t=>{
  // The fixtures' expiries are in late October 2026: the clock is that Monday, so they are still upcoming.
  const realNow=Date.now; t.mock.method(Date,'now',()=>Date.parse('2026-10-19T10:00:00+05:30')+(realNow()%1000));
  const calls=[];
  const adapter={
    async optionExpiries({underlyingScrip}){ return underlyingScrip===51?['2026-10-22']:['2026-10-20','2026-10-27']; },
    async optionChain({underlyingScrip}){ return {last_price:underlyingScrip===51?73000:22500,oc:{[underlyingScrip===51?'73000.000000':'22500.000000']:{ce:{security_id:7001,last_price:100},pe:{security_id:underlyingScrip===51?7004:7005,last_price:90}}}}; },
    async intradayCandles(spec){ calls.push([spec.securityId,spec.exchangeSegment]); return {timestamp:[],open:[],high:[],low:[],close:[],volume:[]}; },
  };
  globalThis.__underlyingRouteTest={accountFor:()=>({status:'connected',broker:'dhan',token_enc:'t'}),adapterFor:()=>adapter};
  const file=new URL('../src/modules/scalper/routes.js',import.meta.url);
  let source=readFileSync(file,'utf8').replace("import { accountFor, adapterFor } from '../broker/registry.js';",'const {accountFor,adapterFor}=globalThis.__underlyingRouteTest;');
  source=`// preload test\n${source.replace(/from '([^']+)'/g,(_,path)=>`from '${new URL(path,file).href}'`)}`;
  const {scalperRoutes}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const routes=new Map(); scalperRoutes({get:(path,fn)=>routes.set(path,fn),post:()=>{},put:()=>{}});
  try {
    await routes.get('/api/scalper')({user:{id:6161},query:{charts:'0',underlying:'NIFTY'}});
    await routes.get('/api/scalper')({user:{id:6161},query:{charts:'0',underlying:'SENSEX'}});
    // NIFTY's own contract is still allowed after SENSEX was (pre)loaded.
    await routes.get('/api/scalper/candles')({user:{id:6161},query:{securityId:'7005',interval:'1'}});
    assert.deepEqual(calls.at(-1),['7005','NSE_FNO']);
    await routes.get('/api/scalper/candles')({user:{id:6161},query:{securityId:'7001',interval:'1',underlying:'SENSEX'}});
    assert.deepEqual(calls.at(-1),['7001','BSE_FNO']);
    await routes.get('/api/scalper/candles')({user:{id:6161},query:{securityId:'7001',interval:'1',underlying:'NIFTY'}});
    assert.deepEqual(calls.at(-1),['7001','NSE_FNO']);
    await assert.rejects(routes.get('/api/scalper/candles')({user:{id:6161},query:{securityId:'7004',interval:'1',underlying:'NIFTY'}}),/Reload the option chain/);
  } finally { delete globalThis.__underlyingRouteTest; }
});

test('MCX: CRUDEOILM chain sits on its live near-month future (MCX_COMM); lots are Dhan units, ×10 rupees per point',async()=>{
  const calls=[];
  const adapter={
    async optionExpiries(args){ calls.push(['expiries',args.underlyingScrip,args.underlyingSeg]); return ['2099-01-15','2099-02-16']; },
    async optionChain(args){ calls.push(['chain',args.underlyingScrip,args.underlyingSeg,args.expiry]);
      return {last_price:8321,oc:{'8300.000000':{ce:{security_id:586215,last_price:507.95},pe:{security_id:586216,last_price:480}}}}; },
    async intradayCandles(spec){ calls.push(['candles',spec.securityId,spec.exchangeSegment,spec.instrument]); return {timestamp:[],open:[],high:[],low:[],close:[],volume:[]}; },
    async marginRequired(spec){ calls.push(['margin',spec.qty,spec.exchangeSegment]); return {total:spec.qty*spec.price*10,available:100000}; },
  };
  globalThis.__underlyingRouteTest={accountFor:()=>({status:'connected',broker:'dhan',token_enc:'t'}),adapterFor:()=>adapter};
  const file=new URL('../src/modules/scalper/routes.js',import.meta.url);
  let source=readFileSync(file,'utf8').replace("import { accountFor, adapterFor } from '../broker/registry.js';",'const {accountFor,adapterFor}=globalThis.__underlyingRouteTest;');
  source=`// mcx test\n${source.replace(/from '([^']+)'/g,(_,path)=>`from '${new URL(path,file).href}'`)}`;
  const {scalperRoutes}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const routes=new Map(); scalperRoutes({get:(path,fn)=>routes.set(path,fn),post:()=>{},put:()=>{}});
  try {
    const data=await routes.get('/api/scalper')({user:{id:7171},query:{underlying:'CRUDEOILM',interval:'5'}});
    assert.deepEqual(calls.filter(c=>c[0]==='expiries'||c[0]==='chain').map(c=>c.slice(0,3)),[['expiries',573423,'MCX_COMM'],['chain',573423,'MCX_COMM']],'the live future, not the expired one');
    assert.deepEqual([data.underlyingKey,data.optionSegment,data.underlying.securityId,data.underlying.exchangeSegment,data.mcx],['CRUDEOILM','MCX_COMM','573423','MCX_COMM',true]);
    assert.deepEqual([data.lotSize,data.qtyPerLot],[10,1]);
    assert.deepEqual(data.session,{open:540,close:1435});
    const ce=data.strikes[0].ce;
    assert.deepEqual([ce.exchangeSegment,ce.symbol],['MCX_COMM','CRUDEOILM 2099-01-15 8300 CE']);
    assert.ok(calls.some(c=>c[0]==='candles'&&c[1]==='573423'&&c[2]==='MCX_COMM'&&c[3]==='FUTCOM'),'future chart');
    assert.ok(calls.some(c=>c[0]==='candles'&&c[1]==='586215'&&c[3]==='OPTFUT'),'option chart');
    calls.length=0;
    await routes.get('/api/scalper/candles')({user:{id:7171},query:{securityId:'573423',interval:'1',underlying:'CRUDEOILM'}});
    assert.deepEqual(calls.at(-1).slice(1),['573423','MCX_COMM','FUTCOM']);
    const m=await routes.get('/api/scalper/margin')({user:{id:7171},query:{securityId:'586215',lots:'3',price:'507.95',underlying:'CRUDEOILM'}});
    assert.deepEqual([m.qty,m.lotSize,calls.at(-1)[1]],[3,10,3],'3 lots = Dhan quantity 3');
    assert.equal(m.buy,15238.5);
  } finally { delete globalThis.__underlyingRouteTest; }
});
