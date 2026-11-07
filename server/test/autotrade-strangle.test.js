// CE + PE at a target price (own switch strangle_on): the pair nearest ₹4, sizing with the volume limit, both bought as one
// trade at the risk gate, the 1-minute-close stop on each option, the exit time, and the switch and settings on the page.
process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
process.env.ADMIN_EMAILS = 'strangle@example.com';   // a private strategy: administrators (lib/access.js)
const { test, before, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { createServer } = await import('node:http');
const { createHandler } = await import('../src/lib/app.js');
const { buildRouter } = await import('../src/modules/index.js');
const { stmt } = await import('../src/db/index.js');
const { setBook } = await import('../src/modules/broker/book.js');
const { upsertAccount } = await import('../src/modules/broker/registry.js');
const { saveRules, getRules } = await import('../src/modules/rules/service.js');
const { strangleLegs, sizeStrangle, strangleTick, manageTrade, STRANGLE, FEED } = await import('../src/modules/scalper/autotrade.js');

const D = '2026-10-20', at = hhmm => Date.parse(`${D}T${hhmm}:00+05:30`);   // a Tuesday: the 20 Oct expiry day
const cfg = { ...STRANGLE.defaults };
// Spot 25,000. Calls above it, puts below: ₹4.20 (25,700) is nearest ₹4; 25,800 at ₹1 is outside the band; the ₹3.90 call
// 25,750 has not traded today (volume 0); the 24,900 put is in the money side (above spot? no: below, but ₹60).
const chain = { last_price: 25000, oc: {
  '24900': { ce: { security_id: 'C249', last_price: 160, volume: 5000 }, pe: { security_id: 'P249', last_price: 60, volume: 5000 } },
  '25700': { ce: { security_id: 'C257', last_price: 4.2, top_ask_price: 4.25, volume: 90000 } },
  '25750': { ce: { security_id: 'C2575', last_price: 3.9, volume: 0 } },
  '25800': { ce: { security_id: 'C258', last_price: 0.3, volume: 80000 } },
  '22400': { pe: { security_id: 'P224', last_price: 3.8, top_ask_price: 3.85, volume: 70000 } },
  '22300': { pe: { security_id: 'P223', last_price: 2.5, volume: 60000 } },
} };

test('the pair: out of the money, traded today, last price nearest the target within the band', () => {
  const x = strangleLegs(chain, cfg);
  assert.deepEqual([x.CE.strike, x.CE.ltp, x.CE.ask, x.PE.strike, x.PE.ltp], [25700, 4.2, 4.25, 22400, 3.8]);
  assert.equal(strangleLegs(chain, { ...cfg, bandPct: 1 }).CE, undefined, '±1%: nothing at ₹3.96–4.04');
});

test('size: the funds share at padded prices, within the capital limit, at most the max % of the thinner volume', () => {
  // (4.25 + 3.85) × 65 × 1.12 = ₹589.68 a lot of both.
  assert.deepEqual(sizeStrangle({ ce: 4.25, pe: 3.85, lotSize: 65, funds: 100000, fundsPct: 100 }), { lots: 166, why: 'funds' });
  assert.deepEqual(sizeStrangle({ ce: 4.25, pe: 3.85, lotSize: 65, funds: 100000, fundsPct: 100, capitalLimit: 50000 }), { lots: 84, why: 'funds' });
  assert.deepEqual(sizeStrangle({ ce: 4.25, pe: 3.85, lotSize: 65, funds: 100000, fundsPct: 100, volumes: [9000, 6500], maxVolPct: 10 }), { lots: 10, why: 'volume' });
});

// ---- live entry and exit against a fake Dhan ------------------------------------------------------------
const asRaw = bars => ({ timestamp: bars.map(b => b.time / 1000), open: bars.map(b => b.open), high: bars.map(b => b.high), low: bars.map(b => b.low), close: bars.map(b => b.close), volume: bars.map(b => b.volume || 0) });
function fakeDhan({ candles = {}, fills = {} } = {}) {
  const calls = [];
  return {
    calls,
    async optionExpiries() { return ['2026-10-20', '2026-10-27']; },
    async optionChain({ expiry }) { calls.push(['chain', expiry]); return chain; },
    async intradayCandles(q) { calls.push(['candles', q.securityId]); return asRaw(candles[q.securityId] || []); },
    async placeOrder(o) { calls.push(['order', o]); return { id: `E-${o.securityId}`, status: 'pending' }; },
    async orderStatus(id) { return fills[id] || { status: 'filled', price: id.includes('C257') ? 4.3 : 3.9, filledQty: undefined }; },
    async cancelOrder(id) { calls.push(['cancel', id]); return { status: 'cancelled' }; },
    async exitPosition(p) { calls.push(['exit', p.symbol]); return { id: 'X1', status: 'pending' }; },
  };
}
const instruments = async () => new Map([['C257', { lotSize: 65, tickSize: 0.05 }], ['P224', { lotSize: 65, tickSize: 0.05 }]]);
const noPause = async () => {};
// 9:15–9:20 traded quantity: 13,000 (CE) and 6,500 (PE): 10% of the thinner = 650 = 10 lots.
const vol = { C257: [{ time: at('09:16'), open: 4, high: 4.3, low: 4, close: 4.2, volume: 13000 }], P224: [{ time: at('09:16'), open: 4, high: 4, low: 3.8, close: 3.8, volume: 6500 }] };

let server, uid, acct, cookie = '';
before(async () => {
  server = createServer(createHandler(buildRouter()));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'strangle@example.com', password: 'longpassword' }) });
  cookie = res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  uid = stmt('SELECT id FROM users WHERE email = ?').get('strangle@example.com').id;
  const active = getRules(uid).active;
  saveRules(uid, { ...active, cutoff: { ...active.cutoff, on: false } }, undefined, null, 'algo');
  upsertAccount(uid, { broker: 'dhan', clientId: 'C4', accessToken: 'test-token-not-real-0123456789' });
  stmt("UPDATE broker_accounts SET agent_on = 1, algo_on = 1, status = 'connected', orb_on = 0, cross_on = 0, gap_on = 0 WHERE user_id = ?").run(uid);
  acct = stmt('SELECT * FROM broker_accounts WHERE user_id = ?').get(uid);
});
after(() => server.close());
const flatBook = () => setBook(uid, { positions: [], orders: [], funds: { available: 100000, used: 0 }, at: Date.now() });

test('switched off, or before 09:20: nothing is bought', async () => {
  flatBook();
  const dhan = fakeDhan({ candles: vol });
  assert.equal((await strangleTick(acct, { now: at('09:30'), adapter: dhan, instruments, pause: noPause })).skipped, 'off');
  assert.equal((await strangleTick({ ...acct, strangle_on: 1 }, { now: at('09:19'), adapter: dhan, instruments, pause: noPause })).skipped, 'before the entry time');
  assert.equal(dhan.calls.length, 0);
});

test('switch on: the next expiry on expiry day, both bought at market, 10% of the volume, stops on the minute close', async () => {
  flatBook();
  const dhan = fakeDhan({ candles: vol });
  const r = await strangleTick({ ...acct, strangle_on: 1 }, { now: at('09:20') + 2000, adapter: dhan, instruments, pause: noPause });
  assert.equal(r.entered, 2, JSON.stringify(r));
  assert.deepEqual(dhan.calls.find(c => c[0] === 'chain'), ['chain', '2026-10-27'], 'expiry day: the next expiry');
  const orders = dhan.calls.filter(c => c[0] === 'order').map(c => c[1]);
  assert.deepEqual(orders.map(o => [o.securityId, o.side, o.type, o.qty]), [['C257', 'BUY', 'MARKET', 650], ['P224', 'BUY', 'MARKET', 650]], 'call first, 10 lots each');
  const rows = stmt("SELECT * FROM auto_trades WHERE user_id = ? AND signal_key LIKE ? ORDER BY id").all(uid, `${D}:strangle:%`);
  assert.deepEqual(rows.map(t => [t.direction, t.status, t.entry_price, t.sl_price, t.qty]), [['CE', 'open', 4.3, 3.4, 650], ['PE', 'open', 3.9, 3.1, 650]], '20% below the fills, down to the tick');
  assert.equal(JSON.parse(rows[0].detail).setup.strategy, STRANGLE.name);
  assert.equal((await strangleTick({ ...acct, strangle_on: 1 }, { now: at('09:25'), adapter: dhan, instruments, pause: noPause })).skipped, 'done today');

  // 10:00 closes at 3.40 (the stop) for the call: sold at market; the put (3.50) keeps running.
  setBook(uid, { positions: [{ securityId: 'C257', symbol: 'NIFTY-C257', qty: 650 }, { securityId: 'P224', symbol: 'NIFTY-P224', qty: 650 }], orders: [], funds: { available: 50000 }, at: Date.now() });
  const saved = FEED.minute; FEED.minute = () => null;   // no feed: Dhan's REST candles
  try {
    const exitDhan = fakeDhan({ candles: { C257: [{ time: at('10:00'), open: 3.6, high: 3.6, low: 3.2, close: 3.4 }], P224: [{ time: at('10:00'), open: 3.6, high: 3.7, low: 3.0, close: 3.5 }] } });
    for (const t of rows) await manageTrade(stmt('SELECT * FROM auto_trades WHERE id = ?').get(t.id), { now: at('10:01') + 5000, adapter: exitDhan });
    const after = stmt('SELECT direction, status, reason FROM auto_trades WHERE id IN (?, ?) ORDER BY id').all(rows[0].id, rows[1].id);
    assert.deepEqual(after.map(t => t.status), ['closing', 'open'], 'only the call is out: a dip to 3.00 inside the minute does not stop the put');
    assert.match(after[0].reason, /Stop −20%: the 10:00 minute closed at 3\.4 \(stop 3\.4\)/);
    assert.deepEqual(exitDhan.calls.filter(c => c[0] === 'exit').map(c => c[1]), ['NIFTY-C257']);
    // 15:20: the Risk rules square-off would be 15:15 with the cutoff off, but CE + PE waits for its own 15:25.
    const hold = fakeDhan({ candles: { P224: [{ time: at('15:19'), open: 3.6, high: 3.7, low: 3.5, close: 3.6 }] } });
    await manageTrade(stmt('SELECT * FROM auto_trades WHERE id = ?').get(rows[1].id), { now: at('15:20') + 5000, adapter: hold });
    assert.ok(!hold.calls.some(c => c[0] === 'exit'), 'not at 15:15/15:20');
    const close = fakeDhan();
    await manageTrade(stmt('SELECT * FROM auto_trades WHERE id = ?').get(rows[1].id), { now: at('15:25') + 1000, adapter: close });
    assert.deepEqual(close.calls.filter(c => c[0] === 'exit').map(c => c[1]), ['NIFTY-P224']);
    assert.match(stmt('SELECT reason FROM auto_trades WHERE id = ?').get(rows[1].id).reason, /Exit at 15:25/);
  } finally { FEED.minute = saved; }
  stmt("UPDATE auto_trades SET status = 'closed' WHERE user_id = ?").run(uid);
});

test('no pair in the window: tried again, then recorded once as not traded', async () => {
  flatBook();
  const DAY2 = 7 * 86_400_000, at2 = hhmm => at(hhmm) + DAY2;   // 27 Oct
  const empty = { ...fakeDhan(), async optionChain() { return { last_price: 25000, oc: {} }; }, async optionExpiries() { return ['2026-10-27', '2026-11-03']; } };
  const a = { ...acct, strangle_on: 1 };
  assert.match((await strangleTick(a, { now: at2('09:21'), adapter: empty, instruments, pause: noPause })).skipped, /no call or put at ₹0\.4–7\.6/);
  const r = await strangleTick(a, { now: at2('09:46'), adapter: empty, instruments, pause: noPause });
  assert.match(r.skipped, /No entry between 09:20 and 09:45: no call or put/);
  assert.equal(stmt("SELECT status FROM auto_trades WHERE signal_key = ?").get('2026-10-27:strangle:CE').status, 'skipped');
});

test('AI Algo Trading page: the switch and its settings', async () => {
  const base = `http://127.0.0.1:${server.address().port}`, H = { 'Content-Type': 'application/json', Cookie: cookie };
  const on = await fetch(`${base}/api/brokers/${acct.id}/strategies`, { method: 'POST', headers: H,
    body: JSON.stringify({ strangle: true, strangleCfg: { target: 4, bandPct: 90, entry: '09:20', waitMin: 25, exit: '15:25', stopPct: 20, fundsPct: 100, maxVolPct: 10 } }) });
  assert.equal(on.status, 200);
  const live = await (await fetch(`${base}/api/algo/live`, { headers: H })).json();
  assert.equal(live.account.strangleOn, true);
  assert.deepEqual(live.account.strangleCfg, { target: 4, bandPct: 90, entry: '09:20', waitMin: 25, exit: '15:25', stopPct: 20, fundsPct: 100, maxVolPct: 10 });
  const bad = await fetch(`${base}/api/brokers/${acct.id}/strategies`, { method: 'POST', headers: H, body: JSON.stringify({ strangleCfg: { ...live.account.strangleCfg, exit: '09:10' } }) });
  assert.equal(bad.status, 400);
});
