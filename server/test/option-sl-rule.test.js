process.env.DB_PATH = ':memory:';
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { DEFAULT_RULES, loosens, normalizeRules } = await import('../src/modules/rules/service.js');
const { autoSize } = await import('../../web/js/pages/scalper.js');

const base = () => JSON.parse(JSON.stringify(DEFAULT_RULES));

test('option SL room defaults to 20% on and is validated',()=>{
  const { optionSl } = normalizeRules(base());
  assert.deepEqual(optionSl,{on:true,value:20});
  const older = base(); delete older.optionSl;
  assert.deepEqual(normalizeRules(older).optionSl,{on:true,value:20},'saved rules from before this setting get the default');
  assert.throws(()=>normalizeRules({...base(),optionSl:{on:true,value:0}}),/Option SL room/);
  assert.throws(()=>normalizeRules({...base(),optionSl:{on:true,value:95}}),/Option SL room/);
});

test('a tighter option SL (more lots) loosens; a wider one tightens',()=>{
  const cur = normalizeRules(base());
  assert.equal(loosens(cur,normalizeRules({...base(),optionSl:{on:true,value:15}}),200000),true);
  assert.equal(loosens(cur,normalizeRules({...base(),optionSl:{on:true,value:25}}),200000),false);
  assert.equal(loosens(cur,normalizeRules({...base(),optionSl:{on:false,value:20}}),200000),false,'turning sizing off only blocks orders');
  const off = normalizeRules({...base(),optionSl:{on:false,value:20}});
  assert.equal(loosens(off,cur,200000),true,'turning it back on allows orders again');
});

test('Power Scalper sizes lots from the rule percentage',()=>{
  const budget = {perTrade:3628.09,available:3628.09,trades:3,dailyPct:5};
  const item = {ltp:100};
  assert.equal(autoSize(item,65,{budget,optionSlPct:20}).lots,2,'₹20 × 65 = ₹1,300 a lot');
  const wide = autoSize(item,65,{budget,optionSlPct:25});
  assert.deepEqual([wide.lots,wide.sl,wide.slPct],[2,75,25],'₹25 × 65 = ₹1,625 a lot → 2 lots');
  assert.equal(autoSize(item,65,{budget,optionSlPct:10}).lots,5,'₹10 × 65 = ₹650 a lot → 5 lots');
  const off = autoSize(item,65,{budget,optionSlPct:null});
  assert.equal(off.lots,0);
  assert.match(off.reason,/Option SL room is off in Risk rules/);
});
