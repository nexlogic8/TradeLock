// GROWCONTROL kill rules, capital, and the Dhan hard-lock sequence.
process.env.DB_PATH = ':memory:';
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { evaluate, closedTrades, consecutiveLosses, closedPeak } = await import('../src/modules/risk/engine.js');
const { DEFAULT_RULES } = await import('../src/modules/rules/service.js');
const { capitalFromFunds } = await import('../src/modules/risk/service.js');
const { createDhanAdapter } = await import('../src/modules/broker/adapters/dhan.js');

const f = (symbol, side, qty, price, ts) => ({ symbol, side, qty, price, ts });
const ids = (s, rules = DEFAULT_RULES) => evaluate(rules, { pnl: 0, entries: 0, minutes: 600, capital: 1e6, ...s }).map(t => t.id);

test('round trips are rebuilt from fills with average cost', () => {
  const closed = closedTrades([
    f('A', 'BUY', 75, 100, 1), f('A', 'BUY', 75, 110, 2),   // avg 105
    f('A', 'SELL', 150, 100, 3),                              // −750
    f('B', 'SELL', 50, 200, 4), f('B', 'BUY', 50, 190, 5),    // short +500
  ]);
  assert.deepEqual(closed.map(c => [c.symbol, c.pnl]), [['A', -750], ['B', 500]]);
});

test('defaults: 2 losses in a row, 20% give-back armed at the stop-loss amount', () => {
  assert.deepEqual(DEFAULT_RULES.lossStreak, { on: true, value: 2 });
  assert.deepEqual(DEFAULT_RULES.giveback, { on: true, value: 20 });
});

test('losing streak counts back from the latest close', () => {
  assert.equal(consecutiveLosses([{ pnl: 100 }, { pnl: -5 }, { pnl: -9 }]), 2);
  assert.equal(consecutiveLosses([{ pnl: -5 }, { pnl: 10 }]), 0);
  assert.deepEqual(ids({ closed: [{ pnl: -100 }] }), []);
  assert.deepEqual(ids({ closed: [{ pnl: 300 }, { pnl: -100 }, { pnl: -50 }] }), ['lossStreak.breach']);
});

test('give-back protects booked profit, armed once the peak reaches the stop-loss amount', () => {
  // Stop-loss 5% of ₹30,000 capital = ₹1,500, so give-back arms at ₹1,500 of booked profit.
  const rules = { ...DEFAULT_RULES, maxLoss: { ...DEFAULT_RULES.maxLoss, on: false, mode: 'percent', value: 5 } };
  const at = (s, r = rules) => evaluate(r, { pnl: 0, entries: 0, minutes: 600, capital: 30000, ...s }).map(t => t.id);
  const closed = [{ pnl: 1000 }, { pnl: 500 }];                     // booked peak ₹1,500
  assert.equal(closedPeak(closed), 1500);
  assert.deepEqual(at({ closed, pnl: 1300 }), [], '13% below peak: fine');
  assert.deepEqual(at({ closed, pnl: 1200 }), ['giveback.breach'], '20% below the ₹1,500 peak');
  assert.deepEqual(at({ closed: [{ pnl: 1400 }], pnl: 0 }), [], 'peak ₹1,400 is under the ₹1,500 stop-loss amount');
  const fixed = { ...rules, maxLoss: { ...rules.maxLoss, mode: 'amount', value: 1000 } };
  assert.deepEqual(at({ closed: [{ pnl: 1400 }], pnl: 1000 }, fixed), ['giveback.breach'], 'a fixed ₹1,000 stop-loss arms at ₹1,000');
  assert.deepEqual(at({ closed, pnl: 0, capital: null }), [], 'capital unknown: cannot arm yet');
});

test('capital = free + used − realized, falling back to the opening balance', () => {
  assert.equal(capitalFromFunds({ available: 230017.38, used: 0, opening: 193599.02 }, 0), 230017.38);
  assert.equal(capitalFromFunds({ available: 90000, used: 20000, opening: 100000 }, 10000), 100000, 'P&L does not move capital');
  assert.equal(capitalFromFunds({ opening: 50000 }), 50000);
  assert.equal(capitalFromFunds(null), null);
});

test('Dhan hard lock: activate, deactivate, activate, read back ON', async () => {
  const calls = [];
  let state = 'INACTIVE';
  const transport = async (method, url) => {
    const u = new URL(url);
    calls.push(`${method} ${u.pathname}${u.search}`);
    if (method === 'POST') state = u.searchParams.get('killSwitchStatus') === 'ACTIVATE' ? 'ACTIVE' : 'INACTIVE';
    return { status: 200, text: JSON.stringify(method === 'GET' ? { killSwitchStatus: state } : { killSwitchStatus: 'ok' }) };
  };
  {
    const dhan = createDhanAdapter({ clientId: 'C1', accessToken: 'x'.repeat(30), transport });
    const { message } = await dhan.activateKillSwitch();
    assert.match(message, /locked until the next trading day/);
    assert.deepEqual(calls.map(c => c.replace('/v2', '')), [
      'GET /killswitch',
      'POST /killswitch?killSwitchStatus=ACTIVATE',
      'POST /killswitch?killSwitchStatus=DEACTIVATE',
      'POST /killswitch?killSwitchStatus=ACTIVATE',
      'GET /killswitch',
    ]);
    assert.equal(await dhan.getKillSwitch(), true, 'live API answers ACTIVE');
  }
});

test('Dhan: a refused deactivate while ON means already locked for the day', async () => {
  const transport = async (method, url) => (method === 'POST' && url.includes('DEACTIVATE')
    ? { status: 400, text: JSON.stringify({ errorMessage: 'Kill switch cannot be deactivated' }) }
    : { status: 200, text: JSON.stringify({ killSwitchStatus: 'ACTIVE' }) });
  const dhan = createDhanAdapter({ clientId: 'C1', accessToken: 'x'.repeat(30), transport });
  assert.match((await dhan.activateKillSwitch()).message, /locked for the rest of the day/);
});

test('Dhan snapshot fetches trades only when the order book changed, funds only when asked', async () => {
  const calls = [];
  let status = 'PENDING';
  const transport = async (method, url) => {
    const path = new URL(url).pathname.replace('/v2', '');
    calls.push(path);
    const body = {
      '/positions': [{ tradingSymbol: 'NIFTY', securityId: 1, netQty: 75, buyAvg: 100, realizedProfit: 0, unrealizedProfit: 50 }],
      '/orders': [{ orderId: 'O1', orderStatus: status, filledQty: status === 'TRADED' ? 75 : 0, tradingSymbol: 'NIFTY', transactionType: 'BUY', quantity: 75 }],
      '/trades': [{ orderId: 'O1', exchangeTradeId: 'T1', tradingSymbol: 'NIFTY', transactionType: 'BUY', tradedQuantity: 75, tradedPrice: 100 }],
      '/fundlimit': { availabelBalance: 1000 },
    }[path];
    return { status: 200, text: JSON.stringify(body) };
  };
  const dhan = createDhanAdapter({ clientId: 'C1', accessToken: 'x'.repeat(30), transport });
  const first = await dhan.snapshot();
  assert.deepEqual(calls.sort(), ['/fundlimit', '/orders', '/positions', '/trades'], 'first sync reads everything');
  assert.equal(first.funds.available, 1000);

  calls.length = 0;
  const same = await dhan.snapshot({ funds: false, prevOrderSig: first.orderSig });
  assert.deepEqual(calls.sort(), ['/orders', '/positions']);
  assert.equal(same.trades, null, 'unchanged order book: trades not fetched');
  assert.equal(same.funds, undefined, 'funds not fetched');

  status = 'TRADED';
  calls.length = 0;
  const filled = await dhan.snapshot({ funds: false, prevOrderSig: same.orderSig });
  assert.ok(calls.includes('/trades'), 'a fill changes the order book, so trades are fetched');
  assert.equal(filled.trades.length, 1);
});

test('Dhan "Invalid Token" answers are treated as an expired session', async () => {
  const transport = async () => ({ status: 400, text: JSON.stringify({ errorType: 'Invalid_Authentication', errorCode: 'DH-906', errorMessage: 'Invalid Token' }) });
  const dhan = createDhanAdapter({ clientId: 'C1', accessToken: 'x'.repeat(30), transport });
  await assert.rejects(dhan.snapshot(), e => e.code === 'TOKEN_EXPIRED');
});
