process.env.DB_PATH = ':memory:';
process.env.OPENAI_API_KEY = 'test-no-network';
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { stmt } = await import('../src/db/index.js');
const { patchDay } = await import('../src/modules/risk/service.js');
const { setBook, setKillStatus } = await import('../src/modules/broker/book.js');
const { scanScalperSignal } = await import('../src/modules/scalper/signals.js');

test('signal scan compares expiries, validates AI selection, rechecks risk and never places orders', async () => {
  const originalNow = Date.now, originalFetch = globalThis.fetch;
  let now = Date.parse('2026-10-13T09:31:00+05:30');
  Date.now = () => now;
  const id = Number(stmt('INSERT INTO users (email,password_hash,name,created_at) VALUES (?,?,?,?)').run('signal@test.local','unused','Test',now).lastInsertRowid);
  patchDay(id,'2026-10-13',{capital:229428,realized:0,unrealized:0,entries:0,paused:0});
  setBook(id,{positions:[],orders:[],funds:{available:229428},at:now});
  const todayExpiry = '2026-10-13';
  const expiries = ['2026-10-15','2026-10-22','2026-10-29'];
  const allExpiries = [todayExpiry,...expiries];
  const csv = 'EXCH_ID,INSTRUMENT,UNDERLYING_SYMBOL,SECURITY_ID,LOT_SIZE,TICK_SIZE,SM_EXPIRY_DATE,STRIKE_PRICE,OPTION_TYPE\n'
    + allExpiries.map((e,i)=>`NSE,OPTIDX,NIFTY,${100+i},50,0.05,${e},22500,CE`).join('\n');
  let chosenExpiry = expiries[1], lockDuringAI = false, noTradeStale = false, noStructuredStale = false, staleQuote = false, seenSnapshot, aiCalls = 0, moved = false, calls = 0;
  globalThis.fetch = async (url,options) => {
    if (String(url).includes('api-scrip-master-detailed.csv')) return new Response(csv);
    assert.equal(url,'https://api.openai.com/v1/responses');
    aiCalls++;
    seenSnapshot = JSON.parse(JSON.parse(options.body).input).snapshot;
    if (lockDuringAI) setKillStatus(id,{active:true});
    if (noStructuredStale && seenSnapshot.openingRange?.stale) return Response.json({output:[]});
    const action = noTradeStale && seenSnapshot.openingRange?.stale ? 'NO_TRADE' : 'BUY_CE';
    return Response.json({output:[{content:[{type:'output_text',text:JSON.stringify({action,strike:22500,expiry:chosenExpiry,confidence:.9,rationale:'Historical breakout is stale and risk is exhausted.'})}]}]});
  };
  const open = Date.parse('2026-10-13T09:15:00+05:30');
  const optionCandles = [120,110,100,111,115,116,117,118,119,120,121,122,123,124,125,126]
    .map((low,i)=>({time:open+i*60_000,low,high:130,open:i===15?126:125,close:126}));
  // 09:29 closes above the 22450 range high (breakout candle); 09:30 breaks its 22550 high (confirmation).
  const spotOne = [...Array.from({length:15},(_,i)=>({time:open+i*60_000,low:22400,high:i<5?22450:22550,open:22420,
    close:i===14?22510:22430})), {time:open+15*60_000,low:22500,high:22560,open:22510,close:22540}];
  const spotFive = Array.from({length:4},(_,i)=>({time:open+i*300_000,low:i===0?22400:22420,high:i===0?22450:22520,open:22420,close:i===3?22500:22430}));
  const deps = { optionRequest:fn=>fn(), normalizeCandles:x=>x, adapter:{
    optionExpiries:async()=>[expiries[2],todayExpiry,expiries[0],expiries[1]],
    optionChain:async({expiry})=>{
      calls++;
      const ask = moved && calls===3 || staleQuote ? 130 : 125;
      return {last_price:22500,oc:{'22500.000000':{ce:{security_id:100+allExpiries.indexOf(expiry),top_bid_price:ask-.05,top_ask_price:ask,volume:1000,oi:100}}}};
    },
    intradayCandles:async({securityId,interval})=>securityId==='13' ? interval==='5' ? spotFive : spotOne : optionCandles,
    placeOrder:()=>assert.fail('Signal analysis must never place an order'),
  }};
  try {
    const result = await scanScalperSignal(id,'test',deps);
    assert.equal(result.action,'BUY_CE');
    assert.equal(result.contract.expiry,expiries[1]);
    assert.notEqual(result.contract.expiry,todayExpiry);
    assert.equal(result.contract.stop,99.95);
    assert.equal(result.contract.quantity,150);
    assert.equal(result.contract.risk,3757.5);
    assert.equal(result.contract.capitalRequired,18750);
    assert.equal(result.brokerOrderPlaced,false);
    assert.deepEqual(result.expiriesScanned,expiries.slice(0,2));
    assert.equal(seenSnapshot.candidates.length,2);
    // A scan after the first breakout still returns a historical contract review,
    // clearly blocked, with estimated sizing even when the daily loss cap is spent.
    now = Date.parse('2026-10-13T10:30:00+05:30');
    noStructuredStale = true;
    staleQuote = true;
    patchDay(id,'2026-10-13',{capital:229428,realized:-12000,unrealized:0,entries:0,paused:0});
    setBook(id,{positions:[],orders:[],funds:{available:229428},at:now});
    const historical = await scanScalperSignal(id,'test',deps);
    assert.equal(historical.action,'BUY_CE');
    assert.equal(historical.setup.stale,true);
    assert.equal(historical.contract.entryAllowed,false);
    assert.match(historical.contract.blockReason,/historical/i);
    assert.equal(historical.contract.entry,126);
    assert.equal(historical.contract.currentAsk,130);
    assert.equal(historical.contract.entryTime,Date.parse('2026-10-13T09:30:00+05:30'));
    assert.equal(historical.contract.quantity,100);
    assert.equal(historical.contract.capitalRequired,12600);
    assert.match(historical.rationale,/no usable structured decision/);
    noStructuredStale = false;
    noTradeStale = true;
    const modelNoTrade = await scanScalperSignal(id,'test',deps);
    assert.equal(modelNoTrade.action,'BUY_CE');
    assert.equal(modelNoTrade.contract.entryAllowed,false);
    assert.match(modelNoTrade.rationale,/AI declined a live entry/);
    noTradeStale = false;
    staleQuote = false;
    now = Date.parse('2026-10-13T09:31:00+05:30');
    patchDay(id,'2026-10-13',{capital:229428,realized:0,unrealized:0,entries:0,paused:0});
    setBook(id,{positions:[],orders:[],funds:{available:229428},at:now});
    chosenExpiry = '2099-01-01';
    assert.equal((await scanScalperSignal(id,'test',deps)).action,'NO_TRADE');
    chosenExpiry = expiries[1]; calls = 0; moved = true;
    assert.match((await scanScalperSignal(id,'test',deps)).rationale,/price moved/);
    moved = false; lockDuringAI = true;
    assert.match((await scanScalperSignal(id,'test',deps)).rationale,/locked/);
    assert.equal((await scanScalperSignal(id,'test',deps)).action,'NO_TRADE');
  } finally { Date.now = originalNow; globalThis.fetch = originalFetch; }
});
