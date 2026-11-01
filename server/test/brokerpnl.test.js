// P&L calendar from the broker's trade history: FIFO matching, charges, expiry, paging, sync, calendar merge.
process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { stmt } = await import('../src/db/index.js');
const { encrypt } = await import('../src/lib/crypto.js');
const { createUser } = await import('../src/modules/auth/service.js');
const { dailyPnl, syncBrokerPnl } = await import('../src/modules/analytics/brokerpnl.js');
const { pnlCalendar } = await import('../src/modules/analytics/service.js');
const { createDhanAdapter } = await import('../src/modules/broker/adapters/dhan.js');
const { adapterFor } = await import('../src/modules/broker/registry.js');

const at = (day, hhmm) => Date.parse(`${day}T${hhmm}:00+05:30`);
let n = 0;
const fill = (day, hhmm, side, qty, price, extra = {}) => ({ id: `f${++n}`, orderId: `o${n}`, ts: at(day, hhmm), inst: 'NSE_FNO:1', side, qty, price, charges: 0, ...extra });

test('intraday long and short round trips, charges per day', () => {
  const days = dailyPnl([
    fill('2026-10-05', '09:20', 'BUY', 75, 100, { charges: 20 }),
    fill('2026-10-05', '09:40', 'SELL', 75, 110, { charges: 22 }),          // +750
    fill('2026-10-05', '10:00', 'SELL', 50, 200, { inst: 'NSE_FNO:2' }),     // short
    fill('2026-10-05', '10:30', 'BUY', 50, 230, { inst: 'NSE_FNO:2' }),      // −1500
  ], '2026-10-10');
  const d = days.get('2026-10-05');
  assert.equal(d.gross, -750);
  assert.equal(d.charges, 42);
  assert.equal(d.trades, 4);
  assert.deepEqual([d.wins, d.losses], [1, 1]);
});

test('partial exits and positions carried to a later day', () => {
  const days = dailyPnl([
    fill('2026-10-05', '09:20', 'BUY', 100, 50),
    fill('2026-10-05', '09:21', 'BUY', 100, 60),
    fill('2026-10-05', '15:00', 'SELL', 150, 70),   // FIFO: 100×20 + 50×10 = 2500
    fill('2026-10-06', '09:30', 'SELL', 50, 40),    // remaining 50 @60 → −1000 on the 6th
  ], '2026-10-10');
  assert.equal(days.get('2026-10-05').gross, 2500);
  assert.equal(days.get('2026-10-06').gross, -1000);
});

test('options left open after expiry count as expired worthless', () => {
  const days = dailyPnl([
    fill('2026-10-05', '09:20', 'BUY', 75, 40, { option: true, expiry: '2026-10-06' }),
    fill('2026-10-05', '09:25', 'SELL', 50, 30, { inst: 'NSE_FNO:9', option: true, expiry: '2026-10-06' }),
    fill('2026-10-05', '09:30', 'BUY', 75, 10, { inst: 'NSE_FNO:7', option: true, expiry: '2026-10-20' }),   // not expired yet
  ], '2026-10-10');
  assert.equal(days.get('2026-10-06').gross, -3000 + 1500);
  assert.equal(days.get('2026-10-05').gross, 0);
});

test('Dhan trade history: all pages, IST times, charges summed, odd fields tolerated', async () => {
  const pages = [
    [{ exchangeTradeId: 'T1', orderId: 'O1', transactionType: 'BUY', exchangeSegment: 'NSE_FNO', securityId: '42', customSymbol: 'NIFTY 25000 CE', tradedQuantity: 75, tradedPrice: 120.5,
       exchangeTime: '2026-10-09 10:00:46', createTime: 'NA', sebiTax: '0.01', stt: 0, brokerageCharges: '20', serviceTax: 3.6, exchangeTransactionCharges: '4.5', stampDuty: 'NA', drvOptionType: 'CALL', drvExpiryDate: '2026-10-14' }],
    [{ exchangeTradeId: 'T2', orderId: 'O2', transactionType: 'SELL', exchangeSegment: 'NSE_FNO', securityId: '42', tradedQuantity: 75, tradedPrice: 130, exchangeTime: '2026-10-09 11:15:00' },
     { transactionType: 'BUY', securityId: '7', tradedQuantity: 0, tradedPrice: 1, exchangeTime: 'NA' }],   // unusable: skipped
    [],
  ];
  const seen = [];
  const transport = async (method, url) => { seen.push(url); return { status: 200, text: JSON.stringify(pages[Number(url.split('/').at(-1))] ?? []) }; };
  const fills = await createDhanAdapter({ clientId: 'C1', accessToken: 'tok', transport }).tradeHistory('2026-10-01', '2026-10-09');
  assert.equal(seen.length, 3);
  assert.match(seen[0], /\/trades\/2026-10-01\/2026-10-09\/0$/);
  assert.equal(fills.length, 2);
  assert.equal(fills[0].ts, Date.parse('2026-10-09T10:00:46+05:30'));
  assert.equal(Math.round(fills[0].charges * 100) / 100, 28.11);
  assert.deepEqual([fills[0].option, fills[0].expiry, fills[0].inst, fills[0].symbol], [true, '2026-10-14', 'NSE_FNO:42', 'NIFTY 25000 CE']);
});

test('sync stores fills, rebuilds days, and the calendar prefers broker figures', async () => {
  const userId = createUser({ email: 'pnl@x.test', password: null, name: 'P' });
  stmt(`INSERT INTO broker_accounts (user_id, broker, client_id, token_enc, status, created_at) VALUES (?, 'dhan', 'C9', ?, 'connected', ?)`)
    .run(userId, encrypt('h.e30.s'), Date.now());
  // TradeLock's own record for the 5th says +100 (gross, before charges); the broker says otherwise.
  stmt(`INSERT INTO day_state (user_id, day, realized, entries, sync_ok, breaches) VALUES (?, '2026-10-05', 100, 2, 5, 1)`).run(userId);
  const adapter = adapterFor(stmt('SELECT * FROM broker_accounts WHERE user_id = ?').get(userId));
  const calls = [];
  const history = [fill('2026-10-05', '09:20', 'BUY', 75, 100, { charges: 30 }), fill('2026-10-05', '09:50', 'SELL', 75, 104, { charges: 30 })];
  adapter.tradeHistory = async (from, to) => {
    calls.push([from, to]);
    return from <= '2026-10-05' && to >= '2026-10-05' ? history : [];
  };
  const now = at('2026-10-10', '17:00');
  const res = await syncBrokerPnl(userId, { now });
  assert.equal(res.fills, 2);
  assert.equal(calls[0][0], '2026-04-13');   // 180-day backfill in monthly chunks
  assert.equal(calls.at(-1)[1], '2026-10-10');

  const cal = pnlCalendar(userId, '2026-10');
  const d = cal.days.find(x => x.day === '2026-10-05');
  assert.deepEqual([d.source, d.gross, d.charges, d.pnl, d.entries, d.breaches], ['broker', 300, 60, 240, 2, 1]);
  assert.equal(cal.summary.net, 240);
  assert.equal(cal.brokerSync.status, 'ok');

  // A later sync only re-reads the last few days, and the same fills are not counted twice.
  calls.length = 0;
  await syncBrokerPnl(userId, { now: at('2026-10-12', '17:00') });
  assert.equal(calls[0][0], '2026-10-05');
  assert.equal(pnlCalendar(userId, '2026-10').summary.net, 240);
});

test('analytics include broker days', async () => {
  const { analytics } = await import('../src/modules/analytics/service.js');
  const userId = stmt("SELECT id FROM users WHERE email = 'pnl@x.test'").get().id;
  const a = analytics(userId, 20);
  assert.equal(a.sessions, 1);
  assert.equal(a.netPnl, 240);
  assert.equal(a.series[0].day, '2026-10-05');
});
