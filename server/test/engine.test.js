process.env.DB_PATH = ':memory:';
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { evaluate, countEntries } = await import('../src/modules/risk/engine.js');
const { DEFAULT_RULES, loosens, normalizeRules } = await import('../src/modules/rules/service.js');

// Fixed-amount fixture keeps the original ₹5,000 / ₹8,000 expectations readable.
const rules = structuredClone(DEFAULT_RULES);
rules.maxLoss = { on: true, mode: 'amount', value: 5000, action: 'exit' };
rules.profitLock = { on: true, mode: 'amount', value: 8000, action: 'pause' };
const ids = s => evaluate(rules, s).map(t => t.id);

test('no triggers on a calm day', () => {
  assert.deepEqual(ids({ pnl: 1200, entries: 1, minutes: 600 }), []);
});

test('loss warning at 80% and breach at the limit', () => {
  assert.deepEqual(ids({ pnl: -4000, entries: 0, minutes: 600 }), ['maxLoss.warn']);
  const [t] = evaluate(rules, { pnl: -5000, entries: 0, minutes: 600 });
  assert.equal(t.id, 'maxLoss.breach');
  assert.equal(t.action, 'exit');
});

test('trade cap warns one entry early and breaches at the cap', () => {
  assert.deepEqual(ids({ pnl: 0, entries: 2, minutes: 600 }), ['maxTrades.warn']);
  assert.deepEqual(ids({ pnl: 0, entries: 3, minutes: 600 }), ['maxTrades.breach']);
});

test('profit lock and cutoff', () => {
  assert.ok(ids({ pnl: 8000, entries: 0, minutes: 600 }).includes('profitLock.breach'));
  assert.ok(ids({ pnl: 0, entries: 0, minutes: 15 * 60 }).includes('cutoff.breach'));
  assert.ok(!ids({ pnl: 0, entries: 0, minutes: null }).includes('cutoff.breach'), 'cutoff skipped outside session');
});

test('disabled rules never trigger', () => {
  const off = structuredClone(rules);
  for (const k of Object.keys(off)) off[k].on = false;
  assert.deepEqual(evaluate(off, { pnl: -99999, entries: 99, minutes: 920 }), []);
});

test('default rules are 5% loss and 10% profit of starting capital', () => {
  const d = DEFAULT_RULES;
  assert.equal(d.maxLoss.mode, 'percent'); assert.equal(d.maxLoss.value, 5);
  assert.equal(d.profitLock.mode, 'percent'); assert.equal(d.profitLock.value, 10);
  const at = (pnl, capital) => evaluate(d, { pnl, entries: 0, minutes: 600, capital }).map(t => t.id);
  assert.deepEqual(at(-9999, 200000), ['maxLoss.warn'], '₹9,999 loss on ₹2L is under 5% but past the 80% warning');
  assert.deepEqual(at(-10000, 200000), ['maxLoss.breach'], '5% of ₹2,00,000 = ₹10,000');
  assert.deepEqual(at(20000, 200000), ['profitLock.breach'], '10% of ₹2,00,000 = ₹20,000');
  assert.match(evaluate(d, { pnl: -10000, entries: 0, minutes: 600, capital: 200000 })[0].body, /5% of ₹2,00,000 capital/);
});

test('percentage rules are skipped until starting capital is known', () => {
  assert.deepEqual(evaluate(DEFAULT_RULES, { pnl: -999999, entries: 0, minutes: 600, capital: null }), []);
});

test('countEntries counts opens and adds, not exits', () => {
  assert.equal(countEntries([
    { symbol: 'NIFTY 25000 CE', side: 'BUY', qty: 75 },
    { symbol: 'NIFTY 25000 CE', side: 'SELL', qty: 75 },
    { symbol: 'NIFTY 24950 PE', side: 'BUY', qty: 75 },
  ]), 2);
  assert.equal(countEntries([
    { symbol: 'X', side: 'BUY', qty: 75, ts: 1000 },
    { symbol: 'X', side: 'BUY', qty: 75, ts: 60000 },  // add (a later order)
    { symbol: 'X', side: 'SELL', qty: 50, ts: 90000 }, // partial exit
    { symbol: 'X', side: 'SELL', qty: 200, ts: 120000 }, // reversal to short counts
  ]), 3);
});

test('one order filled in many pieces is one entry', () => {
  // Dhan split a 1,950-qty buy into 10 fills: with order ids...
  const pieces = [130, 65, 130, 130, 260, 260, 260, 260, 260, 195];
  assert.equal(countEntries(pieces.map((qty, i) => ({ symbol: 'NIFTY PE', side: 'BUY', qty, ts: 1000 + i * 30, orderId: 'O1' }))), 1);
  // ...and fills saved before order ids were kept (same symbol, side and second).
  assert.equal(countEntries(pieces.map(qty => ({ symbol: 'NIFTY PE', side: 'BUY', qty, ts: 5000 }))), 1);
  // Two separate orders still count twice; orders seconds apart (a broker splitting one order) count once.
  assert.equal(countEntries([{ symbol: 'A', side: 'BUY', qty: 1, ts: 1, orderId: 'O1' }, { symbol: 'A', side: 'BUY', qty: 1, ts: 60_001, orderId: 'O2' }]), 2);
  assert.equal(countEntries([{ symbol: 'A', side: 'BUY', qty: 1, ts: 1, orderId: 'O1' }, { symbol: 'A', side: 'BUY', qty: 1, ts: 2, orderId: 'O2' }]), 1);
});

test('switching modes is judged in rupees when capital is known', () => {
  const pct = structuredClone(DEFAULT_RULES);                      // 5% of capital
  const fixed = structuredClone(DEFAULT_RULES);
  fixed.maxLoss = { on: true, mode: 'amount', value: 12000, action: 'exit' };
  assert.equal(loosens(pct, fixed, 200000), true, '₹12,000 is looser than 5% of ₹2L (₹10,000)');
  fixed.maxLoss.value = 8000;
  assert.equal(loosens(pct, fixed, 200000), false, '₹8,000 is tighter');
  assert.equal(loosens(pct, fixed, null), true, 'unknown capital: a mode switch is treated as loosening');
});

test('loosening detection', () => {
  const next = structuredClone(rules);
  assert.equal(loosens(rules, next), false);
  next.maxLoss.value = 4000;
  assert.equal(loosens(rules, next), false, 'tighter loss limit is not loosening');
  next.maxTrades.value = 5;
  assert.equal(loosens(rules, next), true);
  const weaker = structuredClone(rules);
  weaker.maxLoss.action = 'alert';
  assert.equal(loosens(rules, weaker), true, 'weaker action is loosening');
});

test('rule validation rejects bad input', () => {
  assert.throws(() => normalizeRules({ ...rules, maxTrades: { on: true, value: 0, action: 'pause' } }), /Maximum trades/);
  assert.throws(() => normalizeRules({ ...rules, cutoff: { on: true, value: '16:00', action: 'pause' } }), /between 09:15 and 15:30/);
  assert.equal(normalizeRules({ ...rules, maxLoss: { on: true, value: '7,500', action: 'exit' } }).maxLoss.value, 7500);
  assert.equal(normalizeRules({ ...rules, maxLoss: { on: true, mode: 'percent', value: '2.5', action: 'exit' } }).maxLoss.value, 2.5);
  assert.throws(() => normalizeRules({ ...rules, maxLoss: { on: true, mode: 'percent', value: 150, action: 'exit' } }), /% of starting capital/);
});
