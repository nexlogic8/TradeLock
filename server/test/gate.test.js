process.env.DB_PATH = ':memory:';
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { checkOrder } = await import('../src/modules/risk/gate.js');
const { DEFAULT_RULES } = await import('../src/modules/rules/service.js');

const base = {
  rules: { ...structuredClone(DEFAULT_RULES), maxLoss: { on: true, mode: 'amount', value: 5000, action: 'exit' } },
  positions: [{ symbol: 'NIFTY 24950 PE', qty: 75 }],
  entries: 1, pnl: 0, minutes: 600, paused: false, pauseReason: null, subscriptionActive: true,
};
const buy = { symbol: 'NIFTY 25000 CE', side: 'BUY', qty: 75 };
const exit = { symbol: 'NIFTY 24950 PE', side: 'SELL', qty: 75 };

const flat = { ...base, positions: [], orders: [] };
test('allows a normal entry when flat', () => {
  assert.deepEqual(checkOrder(buy, flat), { ok: true, reducing: false });
});

test('one trade at a time: an open position, a pending order or an order being placed blocks a new entry', () => {
  assert.equal(checkOrder(buy, base).code, 'TRADE_RUNNING');
  assert.match(checkOrder(buy, base).reason, /NIFTY 24950 PE/);
  assert.equal(checkOrder(buy, { ...flat, orders: [{ id: 'O1', symbol: 'NIFTY 25100 CE' }] }).code, 'ORDER_PENDING');
  assert.equal(checkOrder(buy, { ...flat, entryInFlight: true }).code, 'ORDER_IN_FLIGHT');
  assert.deepEqual(checkOrder(exit, base), { ok: true, reducing: true }, 'exiting the running trade is always allowed');
});

test('blocks entries at the trade cap but always allows exits', () => {
  const s = { ...base, entries: 3 };
  assert.equal(checkOrder(buy, s).code, 'TRADE_CAP');
  assert.deepEqual(checkOrder(exit, s), { ok: true, reducing: true });
});

test('paused, cutoff, loss limit and subscription each block entries', () => {
  assert.equal(checkOrder(buy, { ...base, paused: true, pauseReason: 'rule:maxLoss' }).code, 'PAUSED');
  assert.match(checkOrder(buy, { ...base, paused: true, pauseReason: 'rule:maxLoss' }).reason, /daily loss limit/);
  assert.equal(checkOrder(buy, { ...base, minutes: 15 * 60 + 5 }).code, 'CUTOFF');
  assert.equal(checkOrder(buy, { ...base, pnl: -5000 }).code, 'LOSS_LIMIT');
  assert.equal(checkOrder(buy, { ...base, subscriptionActive: false }).code, 'SUBSCRIPTION_REQUIRED');
  assert.equal(checkOrder(exit, { ...base, paused: true, subscriptionActive: false }).ok, true);
});

test('percentage loss limit uses starting capital', () => {
  const s = { ...flat, rules: structuredClone(DEFAULT_RULES), capital: 100000 };   // 5% → ₹5,000
  assert.equal(checkOrder(buy, { ...s, pnl: -4999 }).ok, true);
  assert.equal(checkOrder(buy, { ...s, pnl: -5000 }).code, 'LOSS_LIMIT');
});

test('selling more than the open position is not treated as an exit', () => {
  assert.equal(checkOrder({ ...exit, qty: 150 }, { ...base, entries: 3 }).code, 'TRADE_CAP');
});

test('MCX capital per trade: qty is in lots, so the value is lots × premium × the multiplier', async () => {
  const { checkOrder } = await import('../src/modules/risk/gate.js');
  const { mcxMultiplier } = await import('../src/modules/scalper/underlyings.js');
  assert.equal(mcxMultiplier('CRUDEOILM 2026-11-17 8300 CE'), 10);
  assert.equal(mcxMultiplier('GOLDM 2026-11-27 136000 PE'), 10);
  assert.equal(mcxMultiplier('NIFTY 2026-11-17 25000 CE'), null);
  const rules = { cutoff:{on:false}, maxTrades:{on:false}, maxLoss:{on:false}, capitalUse:{on:true,value:10000,mode:'amount'} };
  const base = { rules, positions:[], orders:[], entries:0, pnl:0, minutes:null, capital:100000, price:500, subscriptionActive:true };
  assert.equal(checkOrder({ symbol:'CRUDEOILM 2026-11-17 8300 CE', side:'BUY', qty:2, multiplier:10 }, base).code, undefined, '2 lots × 500 × 10 = 10,000: allowed');
  const r = checkOrder({ symbol:'CRUDEOILM 2026-11-17 8300 CE', side:'BUY', qty:3, multiplier:10 }, base);
  assert.equal(r.code, 'CAPITAL_LIMIT');
  assert.match(r.reason, /₹15,000/);
});
