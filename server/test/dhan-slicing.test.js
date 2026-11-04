// Orders above the freeze quantity: Dhan's slicing API places several orders; the adapter keeps them as one
// ("A,B,C") for status, cancel and modify, and slices large exits (the kill switch too).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDhanAdapter } from '../src/modules/broker/adapters/dhan.js';

function fake(orders = {}) {
  const seen = [];
  const transport = async (method, url, { body } = {}) => {
    const path = url.replace(/^https?:\/\/[^/]+(\/v2)?/, '');
    seen.push([method, path, body && (typeof body === 'string' ? JSON.parse(body) : body)]);
    if (method === 'POST' && path === '/orders/slicing') return { status: 200, text: JSON.stringify([{ orderId: 'S1', orderStatus: 'PENDING' }, { orderId: 'S2', orderStatus: 'PENDING' }]) };
    if (method === 'POST' && path === '/orders') return { status: 200, text: JSON.stringify({ orderId: 'O1', orderStatus: 'PENDING' }) };
    if (method === 'GET' && path.startsWith('/orders/')) return { status: 200, text: JSON.stringify(orders[path.split('/').at(-1)] || {}) };
    if (method === 'DELETE') return path.endsWith('S1') ? { status: 400, text: JSON.stringify({ errorMessage: 'already traded' }) } : { status: 200, text: '{}' };
    if (method === 'PUT') return { status: 200, text: '{}' };
    return { status: 404, text: '{}' };
  };
  return { seen, dhan: createDhanAdapter({ clientId: 'C1', accessToken: 'x'.repeat(30), transport }) };
}
const base = { symbol: 'NIFTY X', side: 'BUY', securityId: '51334', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY' };

test('slice: true goes to /orders/slicing and comes back as one id for all legs; small orders are unchanged', async () => {
  const { seen, dhan } = fake();
  assert.equal((await dhan.placeOrder({ ...base, qty: 5980, type: 'MARKET', slice: true })).id, 'S1,S2');
  assert.deepEqual([seen[0][1], seen[0][2].quantity], ['/orders/slicing', 5980]);
  assert.equal((await dhan.placeOrder({ ...base, qty: 650, type: 'MARKET' })).id, 'O1');
  assert.equal(seen[1][1], '/orders');
});

test('sliced status: filled when every leg traded (qty-weighted price), pending while one works, partial fills summed', async () => {
  const done = fake({ S1: { orderStatus: 'TRADED', quantity: 1755, filledQty: 1755, averageTradedPrice: 150 }, S2: { orderStatus: 'TRADED', quantity: 585, filledQty: 585, averageTradedPrice: 154 } }).dhan;
  assert.deepEqual(await done.orderStatus('S1,S2'), { status: 'filled', price: 151, filledQty: 2340, qty: 2340 });
  const half = fake({ S1: { orderStatus: 'TRADED', quantity: 1755, filledQty: 1755, averageTradedPrice: 150 }, S2: { orderStatus: 'PENDING', quantity: 585, filledQty: 0 } }).dhan;
  assert.deepEqual(await half.orderStatus('S1,S2'), { status: 'pending', price: 150, filledQty: 1755, qty: 2340 });
  const cut = fake({ S1: { orderStatus: 'TRADED', quantity: 1755, filledQty: 1755, averageTradedPrice: 150 }, S2: { orderStatus: 'CANCELLED', quantity: 585, filledQty: 0 } }).dhan;
  const s = await cut.orderStatus('S1,S2');
  assert.deepEqual([s.status, s.filledQty], ['failed', 1755], 'cancelled leg: the traded 1,755 still reported');
});

test('cancel and modify act on every leg; cancel only fails when no leg could be cancelled', async () => {
  const { seen, dhan } = fake({ S1: { quantity: 1755 }, S2: { quantity: 585 } });
  await dhan.cancelOrder('S1,S2');   // S1 refuses (traded), S2 cancels: fine
  assert.deepEqual(seen.filter(x => x[0] === 'DELETE').map(x => x[1]), ['/orders/S1', '/orders/S2']);
  await assert.rejects(dhan.cancelOrder('S1'));
  await dhan.modifyStopLoss('S1,S2', { triggerPrice: 150, price: 135, qty: 2340 });
  assert.deepEqual(seen.filter(x => x[0] === 'PUT').map(x => [x[1], x[2].quantity]), [['/orders/S1', 1755], ['/orders/S2', 585]]);
});

test('exits above 3,510 go straight to slicing; up to it a plain order (sliced only if Dhan refuses it)', async () => {
  const { seen, dhan } = fake();
  assert.equal((await dhan.exitPosition({ securityId: '1', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY', qty: 5980 })).id, 'S1,S2');
  assert.equal((await dhan.exitPosition({ securityId: '1', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY', qty: 650 })).id, 'O1');
  assert.deepEqual(seen.map(x => x[1]), ['/orders/slicing', '/orders']);
});

test('an account that registered only the server IPv6 sends its calls over IPv6 (one static IP fits one account)', async () => {
  const { setServerIpsForTest } = await import('../src/lib/serverip.js');
  setServerIpsForTest('13.235.49.88', '2406:da1a:13ae:3200:1704:8ef:5040:3411');
  const seen = [];
  const transport = async (method, url, opts) => {
    seen.push([url.replace(/^https?:\/\/[^/]+(\/v2)?/, ''), opts.family]);
    if (url.endsWith('/ip/getIP')) return { status: 200, text: JSON.stringify({ primaryIP: '2406:DA1A:13AE:3200:1704:8EF:5040:3411', secondaryIP: '', ordersAllowed: opts.family === 6 }) };
    if (url.endsWith('/profile')) return { status: 200, text: '{}' };
    return { status: 200, text: JSON.stringify({ orderId: '1', orderStatus: 'PENDING' }) };
  };
  const a = createDhanAdapter({ clientId: 'C2', accessToken: 'test-token-not-real-0123456789', transport });
  await a.placeOrder({ symbol: 'X', side: 'BUY', qty: 65, type: 'MARKET', securityId: '51334', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY' });
  assert.deepEqual(seen.slice(0, 2), [['/ip/getIP', 4], ['/orders', 6]], 'learns the registered IP, then orders over IPv6');
  assert.equal((await a.permissions()).ordersAllowed, true, 'permission is read over IPv6');
  setServerIpsForTest('13.235.49.88', '2406:da1a:13ae:3200:1704:8ef:5040:3411');
  const b = createDhanAdapter({ clientId: 'C1', accessToken: 'test-token-not-real-0123456789', transport: async (m, url, o) => { seen.push(['b' + url.slice(-9), o.family]); return url.endsWith('/ip/getIP') ? { status: 200, text: JSON.stringify({ primaryIP: '13.235.49.88', ordersAllowed: true }) } : { status: 200, text: JSON.stringify({ orderId: '2', orderStatus: 'PENDING' }) }; } });
  await b.placeOrder({ symbol: 'X', side: 'BUY', qty: 65, type: 'MARKET', securityId: '51334', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY' });
  assert.equal(seen.at(-1)[1], 4, 'the IPv4 account stays on IPv4');
  setServerIpsForTest(null, null);
});

test('4 Nov 2026: Dhan split a plain order itself and answered order id "0": the orders it made are read back from the book', async () => {
  const ist = ms => new Date(ms + 19_800_000).toISOString().slice(0, 19).replace('T', ' ');
  const now = Date.now(), seen = [];
  const book = [
    { orderId: 'A1', securityId: '39952', transactionType: 'BUY', quantity: 1755, createTime: ist(now - 1000) },
    { orderId: 'B1', securityId: '39952', transactionType: 'BUY', quantity: 780, createTime: ist(now - 1000) },
    { orderId: 'OLD', securityId: '39952', transactionType: 'BUY', quantity: 65, createTime: ist(now - 3_600_000) },
    { orderId: 'X', securityId: '11111', transactionType: 'BUY', quantity: 780, createTime: ist(now - 500) },
  ];
  const transport = async (method, url) => {
    const path = url.replace(/^https?:\/\/[^/]+(\/v2)?/, '');
    seen.push([method, path]);
    if (method === 'POST' && path === '/orders') return { status: 200, text: JSON.stringify({ orderId: '0', orderStatus: 'TRANSIT' }) };
    if (method === 'GET' && path === '/orders') return { status: 200, text: JSON.stringify(book) };
    return { status: 404, text: '{}' };
  };
  const dhan = createDhanAdapter({ clientId: 'C1', accessToken: 'x'.repeat(30), transport });
  const placed = await dhan.placeOrder({ ...base, securityId: '39952', qty: 2535, type: 'MARKET' });
  assert.deepEqual(placed.id.split(',').sort(), ['A1', 'B1'], 'the two orders Dhan made, not "0"');
  await assert.rejects(dhan.placeOrder({ ...base, securityId: '22222', qty: 2535, type: 'MARKET' }), /no order id/, 'nothing found: unknown, not "0"');
});
