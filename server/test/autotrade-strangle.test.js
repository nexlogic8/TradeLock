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
const { strangleLegs, sizeStrangle, strangleTick, manageTrade, strangleCapital, exitFromFills, STRANGLE, FEED, gapConfig, GAP_SLOT } = await import('../src/modules/scalper/autotrade.js');
const { optionCharges } = await import('../src/modules/scalper/orb5-options.js');

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
  assert.deepEqual(live.account.strangleCfg, { target: 4, bandPct: 90, entry: '09:20', waitMin: 25, exit: '15:25', stopPct: 20, fundsPct: 100, maxVolPct: 10, expiryDay: 'next', capitalMode: 'amount', capital: 0, capitalPct: 100, compound: true, capitalSince: 0 });
  const bad = await fetch(`${base}/api/brokers/${acct.id}/strategies`, { method: 'POST', headers: H, body: JSON.stringify({ strangleCfg: { ...live.account.strangleCfg, exit: '09:10' } }) });
  assert.equal(bad.status, 400);
});

test('on the expiry day: "skip" records the day as not traded; "next1" takes the next expiry already the day before', async () => {
  flatBook();
  const TUE = 14 * 86_400_000, MON = 13 * 86_400_000;   // Tue 3 Nov (an expiry day), Mon 2 Nov
  const dhan = { ...fakeDhan(), async optionExpiries() { return ['2026-11-03', '2026-11-09', '2026-11-17']; } };
  const calls = dhan.calls;
  dhan.optionChain = async ({ expiry }) => { calls.push(['chain', expiry]); return { last_price: 25000, oc: {} }; };
  const skip = await strangleTick({ ...acct, strangle_on: 1, strangle_cfg: JSON.stringify({ expiryDay: 'skip' }) }, { now: at('09:21') + TUE, adapter: dhan, instruments, pause: noPause });
  assert.match(skip.skipped, /Expiry day \(2026-11-03\): skipped by your setting/);
  assert.equal(stmt('SELECT status FROM auto_trades WHERE signal_key = ?').get('2026-11-03:strangle:CE').status, 'skipped');
  assert.ok(!calls.some(c => c[0] === 'chain'), 'no chain read on a skipped day');
  await strangleTick({ ...acct, strangle_on: 1, strangle_cfg: JSON.stringify({ expiryDay: 'next1' }) }, { now: at('09:21') + MON, adapter: dhan, instruments, pause: noPause });
  assert.deepEqual(calls.filter(c => c[0] === 'chain').at(-1), ['chain', '2026-11-09'], 'Monday before the Tuesday expiry: the next one');
  await strangleTick({ ...acct, strangle_on: 1, strangle_cfg: JSON.stringify({ expiryDay: 'next' }) }, { now: at('09:42') + MON, adapter: dhan, instruments, pause: noPause });
  assert.deepEqual(calls.filter(c => c[0] === 'chain').at(-1), ['chain', '2026-11-03'], 'the default keeps the nearest the day before');
});

test('its own capital: ₹50,000 + its realised P&L (exit from the sell fills when the order price is unknown)', () => {
  const since = Date.parse('2026-11-05T00:00:00+05:30'), t0 = Date.parse('2026-11-09T09:26:00+05:30');
  const id = Number(stmt(`INSERT INTO auto_trades (user_id, day, signal_key, direction, status, symbol, expiry, strike, lots, qty, entry_price, detail, created_at, closed_at, paper)
    VALUES (?, '2026-11-09', 'cap-test:CE', 'CE', 'closed', 'NIFTY 2026-11-17 27350 CE', '2026-11-17', 27350, 10, 650, 6, ?, ?, ?, 0)`).run(uid, JSON.stringify({ setup: { strategy: STRANGLE.name } }), t0, t0 + 900_000).lastInsertRowid);
  const fill = (n, qty, price) => stmt(`INSERT INTO trades (user_id, day, ts, kind, ext_id, symbol, side, qty, price, status) VALUES (?, '2026-11-09', ?, 'exec', ?, 'NIFTY-Nov2026-27350-CE', 'SELL', ?, ?, 'COMPLETE')`).run(uid, t0 + 600_000 + n, `cap-${n}`, qty, price);
  fill(1, 325, 4); fill(2, 325, 5);
  assert.equal(exitFromFills(stmt('SELECT * FROM auto_trades WHERE id = ?').get(id)), 4.5);
  const net = (4.5 - 6) * 650 - optionCharges('2026-11-09', 6 * 650, 4.5 * 650).total;
  assert.equal(strangleCapital(uid, { capital: 50000, compound: true, capitalSince: since }), Math.round((50000 + net) * 100) / 100);
  assert.equal(stmt('SELECT exit_price FROM auto_trades WHERE id = ?').get(id).exit_price, 4.5, 'saved for the Algo page');
  assert.equal(strangleCapital(uid, { capital: 50000, compound: false, capitalSince: since }), 50000);
  assert.equal(strangleCapital(uid, { capital: 0, compound: true }), null);
  assert.equal(strangleCapital(uid, { capital: 50000, compound: true, capitalSince: t0 + 1 }), 50000, 'trades before the capital was set do not count');
});

test('grid: CE + PE on SENSEX with its own settings: BSE orders, its own key, alongside an open NIFTY position', async () => {
  // A NIFTY position is open: with the grid each strategy + index holds its own trade, so SENSEX still enters.
  setBook(uid, { positions: [{ securityId: 'NIFTY-OPEN', symbol: 'NIFTY-OPEN', qty: 65 }], orders: [], funds: { available: 100000, used: 0 }, at: Date.now() });
  const WED = 86_400_000, dhan = fakeDhan({ candles: vol });
  const grid = { strangle: { NIFTY: { on: false }, SENSEX: { on: true, cfg: { ...STRANGLE.defaults, target: 4, maxVolPct: 0 } } } };
  const a = { ...acct, strangle_on: 1, algo_grid: JSON.stringify(grid) };
  assert.equal((await strangleTick(a, { now: at('09:21') + WED, adapter: dhan, instruments, pause: noPause, underlying: 'NIFTY' })).skipped, 'off', 'NIFTY is off in the grid');
  const r = await strangleTick(a, { now: at('09:21') + WED, adapter: dhan, instruments, pause: noPause, underlying: 'SENSEX' });
  assert.equal(r.entered, 2, JSON.stringify(r));
  const orders = dhan.calls.filter(c => c[0] === 'order').map(c => c[1]);
  assert.deepEqual(orders.map(o => [o.securityId, o.exchangeSegment]), [['C257', 'BSE_FNO'], ['P224', 'BSE_FNO']]);
  const rows = stmt("SELECT signal_key, json_extract(detail, '$.setup.underlying') AS u FROM auto_trades WHERE user_id = ? AND day = '2026-10-21' ORDER BY id").all(uid);
  assert.deepEqual(rows.map(x => [x.signal_key, x.u]), [['2026-10-21:strangle:SENSEX:CE', 'SENSEX'], ['2026-10-21:strangle:SENSEX:PE', 'SENSEX']]);
  stmt("UPDATE auto_trades SET status = 'closed' WHERE user_id = ? AND day = '2026-10-21'").run(uid);
});

test('AI Algo Trading page: the grid switches a strategy on per index, with its own settings; the older switches follow', async () => {
  const base = `http://127.0.0.1:${server.address().port}`, H = { 'Content-Type': 'application/json', Cookie: cookie };
  const post = body => fetch(`${base}/api/brokers/${acct.id}/algo-grid`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  assert.equal((await post({ strategy: 'strangle', index: 'SENSEX', on: true })).status, 200);
  const cfg = { target: 120, bandPct: 50, entry: '09:30', waitMin: 20, exit: '15:20', stopPct: 25, fundsPct: 50, maxVolPct: 0, expiryDay: 'skip', capital: 0, compound: true };
  assert.equal((await post({ strategy: 'strangle', index: 'SENSEX', cfg })).status, 200);
  assert.equal((await post({ strategy: 'gap', index: 'BANKNIFTY', on: true })).status, 200);
  const live = (await (await fetch(`${base}/api/algo/live`, { headers: H })).json()).account;
  assert.equal(live.grid.strangle.SENSEX.on, true);
  assert.deepEqual({ ...live.grid.strangle.SENSEX.cfg, capitalSince: undefined }, { ...STRANGLE.defaults, ...cfg, capitalSince: undefined });
  assert.equal(live.grid.gap.BANKNIFTY.on, true);
  const row = stmt('SELECT strangle_on, gap_on, algo_underlying FROM broker_accounts WHERE id = ?').get(acct.id);
  assert.deepEqual([row.strangle_on, row.gap_on, row.algo_underlying.split(',').sort()], [1, 1, ['BANKNIFTY', 'NIFTY', 'SENSEX']]);
  assert.equal((await post({ strategy: 'gap', index: 'NOPE', on: true })).status, 400);
  assert.equal((await post({ strategy: 'orb', index: 'NIFTY', cfg: {} })).status, 400, 'only CE + PE and Gap have settings');
});

test('Gap open 09:15 settings per index: defaults keep the live behaviour; saved and validated through the grid', async () => {
  assert.deepEqual(gapConfig({ algo_underlying: 'NIFTY' }, 'SENSEX'), { ...GAP_SLOT, autoExit: true, noEntryLock: true });
  assert.deepEqual([gapConfig({ gap_auto_exit: 0, gap_lock: 0 }, 'NIFTY').autoExit, gapConfig({ gap_auto_exit: 0, gap_lock: 0 }, 'NIFTY').noEntryLock], [false, false], 'until set per index they follow the older switches');
  assert.deepEqual({ fundsPct: GAP_SLOT.fundsPct, stopPct: GAP_SLOT.stopPct, costToCost: GAP_SLOT.costToCost, requireGreen: GAP_SLOT.requireGreen, capital: GAP_SLOT.capital }, { fundsPct: 80, stopPct: 0, costToCost: true, requireGreen: false, capital: 0 });
  const base = `http://127.0.0.1:${server.address().port}`, H = { 'Content-Type': 'application/json', Cookie: cookie };
  const post = body => fetch(`${base}/api/brokers/${acct.id}/algo-grid`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const cfg = { capital: 50000, compound: true, fundsPct: 90, stopPct: 20, costToCost: false, requireGreen: true };   // Backtest #699
  assert.equal((await post({ strategy: 'gap', index: 'SENSEX', on: true })).status, 200);
  assert.equal((await post({ strategy: 'gap', index: 'SENSEX', cfg })).status, 200);
  const saved = gapConfig(stmt('SELECT * FROM broker_accounts WHERE id = ?').get(acct.id), 'SENSEX');
  // A ₹ capital is used as it is: no compounding, all of it.
  assert.deepEqual({ ...saved, capitalSince: undefined }, { ...cfg, compound: false, fundsPct: 100, capitalMode: 'amount', capitalPct: 80, autoExit: true, noEntryLock: true, capitalSince: undefined });
  assert.ok(saved.capitalSince > 0, 'its capital counts trades from now');
  const live = (await (await fetch(`${base}/api/algo/live`, { headers: H })).json()).account;
  assert.equal(live.grid.gap.SENSEX.capitalNow, 50000);
  assert.equal((await post({ strategy: 'gap', index: 'SENSEX', cfg: { ...cfg, fundsPct: 0 } })).status, 400);
  assert.equal((await post({ strategy: 'gap', index: 'SENSEX', cfg: { ...cfg, stopPct: 150 } })).status, 400);
  // Capital as a % of the funds; the 09:16 exit and the no-entry lock per index.
  assert.equal((await post({ strategy: 'gap', index: 'SENSEX', cfg: { ...cfg, capitalMode: 'percent', capitalPct: 60, autoExit: false, noEntryLock: false } })).status, 200);
  const pctCfg = gapConfig(stmt('SELECT * FROM broker_accounts WHERE id = ?').get(acct.id), 'SENSEX');
  assert.deepEqual([pctCfg.capitalMode, pctCfg.capitalPct, pctCfg.capital, pctCfg.autoExit, pctCfg.noEntryLock], ['percent', 60, 50000, false, false]);
  assert.equal((await post({ strategy: 'gap', index: 'SENSEX', cfg: { ...cfg, capitalMode: 'lots' } })).status, 400);
});
