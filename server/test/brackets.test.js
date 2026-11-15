// Chart TP / SL (server/src/modules/brackets): levels, the stop order's price, and the target watcher (never sells twice).
process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { createUser } = await import('../src/modules/auth/service.js');
const { setBook } = await import('../src/modules/broker/book.js');
const svc = await import('../src/modules/brackets/service.js');
const { bracketOf } = await import('../src/modules/brackets/store.js');
const { pnlAt, defaultLevel } = await import('../../web/js/pages/scalper-chart-position.js');

test('levels: side and current price checked; the stop order works a little beyond its trigger', () => {
  assert.equal(svc.checkLevels({ long: true, ltp: 100, tp: 120, sl: 90 }), null);
  assert.match(svc.checkLevels({ long: true, ltp: 100, tp: 120, sl: 105 }), /below the current price/);
  assert.match(svc.checkLevels({ long: true, ltp: 100, tp: 95, sl: 90 }), /above the current price/);
  assert.match(svc.checkLevels({ long: false, ltp: 100, tp: 130, sl: 120 }), /target must be below the stop/i);
  assert.match(svc.checkLevels({ long: false, ltp: 100, tp: 110, sl: 120 }), /Target must be below the current price/);
  assert.equal(svc.checkLevels({ long: false, ltp: 100, tp: 80, sl: 110 }), null);
  assert.equal(svc.stopLimitFor(100, true), 95, 'long: sells down to 5% under the trigger');
  assert.equal(svc.stopLimitFor(100, false), 105, 'short: buys up to 5% over');
  assert.equal(svc.stopLimitFor(0.5, true, 0.05), 0.45, 'a tiny premium still leaves at least one tick');
  assert.deepEqual([
    svc.triggered({ long: true, ltp: 121, tp: 120, sl: 90, slAtBroker: true }),
    svc.triggered({ long: true, ltp: 89, tp: 120, sl: 90, slAtBroker: true }),
    svc.triggered({ long: true, ltp: 89, tp: 120, sl: 90, slAtBroker: false }),
  ], ['tp', null, 'sl'], 'a stop at the broker is the broker\'s job; without one TradeLock exits');
  assert.equal(svc.pointValue('MCX_COMM', 'CRUDEOILM-17Nov2026-8300-CE'), 10);
  assert.equal(svc.pointValue('NSE_FNO', 'NIFTY-Nov2026-23000-CE'), 1);
});

test('chart: P&L at a price and the first TP / SL from the entry label', () => {
  assert.equal(pnlAt({ avg: 100, qty: 200 }, 110), 2000);
  assert.equal(pnlAt({ avg: 8300, qty: -2 }, 8280, 10), 400, 'short 2 lots of an MCX mini: 20 points x 2 x 10');
  assert.equal(defaultLevel('tp', { long: true, ltp: 180 }), 198);
  assert.equal(defaultLevel('sl', { long: true, ltp: 180 }), 162);
  assert.equal(defaultLevel('tp', { long: false, ltp: 180 }), 162);
});

function fakeBroker() {
  const calls = [], orders = new Map();
  let n = 0;
  return {
    calls, orders,
    async placeOrder(o) { const id = `O${++n}`; orders.set(id, { ...o, status: 'pending' }); calls.push(['place', o.type, o.side, o.qty, o.triggerPrice, o.price]); return { id, status: 'pending' }; },
    async modifyStopLoss(id, o) { calls.push(['modify', id, o.triggerPrice, o.qty]); Object.assign(orders.get(id), o); return { id }; },
    async cancelOrder(id) { calls.push(['cancel', id]); const o = orders.get(id); if (o.status === 'pending') o.status = 'failed'; return { status: 'cancelled' }; },
    async orderStatus(id) { const o = orders.get(id); return { status: o.status, filledQty: o.status === 'filled' ? o.qty : 0, qty: o.qty }; },
    async exitPosition(p) { calls.push(['exit', p.qty]); return { id: 'X' }; },
  };
}
// The service resolves the broker through a hook so tests can stand in for it.
const useBroker = broker => svc.BROKER.adapterFor = () => broker;

test('set a stop and a target: a stop-loss order at the broker; dragging moves it; the target exits after the stop is cancelled', async () => {
  const uid = createUser({ email: 'br@test', password: null, name: 'B' });
  const broker = fakeBroker(); useBroker(broker);
  const pos = { symbol: 'NIFTY-Nov2026-23000-CE', securityId: '501', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY', qty: 130, avg: 100, unrealized: 1300, realized: 0 };
  const book = orders => setBook(uid, { positions: [pos], orders, at: Date.now() });
  book([]);
  assert.equal(svc.priceOf(uid, pos), 110, 'price from the broker P&L: 100 + 1300 / 130');
  const acct = { user_id: uid, broker: 'dhan' };
  const b1 = await svc.setBracket(uid, acct, { securityId: '501', tp: 130, sl: 95 });
  assert.deepEqual(broker.calls[0], ['place', 'STOP_LOSS', 'SELL', 130, 95, 90.25]);
  assert.deepEqual([b1.tp, b1.sl, b1.slOrderId], [130, 95, 'O1']);
  book([{ id: 'O1' }]);
  await svc.setBracket(uid, acct, { securityId: '501', tp: 130, sl: 100 });
  assert.deepEqual(broker.calls.at(-1), ['modify', 'O1', 100, 130], 'the same order moves');
  await assert.rejects(svc.setBracket(uid, acct, { securityId: '501', tp: 130, sl: 112 }), /below the current price/);

  pos.unrealized = 130 * 31;   // price 131: the target
  await svc.watchBrackets(uid, acct);
  assert.deepEqual(broker.calls.slice(-2), [['cancel', 'O1'], ['exit', 130]], 'stop cancelled (and confirmed) before the market exit');
  assert.equal(bracketOf(uid, '501'), null, 'done: the bracket is gone');
});

test('the stop filled just before the target: no second sell', async () => {
  const uid = createUser({ email: 'br2@test', password: null, name: 'B2' });
  const broker = fakeBroker(); useBroker(broker);
  const pos = { symbol: 'X', securityId: '777', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY', qty: 65, avg: 100, unrealized: 650, realized: 0 };
  setBook(uid, { positions: [pos], orders: [], at: Date.now() });
  const acct = { user_id: uid, broker: 'dhan' };
  await svc.setBracket(uid, acct, { securityId: '777', tp: 120, sl: 95 });
  broker.orders.get('O1').status = 'filled';
  pos.unrealized = 65 * 21;   // looks like the target, but the stop already traded
  await svc.watchBrackets(uid, acct);
  assert.ok(!broker.calls.some(c => c[0] === 'exit'), 'no exit order');
});

test('position closed elsewhere: the resting stop is cancelled so it cannot open a new position', async () => {
  const uid = createUser({ email: 'br3@test', password: null, name: 'B3' });
  const broker = fakeBroker(); useBroker(broker);
  const pos = { symbol: 'Y', securityId: '888', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY', qty: 65, avg: 100, unrealized: 0, realized: 0 };
  setBook(uid, { positions: [pos], orders: [], at: Date.now() });
  const acct = { user_id: uid, broker: 'dhan' };
  await svc.setBracket(uid, acct, { securityId: '888', sl: 90 });
  setBook(uid, { positions: [], orders: [{ id: 'O1' }], at: Date.now() });
  await svc.watchBrackets(uid, acct);
  assert.deepEqual(broker.calls.at(-1), ['cancel', 'O1']);
  assert.equal(bracketOf(uid, '888'), null);
});
