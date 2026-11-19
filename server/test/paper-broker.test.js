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

test('a Dhan kill switch does not lock paper trading: the switch drops its reading, the paper broker\'s own lock decides', async () => {
  const { upsertAccount } = await import('../src/modules/broker/registry.js');
  const { switchPaper } = await import('../src/modules/broker/switch.js');
  const { setKillStatus, getKillStatus, killSwitchLock } = await import('../src/modules/broker/book.js');
  const { checkOrder } = await import('../src/modules/risk/gate.js');
  const { DEFAULT_RULES } = await import('../src/modules/rules/service.js');
  const uid = newUser('dhanlock@paper.test');
  upsertAccount(uid, { broker: 'dhan', clientId: 'C6', accessToken: 'test-token-not-real-0123456789' });
  let acct = stmt('SELECT * FROM broker_accounts WHERE user_id = ?').get(uid);
  setKillStatus(uid, { active: true, label: 'Dhan', checkedAt: Date.now() });   // Dhan locked today
  assert.equal(killSwitchLock(uid, { ks_active_at: Date.now() }), 'Dhan');
  acct = await switchPaper(acct, true, { sync: async () => {} });
  assert.equal(getKillStatus(uid), null, 'Dhan\'s reading is not carried to paper');
  assert.equal(killSwitchLock(uid, {}), null, 'paper trades');
  // TradeLock's record of a lock counts only until the trading broker is read; the broker's reading wins.
  setKillStatus(uid, { active: false, label: 'Paper', checkedAt: Date.now() });
  assert.equal(killSwitchLock(uid, { ks_active_at: Date.now() }), null);
  // The paper day lock blocks entries with a message that names it (and how to switch it off).
  setKillStatus(uid, { active: true, label: 'Paper', checkedAt: Date.now() });
  const lock = killSwitchLock(uid, {});
  const v = checkOrder(buy(65), { rules: structuredClone(DEFAULT_RULES), positions: [], orders: [], entries: 0, pnl: 0, minutes: 600,
    subscriptionActive: true, killSwitchActive: !!lock, killSwitchLabel: lock });
  assert.equal(v.code, 'KILL_SWITCH');
  assert.match(v.reason, /Paper kill switch is on.*Switch it off on the Overview page/);
});

test('a buy stop above the market rests until the price rises to it (a buy limit above it would fill at once)', async () => {
  const { stopLimitPrice } = await import('../src/modules/orders/routes.js');
  assert.equal(stopLimitPrice('BUY', 289.9), 304.4, 'the stop works as a limit 5% above its trigger, on the tick');
  assert.equal(stopLimitPrice('SELL', 100), 95);
  const uid = newUser('stop@paper.test'), m = market(), p = createPaperAdapter({ userId: uid, data: m.data });
  m.px = 195.55;
  const lim = await p.placeOrder(buy(20, { type: 'LIMIT', price: 289.9 }));
  assert.deepEqual([(await p.orderStatus(lim.id)).status, (await p.orderStatus(lim.id)).price], ['filled', 195.55], 'a buy limit above the market fills at the market');
  await p.exitPosition({ symbol: 'NIFTY X CE', securityId: 'C1', exchangeSegment: 'NSE_FNO', qty: 20 });
  const stop = await p.placeOrder(buy(20, { type: 'STOP_LOSS', triggerPrice: 289.9, price: stopLimitPrice('BUY', 289.9) }));
  assert.equal((await p.orderStatus(stop.id)).status, 'pending', 'below the trigger: waits');
  const row = (await p.snapshot()).orders.find(o => o.id === stop.id);
  assert.deepEqual([row.type, row.triggerPrice, row.exchangeSegment], ['STOP_LOSS', 289.9, 'NSE_FNO'], 'the book carries the trigger and segment (chart marker, live feed)');
  m.px = 290.1;
  assert.deepEqual([(await p.orderStatus(stop.id)).status, (await p.orderStatus(stop.id)).price], ['filled', 290.1], 'rose to the trigger: bought');
});

test('moving a resting paper order changes the book signature, so the dashboard is pushed and the chart redraws it', async () => {
  const uid = newUser('move@paper.test'), m = market(), p = createPaperAdapter({ userId: uid, data: m.data });
  m.px = 183.3;
  const stop = await p.placeOrder(buy(20, { type: 'STOP_LOSS', triggerPrice: 246.45, price: 258.75 }));
  const before = (await p.snapshot()).orderSig;
  await p.modifyStopLoss(stop.id, { triggerPrice: 232.3, price: 243.9 });
  const after = await p.snapshot();
  assert.notEqual(after.orderSig, before, 'a new trigger is a change (it was id + status only: the move never reached the screen)');
  assert.equal(after.orders.find(o => o.id === stop.id).triggerPrice, 232.3);
});

test('MCX on paper counts lots: P&L, wallet and margin use the lot value (GOLDM ×10), as Dhan does', async () => {
  const uid = newUser('mcx@paper.test'), m = market(), p = createPaperAdapter({ userId: uid, data: m.data });
  setPaperBalance(uid, 10_000_000);
  const gold = (side, qty) => ({ symbol: 'GOLDM 2026-11-27 131000 PE', side, qty, type: 'MARKET', securityId: 'G1', exchangeSegment: 'MCX_COMM', productType: 'INTRADAY' });
  m.px = 2587.5;
  await p.placeOrder(gold('BUY', 145));
  let s = await p.snapshot();
  assert.equal(s.funds.used, 3_751_875, '145 lots × 2,587.50 × 10 is the money in the trade');
  m.px = 2600;
  assert.equal((await p.snapshot()).positions[0].unrealized, 18_125, '(2,600 − 2,587.50) × 145 × 10');
  m.px = 2720.5;
  await p.placeOrder(gold('SELL', 145));
  s = await p.snapshot();
  assert.equal(s.positions[0].realized, 192_850, '(2,720.50 − 2,587.50) × 145 × 10, not ₹19,285');
  const w = paperWallet(uid).balance;
  assert.ok(w > 10_000_000 + 192_850 - 10_000 && w < 10_000_000 + 192_850, `wallet +₹1,92,850 less charges (on ≈₹77 lakh turnover): ${w}`);
});
