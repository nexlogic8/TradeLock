// StoxKart trading adapter (positions, orders, fills, funds, order placement / status / cancel / modify, exits) and the
// "trade through StoxKart" switch: Dhan keeps the market data, StoxKart gets every order.
process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
const { test, before, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { createServer } = await import('node:http');
const { createHandler } = await import('../src/lib/app.js');
const { buildRouter } = await import('../src/modules/index.js');
const { stmt } = await import('../src/db/index.js');
const { encrypt } = await import('../src/lib/crypto.js');
const { setBook } = await import('../src/modules/broker/book.js');
const { upsertAccount, adapterFor } = await import('../src/modules/broker/registry.js');
const { createStoxkartAdapter, stoxkartTime, protectedPrice } = await import('../src/modules/broker/adapters/stoxkart.js');

const CREDS = { clientId: 'SV54275', password: 'pw', apiKey: 'KEY12345678', apiSecret: 'SECRET987654321', totpSecret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' };
const LTP = async () => 150;
function fakeStoxkart({ expireOnce = false } = {}) {
  const calls = [], orders = [];
  let logins = 0, expired = expireOnce, seq = 0;
  const ok = data => ({ status: 200, text: JSON.stringify({ status: 'success', data }) });
  const transport = async (method, url, { headers, body }) => {
    const path = url.replace('https://openapi.stoxkart.com', '');
    calls.push({ method, path, body, token: headers['X-Access-Token'], algo: headers['X-Algo-Id'] });
    if (path.startsWith('/auth/login')) { logins++; return ok({ token: 'REQ' }); }
    if (path.startsWith('/auth/twofa/verify')) return ok({ request_token: 'AUTH' });
    if (path === '/auth/token') return ok({ access_token: `ACCESS-${logins}` });
    if (expired) { expired = false; return { status: 401, text: JSON.stringify({ status: 'failed', message: 'Invalid access token' }) }; }
    if (path === '/portfolio/positions') return ok([
      { token: '51334', exchange: 'NFO', net_quantity: '130', buy_quantity: '130', sell_quantity: '0', buy_average_price: '150.0000', sell_average_price: '0', last_trade_price: '160.00', product_type: 'I', cf_buy_value: '0', cf_sell_value: '0' },
      { token: '51346', exchange: 'NFO', net_quantity: '0', buy_quantity: '780', sell_quantity: '780', buy_average_price: '39.9083', sell_average_price: '40.6000', last_trade_price: '60.65', product_type: 'M', cf_buy_value: '0', cf_sell_value: '0' }]);
    if (path === '/funds') return ok({ cash: '4064.00', net: '2560.00', available_limit: '2559.86', utilized_limit: '-268.00', realised_profit: '542.75', collateral: '0.00' });
    if (path === '/reports/order-book') return ok(orders);
    if (path === '/reports/trade-book') return ok([{ action: 'BUY', trade_id: 'T1', order_id: 'O1', exchange: 'NSE', symbol: 'NIFTY-27Oct2026-22600-CE', token: '51334', price: '150.0000', quantity: '130', order_date_time: '26-10-2026 09:15:03' }]);
    if (method === 'POST' && path === '/orders/normal') {
      const id = `O${++seq}`;
      orders.push({ order_id: id, token: body.token, exchange: body.exchange, symbol: 'NIFTY-27Oct2026-22600-CE', action: body.action, order_type: body.order_type, quantity: body.quantity,
        traded_quantity: body.order_type === 'LIMIT' ? body.quantity : '0', trade_average_price: body.order_type === 'LIMIT' ? '150.50' : '0', price: body.price, status: body.order_type === 'LIMIT' ? 'EXECUTED' : 'PENDING', reason: '' });
      return ok({ order_id: id });
    }
    if (method === 'DELETE' && path.startsWith('/orders/normal/')) { const o = orders.find(x => x.order_id === path.split('/').at(-1)); if (o) o.status = 'CANCELLED'; return ok({}); }
    if (method === 'PUT' && path.startsWith('/orders/normal/')) { const o = orders.find(x => x.order_id === path.split('/').at(-1)); Object.assign(o, { price: body.price, trigger_price: body.trigger_price }); return ok({}); }
    return { status: 404, text: '{}' };
  };
  return { calls, orders, transport, logins: () => logins };
}

test('times: StoxKart "26-10-2026 13:41:33" and "26-Oct-2026 13:41:33" are IST', () => {
  assert.equal(stoxkartTime('26-10-2026 13:41:33'), Date.parse('2026-10-26T13:41:33+05:30'));
  assert.equal(stoxkartTime('26-Oct-2026 13:41:33'), Date.parse('2026-10-26T13:41:33+05:30'));
});

test('snapshot: positions (symbol from the fills, NFO → NSE_FNO, P&L), funds, open orders only, fills', async () => {
  const f = fakeStoxkart(), sx = createStoxkartAdapter({ creds: CREDS, ltp: LTP, transport: f.transport });
  const s = await sx.snapshot();
  const [open, flat] = s.positions;
  assert.deepEqual([open.symbol, open.securityId, open.exchangeSegment, open.productType, open.qty, open.unrealized], ['NIFTY-27Oct2026-22600-CE', '51334', 'NSE_FNO', 'INTRADAY', 130, 1300]);
  assert.deepEqual([flat.qty, flat.productType, flat.realized], [0, 'MARGIN', 539.53]);
  assert.deepEqual([s.funds.available, s.funds.used], [2559.86, 268]);
  assert.deepEqual(s.orders, []);
  assert.deepEqual([s.trades[0].id, s.trades[0].side, s.trades[0].qty, s.trades[0].ts], ['stoxkart:T1', 'BUY', 130, Date.parse('2026-10-26T09:15:03+05:30')]);
});

test('orders: market buy and a stop-loss limit at StoxKart, status from the order book, modify and cancel the stop', async () => {
  const f = fakeStoxkart(), sx = createStoxkartAdapter({ creds: CREDS, ltp: LTP, transport: f.transport, now: () => 0 });
  const buy = await sx.placeOrder({ symbol: 'X', side: 'BUY', qty: 130, type: 'MARKET', securityId: '51334', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY' });
  const sent = f.calls.find(c => c.method === 'POST' && c.path === '/orders/normal').body;
  assert.deepEqual([sent.action, sent.exchange, sent.token, sent.order_type, sent.product_type, sent.quantity, sent.price, sent.validity], ['BUY', 'NFO', '51334', 'LIMIT', 'INTRADAY', '130', '157.50', 'DAY'], 'market → limit 5% above the 150 LTP');
  assert.deepEqual(await sx.orderStatus(buy.id), { status: 'filled', price: 150.5, filledQty: 130, qty: 130 });
  const sl = await sx.placeOrder({ symbol: 'X', side: 'SELL', qty: 130, type: 'STOP_LOSS', triggerPrice: 120.4, price: 108.4, securityId: '51334', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY' });
  const slBody = f.calls.filter(c => c.method === 'POST' && c.path === '/orders/normal')[1].body;
  assert.deepEqual([slBody.order_type, slBody.trigger_price, slBody.price], ['STOPLOSS_LIMIT', '120.40', '108.40']);
  assert.equal((await sx.orderStatus(sl.id)).status, 'pending');
  await sx.modifyStopLoss(sl.id, { triggerPrice: 150.5, price: 135.45, qty: 130 });
  const put = f.calls.find(c => c.method === 'PUT');
  assert.deepEqual([put.path, put.body.order_type, put.body.trigger_price, put.body.token, put.body.exchange, put.body.quantity], [`/orders/normal/${sl.id}`,'STOPLOSS_LIMIT', '150.5', '51334', 'NFO', '130']);
  await sx.cancelOrder(sl.id);
  assert.equal((await sx.orderStatus(sl.id)).status, 'failed', 'cancelled');
});
test('market orders: a limit 5% past the live price on the 0.05 tick; no live price, no order; stop-loss-market as a limit', async () => {
  assert.equal(protectedPrice('BUY', 100), 105); assert.equal(protectedPrice('SELL', 100), 95);
  assert.equal(protectedPrice('BUY', 72.3).toFixed(2), '75.95'); assert.equal(protectedPrice('SELL', 72.3).toFixed(2), '68.65');
  assert.equal(protectedPrice('SELL', 0.05).toFixed(2), '0.05', 'never below one tick');
  const f = fakeStoxkart(), none = createStoxkartAdapter({ creds: CREDS, ltp: async () => null, transport: f.transport, now: () => 0 });
  await assert.rejects(none.exitPosition({ qty: 65, securityId: '51334', exchangeSegment: 'NSE_FNO' }), /no live price/);
  assert.ok(!f.calls.some(c => c.path === '/orders/normal'), 'nothing sent without a price');
  const g = fakeStoxkart(), sx = createStoxkartAdapter({ creds: CREDS, ltp: LTP, transport: g.transport, now: () => 0 });
  await sx.exitPosition({ qty: -65, securityId: '51334', exchangeSegment: 'NSE_FNO' });
  const sent = g.calls.find(c => c.path === '/orders/normal').body;
  assert.deepEqual([sent.action, sent.order_type, sent.price], ['BUY', 'LIMIT', '157.50']);
  await sx.placeOrder({ side: 'SELL', qty: 65, type: 'STOP_LOSS_MARKET', triggerPrice: 120, securityId: '51334', exchangeSegment: 'NSE_FNO' });
  const sl = g.calls.filter(c => c.path === '/orders/normal').at(-1).body;
  assert.deepEqual([sl.order_type, sl.trigger_price, sl.price], ['STOPLOSS_LIMIT', '120.00', '114.00']);
  // A caller's own fresh price and band (the Gap entry's first tick): no price request, its band.
  const h = fakeStoxkart(); let asked = 0;
  const gx = createStoxkartAdapter({ creds: CREDS, ltp: async () => { asked++; return 150; }, transport: h.transport, now: () => 0 });
  await gx.placeOrder({ side: 'BUY', qty: 65, type: 'MARKET', refPrice: 88.1, marketBand: 0.15, securityId: '51334', exchangeSegment: 'NSE_FNO' });
  assert.equal(asked, 0, 'no price lookup');
  assert.equal(h.calls.find(c => c.path === '/orders/normal').body.price, '101.35', '88.10 + 15% = 101.315, up to the tick');
});
test('every order carries the SEBI algo ID header: 99999 by default, or the one saved with the link', async () => {
  const f = fakeStoxkart(), sx = createStoxkartAdapter({ creds: CREDS, ltp: LTP, transport: f.transport, now: () => 0 });
  await sx.placeOrder({ side: 'BUY', qty: 65, type: 'MARKET', securityId: '51334', exchangeSegment: 'NSE_FNO' });
  assert.equal(f.calls.find(c => c.path === '/orders/normal').algo, '99999');
  const g = fakeStoxkart(), own = createStoxkartAdapter({ creds: { ...CREDS, algoId: '12345' }, ltp: LTP, transport: g.transport, now: () => 0 });
  await own.exitPosition({ qty: 65, securityId: '51334', exchangeSegment: 'NSE_FNO' });
  assert.equal(g.calls.find(c => c.path === '/orders/normal').algo, '12345');
});

test('above the freeze quantity the order goes as legs; an exit sells the whole position at market', async () => {
  const f = fakeStoxkart(), sx = createStoxkartAdapter({ creds: CREDS, ltp: LTP, transport: f.transport, now: () => 0 });
  const r = await sx.placeOrder({ side: 'BUY', qty: 7085, type: 'MARKET', securityId: '51334', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY' });
  assert.deepEqual(f.orders.map(o => o.quantity), ['3510', '3510', '65']);
  assert.equal(r.id, 'O1,O2,O3');
  assert.deepEqual(await sx.orderStatus(r.id), { status: 'filled', price: 150.5, filledQty: 7085, qty: 7085 });
  await sx.exitPosition({ securityId: '51334', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY', qty: 130 });
  assert.deepEqual([f.orders.at(-1).action, f.orders.at(-1).quantity, f.orders.at(-1).order_type], ['SELL', '130', 'LIMIT']);
  await assert.rejects(sx.placeOrder({ side: 'BUY', qty: 20, type: 'MARKET', securityId: '1', exchangeSegment: 'BSE_FNO' }), /does not trade BSE_FNO/);
});

test('an expired session logs in again once and repeats the call', async () => {
  const f = fakeStoxkart({ expireOnce: true }), sx = createStoxkartAdapter({ creds: CREDS, ltp: LTP, transport: f.transport });
  await sx.verify();
  assert.equal(f.logins(), 2);
  assert.equal(f.calls.filter(c => c.path === '/funds').at(-1).token, 'ACCESS-2');
});

// ---- the switch ----
let server, uid, base, cookie;
const call = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
before(async () => {
  server = createServer(createHandler(buildRouter()));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(base + '/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'skt@example.com', password: 'longpassword' }) });
  cookie = res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  uid = stmt('SELECT id FROM users WHERE email = ?').get('skt@example.com').id;
  upsertAccount(uid, { broker: 'dhan', clientId: 'C777', accessToken: 'test-token-not-real-0123456789' });
});
after(() => server.close());

test('trade through StoxKart: needs a verified link and nothing open; then orders go to StoxKart, data stays on Dhan', async () => {
  setBook(uid, { positions: [], orders: [], at: Date.now() });
  assert.equal((await call('POST', '/api/brokers/links/stoxkart/trade-via', { on: true })).status, 400, 'no verified link yet');
  stmt(`INSERT INTO broker_links (user_id, broker, client_id, creds_enc, status, created_at, updated_at) VALUES (?, 'stoxkart', 'SV54275', ?, 'verified', 1, 1)`).run(uid, encrypt(JSON.stringify(CREDS)));
  setBook(uid, { positions: [{ securityId: '51334', symbol: 'X', qty: 65 }], orders: [], at: Date.now() });
  const busy = await call('POST', '/api/brokers/links/stoxkart/trade-via', { on: true });
  assert.equal(busy.status, 409);
  assert.match(busy.body.message, /1 open position/);
  setBook(uid, { positions: [], orders: [], at: Date.now() });
  const r = await call('POST', '/api/brokers/links/stoxkart/trade-via', { on: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.link.trading, true);
  const acct = stmt('SELECT * FROM broker_accounts WHERE user_id = ?').get(uid), a = adapterFor(acct);
  assert.deepEqual([a.label, a.tradingBroker, typeof a.optionChain, typeof a.intradayCandles, a.activateKillSwitch], ['StoxKart', 'stoxkart', 'function', 'function', undefined]);
  assert.equal((await call('DELETE', '/api/brokers/links/stoxkart')).status, 400, 'cannot remove the link while it trades');
  const back = await call('POST', '/api/brokers/links/stoxkart/trade-via', { on: false });
  assert.equal(back.body.link.trading, false);
  assert.equal(adapterFor(stmt('SELECT * FROM broker_accounts WHERE user_id = ?').get(uid)).label, 'Dhan');
});

test('each trading broker keeps its own switches and P&L: StoxKart starts off and empty, Dhan comes back as it was', async () => {
  setBook(uid, { positions: [], orders: [], at: Date.now() });
  stmt('UPDATE broker_accounts SET agent_on = 1, algo_on = 1, gap_on = 1, manual_on = 1, trade_via = ? WHERE user_id = ?').run('own', uid);
  stmt(`INSERT OR REPLACE INTO day_state (user_id, day, realized, entries) VALUES (?, '2026-10-23', -5000, 7)`).run(uid);
  stmt(`INSERT INTO trades (user_id, day, ts, kind, ext_id, symbol, side, qty, price, status) VALUES (?, '2026-10-23', 1, 'exec', 'dhan:1', 'X', 'BUY', 65, 100, 'filled')`).run(uid);
  stmt(`INSERT INTO broker_pnl_days (user_id, day, gross, charges, net, trades, wins, losses) VALUES (?, '2026-10-23', -4900, 100, -5000, 2, 0, 1)`).run(uid);
  const count = t => stmt(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`).get(uid).n;
  assert.equal((await call('POST', '/api/brokers/links/stoxkart/trade-via', { on: true })).status, 200);
  const sk = stmt('SELECT agent_on, algo_on, gap_on, manual_on FROM broker_accounts WHERE user_id = ?').get(uid);
  assert.deepEqual(sk, { agent_on: 0, algo_on: 0, gap_on: 0, manual_on: 0 }, 'StoxKart starts with everything off');
  assert.equal(stmt(`SELECT COUNT(*) AS n FROM day_state WHERE user_id = ? AND day = '2026-10-23'`).get(uid).n, 0);
  assert.deepEqual([count('trades'), count('broker_pnl_days')], [0, 0], 'none of Dhan\'s P&L shows under StoxKart');
  stmt('UPDATE broker_accounts SET agent_on = 1 WHERE user_id = ?').run(uid);   // turned on for StoxKart
  assert.equal((await call('POST', '/api/brokers/links/stoxkart/trade-via', { on: false })).status, 200);
  const dh = stmt('SELECT agent_on, algo_on, gap_on, manual_on FROM broker_accounts WHERE user_id = ?').get(uid);
  assert.deepEqual(dh, { agent_on: 1, algo_on: 1, gap_on: 1, manual_on: 1 });
  assert.equal(stmt(`SELECT realized FROM day_state WHERE user_id = ? AND day = '2026-10-23'`).get(uid).realized, -5000);
  assert.deepEqual([count('trades'), count('broker_pnl_days')], [1, 1]);
  assert.equal((await call('POST', '/api/brokers/links/stoxkart/trade-via', { on: true })).status, 200);
  assert.equal(stmt('SELECT agent_on FROM broker_accounts WHERE user_id = ?').get(uid).agent_on, 1, 'StoxKart\'s own switch came back');
});
