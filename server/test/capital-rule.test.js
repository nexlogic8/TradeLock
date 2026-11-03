// Capital per trade (Risk rules, both sets): the most one trade may use, as a % of the day's starting capital or a
// fixed amount. Buys above it are refused; automatic entries and Power Scalper lots are sized within it.
process.env.DB_PATH = ':memory:';
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { DEFAULT_RULES, loosens, normalizeRules } = await import('../src/modules/rules/service.js');
const { capitalLimit } = await import('../src/modules/rules/limits.js');
const { checkOrder } = await import('../src/modules/risk/gate.js');
const { signalBudget } = await import('../src/modules/scalper/signal-risk.js');
const { autoSize } = await import('../../web/js/pages/scalper.js');

const base = () => JSON.parse(JSON.stringify(DEFAULT_RULES));
const withCap = capitalUse => normalizeRules({ ...base(), capitalUse });

test('off by default (also for rules saved before it existed); % or ₹, validated', () => {
  assert.deepEqual(normalizeRules(base()).capitalUse, { on: false, mode: 'percent', value: 80 });
  const older = base(); delete older.capitalUse;
  assert.deepEqual(normalizeRules(older).capitalUse, { on: false, mode: 'percent', value: 80 });
  assert.equal(capitalLimit(withCap({ on: true, mode: 'percent', value: 10 }), 823933), 82393.3);
  assert.equal(capitalLimit(withCap({ on: true, mode: 'amount', value: 50000 }), 823933), 50000);
  assert.equal(capitalLimit(withCap({ on: false, mode: 'amount', value: 50000 }), 823933), null, 'off: no limit');
  assert.throws(() => withCap({ on: true, mode: 'percent', value: 120 }), /Capital per trade/);
  assert.throws(() => withCap({ on: true, mode: 'amount', value: 500 }), /Capital per trade/);
});

test('a bigger limit, or turning it off, loosens; a smaller one tightens', () => {
  const cur = withCap({ on: true, mode: 'amount', value: 50000 });
  assert.equal(loosens(cur, withCap({ on: true, mode: 'amount', value: 60000 }), 800000), true);
  assert.equal(loosens(cur, withCap({ on: false, mode: 'amount', value: 50000 }), 800000), true);
  assert.equal(loosens(cur, withCap({ on: true, mode: 'amount', value: 40000 }), 800000), false);
  assert.equal(loosens(cur, withCap({ on: true, mode: 'percent', value: 5 }), 800000), false, '5% of ₹8L = ₹40,000');
  assert.equal(loosens(withCap({ on: false, mode: 'amount', value: 50000 }), cur, 800000), false, 'turning it on tightens');
});

test('the gate refuses a buy above the limit (limit price, else the premium it was sized at); sells and exits pass', () => {
  const rules = withCap({ on: true, mode: 'amount', value: 50000 });
  const s = { rules, positions: [], orders: [], entries: 0, pnl: 0, minutes: 600, capital: 800000, subscriptionActive: true };
  const buy = { symbol: 'NIFTY 25000 CE', side: 'BUY', qty: 650 };
  assert.equal(checkOrder(buy, { ...s, price: 100 }).code, 'CAPITAL_LIMIT', '650 × ₹100 = ₹65,000');
  assert.match(checkOrder(buy, { ...s, price: 100 }).reason, /₹65,000.*₹50,000 capital per trade/);
  assert.equal(checkOrder({ ...buy, type: 'LIMIT', price: 70 }, s).ok, true, '650 × ₹70 = ₹45,500');
  assert.equal(checkOrder({ ...buy, side: 'SELL' }, { ...s, price: 100 }).ok, true, 'selling (writing) uses margin, not premium');
  assert.equal(checkOrder(buy, { ...s, rules: withCap({ on: false, mode: 'amount', value: 50000 }), price: 100 }).ok, true, 'off');
  assert.equal(checkOrder(buy, { ...s, positions: [{ symbol: 'NIFTY 25000 PE', qty: -650 }], price: 70 }).code, 'TRADE_RUNNING', 'within the limit, the other rules still apply');
});

test('Power Scalper lots: within the risk budget and the capital limit', () => {
  const rules = { ...withCap({ on: true, mode: 'amount', value: 50000 }), maxLoss: { on: true, mode: 'amount', value: 100000, action: 'exit' }, maxTrades: { on: true, value: 1, action: 'pause' } };
  const budget = signalBudget(rules, 800000, 0);
  assert.equal(budget.capitalLimit, 50000);
  const item = { ltp: 100 };
  assert.equal(autoSize(item, 65, { budget, optionSlPct: 20 }).lots, 7, '₹50,000 ÷ (₹100 × 65) = 7 lots (risk alone would allow 76)');
  assert.equal(autoSize(item, 65, { budget: { ...budget, capitalLimit: null }, optionSlPct: 20 }).lots, 76);
  const tooDear = autoSize({ ltp: 1000 }, 65, { budget, optionSlPct: 20 });
  assert.equal(tooDear.lots, 0);
  assert.match(tooDear.reason, /capital per trade/);
});
