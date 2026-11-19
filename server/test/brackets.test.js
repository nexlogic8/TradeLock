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

test('a stop moved seconds after it was placed (before the sync lists it) is modified, not placed twice', async () => {
  // 16 Nov 2026: SL set at 10.00, dragged to 10.50 four seconds later; the stale book sent a second stop, which the
  // broker took as a new short (rejected) while the first stayed resting and untracked.
  const uid = createUser({ email: 'br-race@test', password: null, name: 'R' });
  const broker = fakeBroker(); useBroker(broker);
  const pos = { symbol: 'NIFTY-Nov2026-24150-PE', securityId: '64404', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY', qty: 65, avg: 11.05, unrealized: 65 * 0.35, realized: 0 };
  setBook(uid, { positions: [pos], orders: [], at: Date.now() });   // the book never lists the new stop
  const acct = { user_id: uid, broker: 'dhan' };
  await svc.setBracket(uid, acct, { securityId: '64404', tp: 12.2, sl: 10 });
  const b = await svc.setBracket(uid, acct, { securityId: '64404', tp: 12.2, sl: 10.5 });
  assert.deepEqual(broker.calls.map(c => c[0]), ['place', 'modify'], 'one stop order, moved');
  assert.equal(b.slOrderId, 'O1');
});

test('a stop the broker rejects after "pending" is not saved as at the broker: TradeLock watches it and says why', async () => {
  const uid = createUser({ email: 'br-rej@test', password: null, name: 'J' });
  const broker = fakeBroker(); useBroker(broker);
  const place = broker.placeOrder;
  broker.placeOrder = async o => { const r = await place(o); Object.assign(broker.orders.get(r.id), { status: 'failed', reason: 'RMS:123:You have insufficient funds.' }); return r; };
  broker.orderStatus = async id => { const o = broker.orders.get(id); return { status: o.status, reason: o.reason, filledQty: 0, qty: o.qty }; };
  const pos = { symbol: 'Z', securityId: '999', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY', qty: 65, avg: 100, unrealized: 650, realized: 0 };
  setBook(uid, { positions: [pos], orders: [], at: Date.now() });
  const acct = { user_id: uid, broker: 'dhan' };
  await assert.rejects(svc.setBracket(uid, acct, { securityId: '999', sl: 95 }), /insufficient funds\.\)\. TradeLock is watching your stop-loss 95/);
  const b = bracketOf(uid, '999');
  assert.deepEqual([b.sl, b.slOrderId], [95, null], 'kept, watched by TradeLock (no order id)');
});

// ---- Super Order positions (Dhan holds the target and stop legs) ----
function fakeSuper(broker) {
  const so = new Map(); let n = 0;
  Object.assign(broker, {
    superOrders: so,
    async placeSuperOrder(o) { const id = `S${++n}`; so.set(id, { status: 'PENDING', legs: { TARGET_LEG: { status: 'PENDING', price: o.targetPrice }, STOP_LOSS_LEG: { status: 'PENDING', price: o.stopLossPrice } } }); broker.calls.push(['super', o.side, o.qty, o.targetPrice, o.stopLossPrice]); return { id, status: 'pending' }; },
    async modifySuperLeg(id, leg, price) { broker.calls.push(['superModify', id, leg, price]); so.get(id).legs[leg].price = price; return { id }; },
    async cancelSuperLeg(id, leg) { broker.calls.push(['superCancel', id, leg]); const s = so.get(id); if (leg === 'ENTRY_LEG') { s.status = 'CANCELLED'; for (const l of Object.values(s.legs)) l.status = 'CANCELLED'; } else s.legs[leg].status = 'CANCELLED'; return { status: 'cancelled' }; },
    async superOrder(id) { return so.get(id) || null; },
  });
  return broker;
}

test('a Super Order position: dragging moves its legs at Dhan; a removed leg cannot be set again; no TradeLock stop order', async () => {
  const uid = createUser({ email: 'br-super@test', password: null, name: 'S' });
  const broker = fakeSuper(fakeBroker()); useBroker(broker);
  const pos = { symbol: 'NIFTY-Nov2026-24150-PE', securityId: '64404', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY', qty: 65, avg: 11, unrealized: 0, realized: 0 };
  setBook(uid, { positions: [pos], orders: [], at: Date.now() });
  const acct = { user_id: uid, broker: 'dhan' };
  svc.saveSuperBracket(uid, { securityId: '64404', segment: 'NSE_FNO', symbol: pos.symbol, side: 1, qty: 65, tp: 15.4, sl: 8.8, superId: 'S9' });
  broker.superOrders.set('S9', { status: 'TRADED', legs: { TARGET_LEG: { status: 'PENDING' }, STOP_LOSS_LEG: { status: 'PENDING' } } });
  await svc.setBracket(uid, acct, { securityId: '64404', tp: 14, sl: 9.5 });
  assert.deepEqual(broker.calls, [['superModify', 'S9', 'TARGET_LEG', 14], ['superModify', 'S9', 'STOP_LOSS_LEG', 9.5]], 'both legs moved, no stop order placed');
  await svc.setBracket(uid, acct, { securityId: '64404', tp: null, sl: 9.5 });
  assert.deepEqual(broker.calls.at(-1), ['superCancel', 'S9', 'TARGET_LEG']);
  await assert.rejects(svc.setBracket(uid, acct, { securityId: '64404', tp: 13, sl: 9.5 }), e => e.code === 'SUPER_LEG_GONE');
  // TradeLock never exits a Super Order position itself at its levels: Dhan's legs do.
  pos.unrealized = 65 * -3;   // price 8: below the stop
  await svc.watchBrackets(uid, acct);
  assert.ok(!broker.calls.some(c => c[0] === 'exit' || c[0] === 'place'), 'no TradeLock exit or stop order');
});

test('a Super Order position closed (a leg traded, or closed elsewhere): what is left at Dhan is cancelled; still entering: left alone', async () => {
  const uid = createUser({ email: 'br-super2@test', password: null, name: 'S2' });
  const broker = fakeSuper(fakeBroker()); useBroker(broker);
  const acct = { user_id: uid, broker: 'dhan' };
  setBook(uid, { positions: [], orders: [], at: Date.now() });
  svc.saveSuperBracket(uid, { securityId: '1', segment: 'NSE_FNO', symbol: 'A', side: 1, qty: 65, tp: 20, sl: 8, superId: 'S1' });
  broker.superOrders.set('S1', { status: 'PENDING', legs: {} });
  await svc.watchBrackets(uid, acct);
  assert.ok(bracketOf(uid, '1'), 'entry still working: kept');
  assert.equal(broker.calls.length, 0);
  broker.superOrders.set('S1', { status: 'TRADED', legs: { TARGET_LEG: { status: 'PENDING' }, STOP_LOSS_LEG: { status: 'CANCELLED' } } });
  await svc.watchBrackets(uid, acct);   // flat (closed in the broker app), a leg still resting
  assert.deepEqual(broker.calls, [['superCancel', 'S1', 'ENTRY_LEG']]);
  assert.equal(bracketOf(uid, '1'), null);
});

test('TradeLock exiting a Super Order position cancels its legs first', async () => {
  const uid = createUser({ email: 'br-super3@test', password: null, name: 'S3' });
  const broker = fakeSuper(fakeBroker()); useBroker(broker);
  const acct = { user_id: uid, broker: 'dhan' };
  svc.saveSuperBracket(uid, { securityId: '2', segment: 'NSE_FNO', symbol: 'B', side: 1, qty: 65, tp: 20, sl: 8, superId: 'S5' });
  await svc.releaseSuper(uid, acct, '2');
  assert.deepEqual(broker.calls, [['superCancel', 'S5', 'ENTRY_LEG']]);
  assert.equal(bracketOf(uid, '2'), null);
});

test('before TradeLock exits a position, its stop-loss order is cancelled and confirmed; a stop that already traded leaves nothing to exit', async () => {
  const uid = createUser({ email: 'br-exit@test', password: null, name: 'E' });
  const broker = fakeBroker(); useBroker(broker);
  const pos = { symbol: 'NIFTY-Nov2026-26350-CE', securityId: '700', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY', qty: 65, avg: 8.5, unrealized: 0, realized: 0 };
  setBook(uid, { positions: [pos], orders: [], at: Date.now() });
  const acct = { user_id: uid, broker: 'dhan' };
  await svc.setBracket(uid, acct, { securityId: '700', sl: 7.7 });
  assert.deepEqual(await svc.releaseForExit(uid, acct, '700'), { filledQty: 0 });
  assert.deepEqual(broker.calls.at(-1), ['cancel', 'O1'], 'the stop is cancelled before the exit');
  assert.equal(bracketOf(uid, '700'), null);
  // The stop traded just before: no exit (it would open a short).
  await svc.setBracket(uid, acct, { securityId: '700', sl: 7.7 });
  broker.orders.get('O2').status = 'filled';
  assert.deepEqual(await svc.releaseForExit(uid, acct, '700'), { closed: true });
  // No TP / SL at all: nothing to do.
  assert.deepEqual(await svc.releaseForExit(uid, acct, '700'), {});
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
