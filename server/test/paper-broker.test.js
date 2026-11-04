// Paper mode: the paper broker fills at the live price with the paper wallet's money, rests stop-losses until the
// price reaches them, books the P&L (after charges) into the wallet, and has a day kill switch. Never a real order.
process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { stmt } = await import('../src/db/index.js');
const { createUser } = await import('../src/modules/auth/service.js');
const { createPaperAdapter, paperWallet, setPaperBalance, resetPaperWallet, PAPER_DEFAULT } = await import('../src/modules/broker/adapters/paper.js');

const newUser = email => createUser({ email, password: null, name: 'P' });
const market = () => { const m = { px: 100, calls: [] }; m.data = { ltp: async () => m.px, placeOrder: async () => { m.calls.push('order'); throw new Error('real order'); } }; return m; };
const buy = (qty, extra = {}) => ({ symbol: 'NIFTY X CE', side: 'BUY', qty, type: 'MARKET', securityId: 'C1', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY', ...extra });

test('a new paper wallet holds ₹10 lakh; it can be set from ₹10,000 to ₹1 crore and reset', () => {
  const uid = newUser('wallet@paper.test');
  assert.equal(PAPER_DEFAULT, 1_000_000);
  assert.equal(paperWallet(uid).balance, 1_000_000);
  assert.equal(setPaperBalance(uid, 10_000_000).balance, 10_000_000, '₹1 crore');
  assert.throws(() => setPaperBalance(uid, 10_000_001), /between ₹10,000 and ₹1,00,00,000/);
  assert.throws(() => setPaperBalance(uid, 5_000), /between/);
  assert.equal(resetPaperWallet(uid).balance, 1_000_000);
});

test('buy at the live price, stop-loss rests until the price falls to it, the loss (after charges) leaves the wallet', async () => {
  const uid = newUser('trade@paper.test'), m = market(), p = createPaperAdapter({ userId: uid, data: m.data });
  const b = await p.placeOrder(buy(650));
  assert.match(b.id, /^P\d+$/);
  assert.deepEqual(await p.orderStatus(b.id), { status: 'filled', price: 100, filledQty: 650, qty: 650 });
  let s = await p.snapshot();
  assert.deepEqual([s.positions[0].qty, s.positions[0].avg, s.funds.available, s.funds.used], [650, 100, 935000, 65000], '₹65,000 in the position, the rest available');
  const sl = await p.placeOrder({ ...buy(650), side: 'SELL', type: 'STOP_LOSS', triggerPrice: 90, price: 81 });
  m.px = 95;
  assert.equal((await p.orderStatus(sl.id)).status, 'pending', '95: above the 90 trigger');
  assert.equal((await p.snapshot()).orders.length, 1, 'the resting stop shows as a pending order');
  m.px = 89;
  const done = await p.orderStatus(sl.id);
  assert.deepEqual([done.status, done.price], ['filled', 89]);
  s = await p.snapshot();
  assert.deepEqual([s.positions[0].qty, s.positions[0].realized], [0, -7150], '(89 − 100) × 650');
  const w = paperWallet(uid).balance;
  assert.ok(w < 1_000_000 - 7150 && w > 1_000_000 - 7150 - 500, `wallet −₹7,150 and charges: ${w}`);
  assert.equal(s.trades.length, 2);
  assert.ok(!m.calls.length, 'no real order');
});

test('more than the wallet holds is refused for funds; the day kill switch; balance changes wait for a flat book', async () => {
  const uid = newUser('funds@paper.test'), m = market(), p = createPaperAdapter({ userId: uid, data: m.data });
  const big = await p.placeOrder(buy(65 * 200));   // ₹13 lakh at ₹100
  const st = await p.orderStatus(big.id);
  assert.equal(st.status, 'failed');
  assert.match(st.reason, /Insufficient funds/);
  assert.equal(await p.getKillSwitch(), false);
  await p.activateKillSwitch();
  assert.equal(await p.getKillSwitch(), true);
  await p.placeOrder(buy(65));
  assert.throws(() => setPaperBalance(uid, 500000), /Close the open paper trade first/);
  await p.exitPosition({ symbol: 'NIFTY X CE', securityId: 'C1', exchangeSegment: 'NSE_FNO', qty: 65 });
  assert.equal(setPaperBalance(uid, 500000).balance, 500000);
});

test('Real | Paper switch: the account trades the paper broker (label Paper), strategies carried over; back to real', async () => {
  const { upsertAccount, adapterFor } = await import('../src/modules/broker/registry.js');
  const { switchPaper } = await import('../src/modules/broker/switch.js');
  const uid = newUser('switch@paper.test');
  upsertAccount(uid, { broker: 'dhan', clientId: 'C5', accessToken: 'test-token-not-real-0123456789' });
  stmt('UPDATE broker_accounts SET algo_on = 1, agent_on = 1, gap_on = 1 WHERE user_id = ?').run(uid);
  let acct = stmt('SELECT * FROM broker_accounts WHERE user_id = ?').get(uid);
  assert.notEqual(adapterFor(acct).label, 'Paper');
  acct = await switchPaper(acct, true, { sync: async () => {} });
  assert.deepEqual([acct.paper_mode, acct.algo_on, acct.gap_on], [1, 1, 1], 'Algo Trading keeps running, on paper');
  assert.equal(adapterFor(acct).label, 'Paper');
  acct = await switchPaper(acct, false, { sync: async () => {} });
  assert.equal(acct.paper_mode, 0);
  assert.notEqual(adapterFor(acct).label, 'Paper');
});
