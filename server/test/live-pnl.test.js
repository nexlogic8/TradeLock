// Live P&L from market ticks (server/src/modules/risk/live-pnl.js).
process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { livePnlOf, pointValue } = await import('../src/modules/risk/live-pnl.js');

test('open P&L from the latest tick; realized as the broker reports it; no tick: the broker figure', () => {
  const positions = [
    { securityId: '1', exchangeSegment: 'NSE_FNO', symbol: 'NIFTY-Nov2026-23000-CE', qty: 75, avg: 100, unrealized: 300, realized: 0 },
    { securityId: '2', exchangeSegment: 'MCX_COMM', symbol: 'CRUDEOILM-17Nov2026-8300-CE', qty: -2, avg: 180, unrealized: 0, realized: 0 },
    { securityId: '3', exchangeSegment: 'BSE_FNO', symbol: 'SENSEX-Nov2026-82000-PE', qty: 20, avg: 50, unrealized: -40, realized: 0 },
    { securityId: '4', exchangeSegment: 'NSE_FNO', symbol: 'CLOSED', qty: 0, avg: 0, unrealized: 0, realized: 1250 },
  ];
  const ticks = { 1: 104.5, 2: 176 };   // no tick for '3'
  const v = livePnlOf(positions, p => ticks[p.securityId] ?? null);
  assert.equal(v.positions['1'].unrealized, 337.5, 'NSE: (104.5 − 100) × 75');
  assert.equal(v.positions['2'].unrealized, 80, 'MCX mini short 2 lots: (176 − 180) × −2 × 10');
  assert.deepEqual(v.positions['3'], { ltp: null, unrealized: -40 }, 'BSE, no fresh tick: the broker figure');
  assert.equal(v.positions['4'], undefined, 'closed: no open P&L');
  assert.deepEqual([v.realized, v.unrealized, v.pnl], [1250, 377.5, 1627.5]);
  assert.deepEqual([pointValue({ exchangeSegment: 'MCX_COMM', symbol: 'GOLDM-...' }), pointValue({ exchangeSegment: 'NSE_FNO', symbol: 'NIFTY' })], [10, 1]);
});

test('charges from today\'s fills: Dhan\'s rates; MCX quantity in lots (CRUDEOIL 100, the mini 10); one brokerage per order', async () => {
  const { estimateCharges, mcxLotValue, fillMultiplier, exchangeOf } = await import('../src/modules/risk/charges.js');
  assert.deepEqual(['CRUDEOIL-17Nov2026-8000-PE', 'CRUDEOILM-17Nov2026-8300-CE', 'GOLDM-26Nov2026-136000-CE', 'GOLD-05Dec2026-130000-CE', 'NIFTY-Nov2026-23000-CE'].map(mcxLotValue), [100, 10, 10, 100, 1]);
  assert.deepEqual([fillMultiplier('CRUDEOIL-17Nov2026-8000-PE'), fillMultiplier('CRUDEOIL 17 NOV 8000 PUT')], [100, 1], 'today\'s trades count lots; the history counts units');
  assert.deepEqual(['SENSEX-Nov2026-81900-CE', 'CRUDEOILM-x', 'NIFTY-x'].map(exchangeOf), ['BSE', 'MCX', 'NSE']);
  // NIFTY: buy 75 @ 100 then sell 75 @ 110, two orders.
  const c = estimateCharges([
    { symbol: 'NIFTY-Nov2026-23000-CE', side: 'BUY', qty: 75, price: 100, orderId: 'a' },
    { symbol: 'NIFTY-Nov2026-23000-CE', side: 'SELL', qty: 75, price: 110, orderId: 'b' },
  ]);
  // brokerage 40; STT 0.15% × 8250 = 12.375; exchange 0.03503% × 15750 = 5.517; SEBI 0.0158; stamp 0.003% × 7500 = 0.225; GST 18% × 45.53 = 8.196
  assert.deepEqual([c.orders, c.brokerage, c.stt, c.exchange, c.stamp, c.total], [2, 40, 12.38, 5.52, 0.23, 66.33]);
  assert.equal(estimateCharges([{ symbol: 'X-a', side: 'BUY', qty: 1, price: 1, orderId: 'o' }, { symbol: 'X-a', side: 'BUY', qty: 1, price: 1, orderId: 'o' }]).orders, 1, 'two fills of one order: one brokerage');
});
