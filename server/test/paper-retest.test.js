// Gap retest 09:15 on paper: the 09:15 gap decision, then a simulated buy when the ITM2 option comes back to its
// 09:15 open (from 09:16, within the window), a stop % below, and the exit. No order ever reaches the broker.
process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
process.env.ADMIN_EMAILS = 'paper@example.com';
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { stmt } = await import('../src/db/index.js');
const { createUser } = await import('../src/modules/auth/service.js');
const { upsertAccount } = await import('../src/modules/broker/registry.js');
const { setBook } = await import('../src/modules/broker/book.js');
const { paperStep, paperTrades, retestConfig } = await import('../src/modules/scalper/paper-retest.js');

const D = '2026-10-14', at = x => Date.parse(`${D}T${x}+05:30`);
function fakeDhan(prices) {
  const calls = [];
  return {
    calls,
    async optionExpiries() { return ['2026-10-20']; },
    async optionChain() { return { last_price: 23070, oc: {
      '22950': { ce: { security_id: 'C2', last_price: 200 } }, '23000': { ce: { security_id: 'C1', last_price: 160 } },
      '23050': { ce: { security_id: 'G1', last_price: 125 }, pe: { security_id: 'P1', last_price: 110 } } } }; },
    async intradayCandles() { return { timestamp: [], open: [], high: [], low: [], close: [] }; },
    async quotes() { calls.push(['quotes']); return { IDX_I: { 13: { ltp: 23070, open: 23060 } }, NSE_FNO: { G1: { open: 140, ltp: 150 }, P1: { open: 95, ltp: 98 } } }; },
    async quote(seg, id) { calls.push(['quote', id]); return id === 'C2' ? prices.shift() ?? null : null; },
    async placeOrder() { calls.push(['order']); throw new Error('a paper strategy must never place an order'); },
  };
}
const instruments = async () => new Map([['C2', { lotSize: 65, tickSize: 0.05 }]]);

test('a paper day: gap CE → waits for the ITM2 to come back to its 09:15 open, buys on paper, stopped out; never an order', async () => {
  const uid = createUser({ email: 'paper@example.com', password: null, name: 'P' });
  upsertAccount(uid, { broker: 'dhan', clientId: 'C9', accessToken: 'test-token-not-real-0123456789' });
  stmt('UPDATE broker_accounts SET retest_paper_on = 1 WHERE user_id = ?').run(uid);
  const acct = stmt('SELECT * FROM broker_accounts WHERE user_id = ?').get(uid);
  setBook(uid, { positions: [], orders: [], funds: { available: 200000 }, at: Date.now() });
  assert.deepEqual(retestConfig(acct), { windowMin: 15, slPct: 3 });
  // C2 (22950 CE, ITM2): opens 230; above it at 09:16:30, back to 229.5 at 09:17, then down to 222.
  const dhan = fakeDhan([{ ltp: 232, open: 230 }, { ltp: 235, open: 230 }, { ltp: 229.5, open: 230 }, { ltp: 222, open: 230 }]);
  const memo = {}, step = x => paperStep(acct, { now: at(x), adapter: dhan, memo, instruments });
  assert.ok((await step('09:15:00.100')).waiting, 'not before 09:15:00.5');
  assert.ok((await step('09:15:03')).waiting, 'its own quote request waits until 09:15:05 (the live Gap trade first)');
  assert.deepEqual(await step('09:15:06'), { watching: 230 }, 'CE gapped up (125 → 140), ITM2 22950 CE opened 230');
  assert.ok((await step('09:15:40')).waiting, 'the retest counts from 09:16');
  assert.ok((await step('09:16:30')).waiting, '235: not back yet');
  assert.deepEqual(await step('09:17:00'), { entered: 230 }, 'back to 230: bought on paper at the 09:15 open');
  let r = paperTrades(uid)[0];
  assert.deepEqual([r.status, r.lots, r.qty, r.entryPrice, r.slPrice], ['open', 10, 650, 230, 223.1], '80% of ₹2L ÷ (230 × 65) = 10 lots; stop 3% below');
  const out = await step('09:17:05');
  assert.equal(out.closed, 222);
  r = paperTrades(uid)[0];
  assert.equal(r.status, 'closed');
  assert.equal(r.reason, 'Stop-loss');
  assert.ok(r.pnl < -(8 * 650) && r.charges > 0, `(222 − 230) × 650 less charges: ${r.pnl}`);
  assert.ok(!dhan.calls.some(c => c[0] === 'order'), 'no order to the broker');
  assert.ok(stmt("SELECT 1 FROM notifications WHERE user_id = ? AND title LIKE 'Paper:%'").get(uid), 'notified as paper');
  assert.deepEqual(await step('09:20:00'), { done: 'closed' }, 'once a day');
});

test('no retest within the window → no paper trade that day', async () => {
  const uid = stmt("SELECT id FROM users WHERE email = 'paper@example.com'").get().id;
  const acct = { ...stmt('SELECT * FROM broker_accounts WHERE user_id = ?').get(uid), retest_cfg: JSON.stringify({ windowMin: 5, slPct: 3 }) };
  const day = '2026-10-15', when = x => Date.parse(`${day}T${x}+05:30`);
  const dhan = fakeDhan([{ ltp: 240, open: 230 }, { ltp: 238, open: 230 }, { ltp: 236, open: 230 }]);
  const memo = {}, step = x => paperStep(acct, { now: when(x), adapter: dhan, memo, instruments });
  await step('09:15:06');
  assert.ok((await step('09:17:00')).waiting);
  assert.deepEqual(await step('09:20:01'), { skipped: 'no retest' });
  const r = paperTrades(uid).find(t => t.day === day);
  assert.equal(r.status, 'skipped');
  assert.match(r.reason, /No retest of the 09:15 open 230 within 5 minutes/);
});
