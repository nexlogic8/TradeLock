// Gap wick 09:15 on paper: the 09:15 gap decision, then inside the 09:15 minute a wait for NIFTY to wick against the
// trade and turn back across its open; the buy (on paper) with the stop below the option's low so far; exit at 09:16.
// No order ever reaches the broker. Live ticks are faked through FEED.
process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
const { test, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { stmt } = await import('../src/db/index.js');
const { createUser } = await import('../src/modules/auth/service.js');
const { upsertAccount } = await import('../src/modules/broker/registry.js');
const { setBook } = await import('../src/modules/broker/book.js');
const { FEED } = await import('../src/modules/scalper/autotrade.js');
const { paperStep, paperTrades, STRATEGY } = await import('../src/modules/scalper/paper-retest.js');

const real = { tick: FEED.tick, bar: FEED.bar };
after(() => Object.assign(FEED, real));
// The fake feed: the latest tick and the 09:15 minute's bar per key, set by each test step.
const feed = { ticks: {}, bars: {} };
FEED.tick = (uid, key) => feed.ticks[key] || null;
FEED.bar = (uid, key) => feed.bars[key] || null;
const set = (key, ltp, dayOpen, bar) => { feed.ticks[key] = { ltp, dayOpen, at: Date.now() }; if (bar) feed.bars[key] = bar; };

function fakeDhan() {
  const calls = [];
  return {
    calls,
    async optionExpiries() { return ['2026-10-20']; },
    async optionChain() { return { last_price: 23070, oc: {
      '22950': { ce: { security_id: 'C2', last_price: 200 } }, '23000': { ce: { security_id: 'C1', last_price: 160 } },
      '23050': { ce: { security_id: 'G1', last_price: 125 }, pe: { security_id: 'P1', last_price: 110 } } } }; },
    async intradayCandles() { return { timestamp: [], open: [], high: [], low: [], close: [] }; },
    async quote() { calls.push(['quote']); return null; },
    async placeOrder() { calls.push(['order']); throw new Error('a paper strategy must never place an order'); },
  };
}
const instruments = async () => new Map([['C2', { lotSize: 65, tickSize: 0.05 }]]);
const IDX = 'IDX_I:13', C2 = 'NSE_FNO:C2';
// 09:15 opening ticks of the ATM options: CE gapped up (125 → 140), PE did not (110 → 95).
const opening = () => { set('NSE_FNO:G1', 150, 140); set('NSE_FNO:P1', 98, 95); };

async function account(email) {
  const uid = createUser({ email, password: null, name: 'P' });
  upsertAccount(uid, { broker: 'dhan', clientId: email.slice(0, 6), accessToken: 'test-token-not-real-0123456789' });
  stmt('UPDATE broker_accounts SET retest_paper_on = 1, algo_on = 1 WHERE user_id = ?').run(uid);
  setBook(uid, { positions: [], orders: [], funds: { available: 200000 }, at: Date.now() });
  return { uid, acct: stmt('SELECT * FROM broker_accounts WHERE user_id = ?').get(uid) };
}

test('CE: NIFTY wicks below its 09:15 open, turns back above it → bought on paper, stop below the option low, out at 09:16', async () => {
  const { uid, acct } = await account('wick@paper.test'), dhan = fakeDhan(), day = '2026-10-14', at = x => Date.parse(`${day}T${x}+05:30`);
  const memo = {}, step = x => paperStep(acct, { now: at(x), adapter: dhan, memo, instruments });
  feed.ticks = {}; feed.bars = {};
  assert.ok((await step('09:14:59')).waiting, 'not before the open');
  opening();
  set(IDX, 23065, 23060, { open: 23060, high: 23066, low: 23060, close: 23065 });
  set(C2, 232, 230, { open: 230, high: 233, low: 229, close: 232 });
  assert.equal((await step('09:15:00.600')).waiting, 'the wick', 'decided CE; NIFTY has not gone below 23060 yet');
  let r = paperTrades(uid)[0];
  assert.deepEqual([r.strategy, r.status, r.direction], [STRATEGY, 'watching', 'CE']);
  set(IDX, 23050, 23060, { open: 23060, high: 23066, low: 23050, close: 23050 });
  set(C2, 222, 230, { open: 230, high: 233, low: 221, close: 222 });
  assert.equal((await step('09:15:03')).waiting, 'the turn back across the open', 'wick below the open: wait for the turn');
  set(IDX, 23062, 23060, { open: 23060, high: 23066, low: 23050, close: 23062 });
  set(C2, 228, 230, { open: 230, high: 233, low: 221, close: 228 });
  assert.deepEqual(await step('09:15:06'), { entered: 228 }, 'back above 23060: bought at the option price now');
  r = paperTrades(uid)[0];
  assert.deepEqual([r.status, r.entryPrice, r.slPrice, r.lots, r.level], ['open', 228, 220.95, 10, 23050], 'stop one tick below the option low 221; 80% of ₹2L ÷ (228 × 65) = 10 lots');
  set(C2, 231, 230);
  assert.deepEqual(await step('09:15:30'), { open: 231 });
  set(C2, 236, 230);
  const out = await step('09:16:00');
  assert.equal(out.closed, 236);
  r = paperTrades(uid)[0];
  assert.equal(r.status, 'closed');
  assert.match(r.reason, /Fixed exit at 09:16/);
  assert.ok(r.pnl > 0 && r.pnl < 8 * 650, `(236 − 228) × 650 less charges: ${r.pnl}`);
  assert.ok(!dhan.calls.some(c => c[0] === 'order'), 'no order to the broker');
  assert.deepEqual(await step('09:20:00'), { done: 'closed' }, 'once a day');
});

test('no wick against the trade by 09:15:59 → no trade; a wick that turns into the stop → stopped out', async () => {
  const a = await account('nowick@paper.test'), dhan = fakeDhan(), day = '2026-10-15', at = x => Date.parse(`${day}T${x}+05:30`);
  const memo = {}, step = x => paperStep(a.acct, { now: at(x), adapter: dhan, memo, instruments });
  feed.ticks = {}; feed.bars = {};
  opening();
  set(IDX, 23080, 23060, { open: 23060, high: 23090, low: 23060, close: 23080 });   // only up: no wick below the open
  set(C2, 240, 230, { open: 230, high: 241, low: 230, close: 240 });
  assert.equal((await step('09:15:01')).waiting, 'the wick');
  assert.deepEqual(await step('09:16:00'), { skipped: 'no wick' });
  assert.match(paperTrades(a.uid).find(t => t.day === day).reason, /No NIFTY wick below the 09:15 open/);

  const b = await account('stop@paper.test'), day2 = '2026-10-16', at2 = x => Date.parse(`${day2}T${x}+05:30`);
  const memo2 = {}, step2 = x => paperStep(b.acct, { now: at2(x), adapter: dhan, memo: memo2, instruments });
  feed.ticks = {}; feed.bars = {};
  opening();
  set(IDX, 23061, 23060, { open: 23060, high: 23066, low: 23055, close: 23061 });   // already wicked and back above
  set(C2, 226, 230, { open: 230, high: 233, low: 224, close: 226 });
  assert.deepEqual(await step2('09:15:02'), { entered: 226 });
  set(C2, 223, 230);
  const out = await step2('09:15:20');
  assert.equal(out.closed, 223);
  const r = paperTrades(b.uid).find(t => t.day === day2);
  assert.match(r.reason, /Stop-loss/);
  assert.equal(r.slPrice, 223.95);
});
