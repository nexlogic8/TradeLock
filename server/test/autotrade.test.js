// Live ORB auto-trading: contract choice, premium stop-loss, sizing and the order lifecycle against a fake Dhan.
process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
const { test, before, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { createServer } = await import('node:http');
const { createHandler } = await import('../src/lib/app.js');
const { buildRouter } = await import('../src/modules/index.js');
const { stmt } = await import('../src/db/index.js');
const { setBook } = await import('../src/modules/broker/book.js');
const { upsertAccount } = await import('../src/modules/broker/registry.js');
const { saveRules, getRules } = await import('../src/modules/rules/service.js');
const { nextExpiry, atmContract, premiumStop, stopLimitPrice, sizeOrbTrade, scanForEntry, manageTrade, riskLeft, emaNineExit, crossSetup, algoIndices, orbLive, costToCost, FEED } = await import('../src/modules/scalper/autotrade.js');

test('next expiry is the one after the nearest; strike nearest spot', () => {
  assert.equal(nextExpiry(['2026-10-27', '2026-10-20', '2026-11-03', '2026-10-13'], '2026-10-19'), '2026-10-27');
  assert.equal(nextExpiry(['2026-10-20', '2026-10-27'], '2026-10-20'), '2026-10-27', 'expiry day: today is the nearest');
  assert.equal(nextExpiry(['2026-10-20'], '2026-10-19'), '2026-10-20', 'only one listed: use it');
  const chain = { last_price: 23030, oc: { '23000': { ce: { security_id: 1, top_ask_price: 120 } }, '23050': { ce: { security_id: 2, top_ask_price: 95 } } } };
  assert.deepEqual([atmContract(chain, 'CE').strike, atmContract(chain, 'CE').securityId], [23050, '2']);
});

test('stop is one tick below the premium candle low; stop limit 10% below; whole lots within budget and funds', () => {
  assert.equal(premiumStop({ low: 110.03 }, 0.05), 110, '110.03 rounds up to 110.05, minus a tick');
  assert.equal(premiumStop({ low: 110 }, 0.05), 109.95);
  assert.equal(stopLimitPrice(110, 0.05), 99);
  assert.equal(stopLimitPrice(0.1, 0.05), 0.05, 'never below one tick');
  assert.deepEqual(sizeOrbTrade({ entry: 120, stop: 110, lotSize: 65, budget: 3333.33, funds: 200000 }), { lots: 5, qty: 325, risk: 3250, premium: 39000 });
  assert.equal(sizeOrbTrade({ entry: 120, stop: 110, lotSize: 65, budget: 3333.33, funds: 20000 }).lots, 2, 'funds cap');
  assert.equal(sizeOrbTrade({ entry: 120, stop: 110, lotSize: 65, budget: 500, funds: 200000 }), null, 'one lot over budget');
  assert.equal(sizeOrbTrade({ entry: 2, stop: 1, lotSize: 65, budget: 1e6, funds: 1e7 }).qty, 3510, 'freeze quantity 3,510 → 54 lots');
});

test('each signal may risk all of the day stop-loss that is left; profits do not add to it', () => {
  assert.equal(riskLeft(15000, 0), 15000);
  assert.equal(riskLeft(15000, -5000), 10000, 'manual exit at −₹5,000 leaves ₹10,000 for the next setup');
  assert.equal(riskLeft(15000, 20000), 15000);
  assert.equal(riskLeft(15000, -16000), 0);
  assert.equal(riskLeft(null, 0), 0);
});

test('EMA 9 exit: two completed 5-minute closes on the wrong side, counted from the entry', () => {
  const t0 = Date.parse('2026-10-19T10:00:00+05:30'), bar = (i, close) => ({ time: t0 + i * 300_000, open: close, high: close, low: close, close });
  const rising = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109].map((c, i) => bar(i, c));
  const since = t0 + 8 * 300_000, now = t0 + 10 * 300_000;
  assert.equal(emaNineExit(rising, { direction: 'CE', since, now }), null, 'CE above EMA 9: hold');
  assert.match(emaNineExit(rising, { direction: 'PE', since, now }), /Two 5-minute closes above EMA 9/, 'PE: two closes above → exit');
  assert.equal(emaNineExit(rising, { direction: 'PE', since: t0 + 9 * 300_000, now }), null, 'only one candle since entry');
  assert.equal(emaNineExit(rising, { direction: 'PE', since, now: now - 1 }), null, 'the last candle has not closed yet');
  const oneBack = [...rising.slice(0, 9), bar(9, 90)];
  assert.equal(emaNineExit(oneBack, { direction: 'PE', since, now }), null, 'the second close fell back below: not two in a row');
});

// ---- order lifecycle --------------------------------------------------------------------------------
const D = '2026-10-19';
const ms = hhmm => Date.parse(`${D}T${hhmm}:00+05:30`);
const raw = bars => ({ timestamp: bars.map(b => ms(b[0]) / 1000), open: bars.map(b => b[1]), high: bars.map(b => b[2]), low: bars.map(b => b[3]), close: bars.map(b => b[4]) });
// 5-minute NIFTY candles. Range 95-105 (the 09:15 candle); 10:00 closes above it (low 104, high 107);
// 10:05 breaks 107 and closes green with a real body: CE confirmed at 10:10.
const spot5 = [['09:15', 100, 105, 95, 102], ['09:20', 102, 103, 100, 101], ['10:00', 103, 107, 104, 106], ['10:05', 106.2, 108, 106, 107.8]];

function fakeDhan({ premiumBars = [['10:00', 114, 118, 110.03, 117], ['10:05', 117, 121, 116, 120]], slStatus = 'pending', spot = spot5 } = {}) {
  const calls = [];
  return {
    calls,
    slStatus,
    async optionExpiries() { return ['2026-10-20', '2026-10-27']; },
    async optionChain({ expiry }) {
      calls.push(['chain', expiry]);
      return { last_price: 23010, oc: { '23000': { ce: { security_id: 'C1', top_ask_price: 120, top_bid_price: 119.5, last_price: 119.8 }, pe: { security_id: 'P1', top_ask_price: 90 } },
        '23050': { ce: { security_id: 'C2', top_ask_price: 95 } } } };
    },
    async intradayCandles({ securityId, interval }) {
      calls.push(['candles', securityId, interval]);
      if (securityId === '13') return raw(spot);
      return raw(['C1', 'P1'].includes(securityId) ? premiumBars : []);
    },
    async placeOrder(o) { calls.push(['order', o]); return { id: o.type === 'STOP_LOSS' ? 'S1' : 'E1', status: 'pending' }; },
    async orderStatus(id) { calls.push(['status', id]); return id === 'E1' ? { status: 'filled', price: 120.5 } : { status: this.slStatus, price: 109.8 }; },
    async cancelOrder(id) { calls.push(['cancel', id]); return { status: 'cancelled' }; },
    async exitPosition(p) { calls.push(['exit', p.symbol]); return { id: 'X1', status: 'pending' }; },
  };
}
const instruments = async () => new Map([['C1', { lotSize: 65, tickSize: 0.05 }], ['P1', { lotSize: 65, tickSize: 0.05 }]]);
const noPause = async () => {};

let server, uid, acct, cookie = '';
before(async () => {
  server = createServer(createHandler(buildRouter()));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'auto@example.com', password: 'longpassword' }) });
  cookie = res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  uid = stmt('SELECT id FROM users WHERE email = ?').get('auto@example.com').id;
  // Cutoff off so the test does not depend on the wall clock; 5% daily loss ÷ 3 trades sizes each trade.
  const active = getRules(uid).active;
  saveRules(uid, { ...active, cutoff: { ...active.cutoff, on: false } });
  upsertAccount(uid, { broker: 'dhan', clientId: 'C123', accessToken: 'test-token-not-real-0123456789' });
  stmt('UPDATE broker_accounts SET agent_on = 1, algo_on = 1 WHERE user_id = ?').run(uid);
  acct = stmt('SELECT * FROM broker_accounts WHERE user_id = ?').get(uid);
});
after(() => server.close());
const flatBook = () => setBook(uid, { positions: [], orders: [], funds: { available: 200000, used: 0 }, at: Date.now() });

test('a fresh confirmed ORB signal buys the next-expiry ATM option and places the premium stop-loss at Dhan', async () => {
  flatBook();
  const dhan = fakeDhan();
  const between = await scanForEntry(acct, { now: ms('10:08') + 3000, adapter: dhan, pause: noPause, instruments });
  assert.equal(between.skipped, 'no breakout to watch', 'between closes: nothing waiting for a live break');
  const r = await scanForEntry(acct, { now: ms('10:10') + 3000, adapter: dhan, pause: noPause, instruments });
  assert.equal(r.entered, true, JSON.stringify(r));
  assert.ok(dhan.calls.filter(c => c[0] === 'candles' && c[1] !== '13').every(c => c[2] === '5'), 'the ORB premium stop on 5-minute candles (the index is also read on 1 minute for EMA 5/9)');
  assert.deepEqual(dhan.calls.find(c => c[0] === 'chain'), ['chain', '2026-10-27'], 'next expiry, not the nearest');
  const [buy, sl] = dhan.calls.filter(c => c[0] === 'order').map(c => c[1]);
  assert.deepEqual([buy.side, buy.type, buy.securityId, buy.qty], ['BUY', 'MARKET', 'C1', 975], '15 lots: the whole ₹10,000 day stop-loss (5% of ₹2L) ÷ (120 − 110) ÷ 65');
  assert.deepEqual([sl.side, sl.type, sl.triggerPrice, sl.price, sl.qty], ['SELL', 'STOP_LOSS', 110, 99, 975], 'trigger one tick below the 110.03 low of the premium 5-minute breakout candle');
  const row = stmt('SELECT * FROM auto_trades WHERE user_id = ?').get(uid);
  assert.deepEqual([row.status, row.direction, row.entry_price, row.sl_price, row.sl_order_id, row.expiry, row.strike], ['open', 'CE', 120.5, 110, 'S1', '2026-10-27', 23000]);
  // The same signal is never traded twice: a later pass in that minute, or a restart, finds it claimed.
  const again = await scanForEntry(acct, { now: ms('10:10') + 8000, adapter: dhan, pause: noPause, instruments });
  assert.equal(again.skipped, 'no breakout to watch');
  assert.equal(stmt('SELECT COUNT(*) AS n FROM auto_trades WHERE user_id = ?').get(uid).n, 1);
});

test('the stop-loss fill closes the trade; a position closed elsewhere gets its stop order cancelled', async () => {
  const dhan = fakeDhan({ slStatus: 'filled' });
  const now = ms('10:30');
  setBook(uid, { positions: [{ securityId: 'C1', symbol: 'NIFTY-C1', qty: 975 }], orders: [{ id: 'S1', symbol: 'NIFTY-C1' }], funds: { available: 160000, used: 39000 }, at: Date.now() });
  await manageTrade(stmt(`SELECT * FROM auto_trades WHERE user_id = ?`).get(uid), { now, adapter: dhan });
  assert.equal(stmt('SELECT seen_open FROM auto_trades WHERE user_id = ?').get(uid).seen_open, 1);
  assert.equal(dhan.calls.length, 0, 'open and before square-off: nothing to do');
  flatBook();
  await manageTrade(stmt(`SELECT * FROM auto_trades WHERE user_id = ?`).get(uid), { now, adapter: dhan });
  const closed = stmt('SELECT * FROM auto_trades WHERE user_id = ?').get(uid);
  assert.deepEqual([closed.status, closed.reason, closed.exit_price], ['closed', 'Stop-loss hit', 109.8]);
  assert.ok(!dhan.calls.some(c => c[0] === 'cancel'));

  // Closed in the Dhan app instead: the resting stop is cancelled so it can never sell short later.
  stmt(`UPDATE auto_trades SET status = 'open', reason = NULL WHERE user_id = ?`).run(uid);
  const manual = fakeDhan({ slStatus: 'pending' });
  await manageTrade(stmt(`SELECT * FROM auto_trades WHERE user_id = ?`).get(uid), { now, adapter: manual });
  assert.ok(manual.calls.some(c => c[0] === 'cancel' && c[1] === 'S1'));
  assert.equal(stmt('SELECT reason FROM auto_trades WHERE user_id = ?').get(uid).reason, 'Position closed outside the auto-trader');
});

test('two 5-minute closes below EMA 9 exit a CE trade: stop cancelled first, then market exit', async () => {
  stmt(`UPDATE auto_trades SET status = 'open', reason = NULL, seen_open = 1 WHERE user_id = ?`).run(uid);
  setBook(uid, { positions: [{ securityId: 'C1', symbol: 'NIFTY-C1', qty: 975 }], orders: [{ id: 'S1', symbol: 'NIFTY-C1' }], funds: { available: 80000, used: 117000 }, at: Date.now() });
  // Entered after the 10:05 confirmation; 10:10 and 10:15 close at 100 and 99, under EMA 9 (≈102.9, ≈102.2).
  const dhan = fakeDhan({ slStatus: 'pending', spot: [...spot5, ['10:10', 107, 107, 99, 100], ['10:15', 100, 101, 98, 99]] });
  await manageTrade(stmt(`SELECT * FROM auto_trades WHERE user_id = ?`).get(uid), { now: ms('10:20') + 5000, adapter: dhan });
  assert.deepEqual(dhan.calls.filter(c => c[0] === 'cancel' || c[0] === 'exit').map(c => c[0]), ['cancel', 'exit']);
  const t = stmt('SELECT status, reason FROM auto_trades WHERE user_id = ?').get(uid);
  assert.equal(t.status, 'closing');
  assert.match(t.reason, /Two 5-minute closes below EMA 9/);
  flatBook();
  await manageTrade(stmt(`SELECT * FROM auto_trades WHERE user_id = ?`).get(uid), { now: ms('10:20') + 15000, adapter: fakeDhan({ slStatus: 'cancelled' }) });
  assert.deepEqual(Object.values(stmt('SELECT status, reason FROM auto_trades WHERE user_id = ?').get(uid)).slice(0, 1), ['closed']);
});

test('square-off at the cutoff cancels the stop first, then exits', async () => {
  stmt(`UPDATE auto_trades SET status = 'open', reason = NULL, seen_open = 1 WHERE user_id = ?`).run(uid);
  setBook(uid, { positions: [{ securityId: 'C1', symbol: 'NIFTY-C1', qty: 975 }], orders: [{ id: 'S1', symbol: 'NIFTY-C1' }], funds: { available: 160000, used: 39000 }, at: Date.now() });
  const dhan = fakeDhan({ slStatus: 'pending' });
  await manageTrade(stmt(`SELECT * FROM auto_trades WHERE user_id = ?`).get(uid), { now: ms('15:15') + 1000, adapter: dhan });
  const order = dhan.calls.filter(c => c[0] === 'cancel' || c[0] === 'exit').map(c => c[0]);
  assert.deepEqual(order, ['cancel', 'exit'], '15:15 when the Risk rules cutoff is off');
  assert.equal(stmt('SELECT status FROM auto_trades WHERE user_id = ?').get(uid).status, 'closing');
  stmt(`UPDATE auto_trades SET status = 'closed' WHERE user_id = ?`).run(uid);
});

test('no premium candle in the breakout minute: the signal is skipped, no order sent', async () => {
  flatBook();
  // A later trade the same day: back inside at 10:15, 10:20 closes below 95, 10:25 confirms red. No PE candle for 10:20.
  const spot = [...spot5, ['10:15', 104, 104, 100, 101], ['10:20', 96, 97, 93, 94], ['10:25', 93.8, 94, 91, 91.5]];
  const dhan = fakeDhan({ spot, premiumBars: [['10:25', 80, 84, 79, 83]] });
  const r = await scanForEntry(acct, { now: ms('10:30') + 3000, adapter: dhan, pause: noPause, instruments });
  assert.match(r.skipped, /no 5-minute candle for the ORB breakout candle/);
  assert.ok(!dhan.calls.some(c => c[0] === 'order'));
  const row = stmt(`SELECT * FROM auto_trades WHERE user_id = ? ORDER BY id DESC`).get(uid);
  assert.deepEqual([row.status, row.direction], ['skipped', 'PE']);
});

// EMA 9 / EMA 21 crossover: yesterday flat at 100, today a slide to 90 inside a very wide opening range
// (no ORB possible), then a 5-minute candle closing at 120 pulls EMA 9 above EMA 21.
const D2 = '2026-10-20', at2 = (day, hhmm) => Date.parse(`${day}T${hhmm}:00+05:30`);
const crossBars = (() => {
  const out = [], bar = (time, close) => ({ time, open: close, high: close + 1, low: close - 1, close });
  for (let i = 0; i < 40; i++) out.push(bar(at2('2026-10-19', '12:00') + i * 300_000, 100));
  out.push({ time: at2(D2, '09:15'), open: 100, high: 200, low: 0, close: 99 });
  for (let i = 1; i <= 9; i++) out.push(bar(at2(D2, '09:15') + i * 300_000, 99 - i));   // 09:20 … 10:00, down to 90
  out.push({ time: at2(D2, '10:05'), open: 91, high: 121, low: 90.5, close: 120 });
  return out;
})();

test('EMA 9/21 crossover: the completed candle where EMA 9 moves to the other side of EMA 21', () => {
  const now = at2(D2, '10:10') + 3000;
  const x = crossSetup(crossBars, now, D2);
  assert.deepEqual([x.strategy, x.direction, x.breakoutAt], ['EMA 9/21 cross', 'BUY_CE', at2(D2, '10:05')]);
  assert.ok(x.ema9 > x.ema21);
  assert.equal(crossSetup(crossBars.slice(0, -1), at2(D2, '10:05') + 3000, D2), null, 'still below: no cross');
  assert.equal(crossSetup(crossBars, at2(D2, '10:11'), D2), null, 'older than the 45-second entry window');
  assert.equal(crossSetup(crossBars, at2(D2, '10:08'), D2)?.breakoutAt, undefined, 'a candle still forming is never used');
  const down = crossBars.map(b => b.time >= at2(D2, '09:20') ? { ...b, close: 200 - b.close, open: 200 - b.open, high: 200 - b.low, low: 200 - b.high } : b);
  assert.equal(crossSetup(down, now, D2).direction, 'BUY_PE');
});

// EMA 5/9 on 1-minute candles (the cross_on switch since 28 Oct 2026): a flat previous session, a falling start, then a
// 1-minute candle closing at 120 pulls EMA 5 above EMA 9 at 09:25.
const oneBars = (() => {
  const out = [], bar = (time, close) => ({ time, open: close, high: close + 1, low: close - 1, close });
  for (let i = 0; i < 40; i++) out.push(bar(at2('2026-10-19', '15:00') + i * 60_000, 100));
  for (let i = 0; i < 10; i++) out.push(bar(at2(D2, '09:15') + i * 60_000, 99 - i));   // 09:15 … 09:24, down to 90
  out.push({ time: at2(D2, '09:25'), open: 91, high: 121, low: 90.5, close: 120 });
  return out;
})();
const asRaw = bars => ({ timestamp: bars.map(b => b.time / 1000), open: bars.map(b => b.open), high: bars.map(b => b.high), low: bars.map(b => b.low), close: bars.map(b => b.close) });

test('EMA 5/9 1m: the completed 1-minute candle where EMA 5 crosses EMA 9; the opposite cross is the exit', async () => {
  const { emaScalpSetup, emaScalpExit } = await import('../src/modules/scalper/autotrade.js');
  const now = at2(D2, '09:26') + 3000;
  const x = emaScalpSetup(oneBars, now, D2);
  assert.deepEqual([x.strategy, x.direction, x.breakoutAt, x.interval], ['EMA 5/9 1m', 'BUY_CE', at2(D2, '09:25'), '1']);
  assert.ok(x.ema5 > x.ema9);
  assert.equal(emaScalpSetup(oneBars.slice(0, -1), at2(D2, '09:25') + 3000, D2), null, 'still below: no cross');
  assert.equal(emaScalpSetup(oneBars, at2(D2, '09:27'), D2), null, 'older than the 45-second entry window');
  const since = at2(D2, '09:26');
  const up = [...oneBars, { time: since, open: 120, high: 126, low: 119, close: 125 }];
  assert.equal(emaScalpExit(up, { direction: 'CE', since, now: since + 61_000 }), null, 'still above: hold');
  const back = [...oneBars, { time: since, open: 120, high: 120, low: 60, close: 60 }];
  assert.match(emaScalpExit(back, { direction: 'CE', since, now: since + 61_000 }), /EMA 5 crossed below EMA 9 on the 1-minute close \(09:26\)/);
  assert.equal(emaScalpExit(back, { direction: 'CE', since, now: since + 30_000 }), null, 'a candle still forming is never used');
});

test('EMA 5/9 1m entry: market buy, SL one tick below the option 1-minute crossover candle low', async () => {
  flatBook();
  stmt(`UPDATE auto_trades SET status = 'closed' WHERE user_id = ? AND status IN ('open', 'closing', 'placing')`).run(uid);
  const dhan = fakeDhan();
  dhan.intradayCandles = async q => { dhan.calls.push(['candles', q.securityId, q.interval]); return q.securityId === '13' ? asRaw(oneBars)
    : { timestamp: [at2(D2, '09:25') / 1000], open: [114], high: [118], low: [110.03], close: [117] }; };
  const r = await scanForEntry({ ...acct, orb_on: 0, cross_on: 1, gap_on: 0 }, { now: at2(D2, '09:26') + 3500, adapter: dhan, pause: noPause, instruments });
  assert.equal(r.entered, true, JSON.stringify(r));
  const sl = dhan.calls.filter(c => c[0] === 'order').map(c => c[1]).find(o => o.type === 'STOP_LOSS');
  assert.equal(sl.triggerPrice, 110, 'one tick below the 110.03 low of the option 09:25 candle');
  assert.ok(dhan.calls.some(c => c[0] === 'candles' && c[1] !== '13' && c[2] === '1'), 'the option 1-minute candle');
  const row = stmt(`SELECT * FROM auto_trades WHERE user_id = ? ORDER BY id DESC`).get(uid);
  assert.equal(row.signal_key, `${D2}:x:${at2(D2, '09:25')}`);
  assert.equal(JSON.parse(row.detail).setup.strategy, 'EMA 5/9 1m');
  stmt(`UPDATE auto_trades SET status = 'closed' WHERE id = ?`).run(row.id);
});

test('EMA 5/9 switch off: the same crossover is not traded (ORB is unaffected)', async () => {
  flatBook();
  const DAY_MS = 86_400_000, D3 = '2026-10-21', bars = oneBars.map(b => ({ ...b, time: b.time + DAY_MS }));
  const dhan = fakeDhan();
  dhan.intradayCandles = async q => q.securityId === '13' ? asRaw(bars) : { timestamp: [], open: [], high: [], low: [], close: [] };
  const r = await scanForEntry({ ...acct, cross_on: 0, gap_on: 0 }, { now: at2(D3, '09:26') + 3500, adapter: dhan, pause: noPause, instruments });
  assert.ok(!r.entered, JSON.stringify(r));
  assert.ok(!dhan.calls.some(c => c[0] === 'order'));
  assert.equal(stmt(`SELECT COUNT(*) AS n FROM auto_trades WHERE user_id = ? AND day = ?`).get(uid, D3).n, 0);
});

test('chart: EMA 9/21 crossover arrows on the 5-minute chart only, premium arrows on that side only', async () => {
  const { emaCrossSignals, emaCrossMarkers } = await import('../../web/js/pages/scalper-chart-signals.js');
  const rows = crossBars.map(b => ({ ...b, time: b.time / 1000 })), now = at2(D2, '10:10') + 3000;
  const sig = emaCrossSignals(rows, { intervalMs: 300_000, now });
  assert.deepEqual(sig.at(-1), { time: at2(D2, '10:05') / 1000, direction: 'CE' });
  assert.deepEqual(emaCrossSignals(rows, { intervalMs: 60_000, now }), [], '1-minute chart: none');
  const last = [sig.at(-1)];
  assert.match(emaCrossMarkers(last, 'spot')[0].text, /CE BUY · EMA 9\/21/);
  assert.equal(emaCrossMarkers(last, 'ce').length, 1);
  assert.equal(emaCrossMarkers(last, 'pe').length, 0);
});

test('ORB 5m switch off: a confirmed ORB signal is not traded', async () => {
  flatBook();
  const D4 = '2026-10-22', shift = Date.parse(`${D4}T00:00:00+05:30`) - Date.parse(`${D}T00:00:00+05:30`);
  const dhan = fakeDhan();
  dhan.intradayCandles = async q => q.securityId === '13'
    ? raw(spot5.map(b => b)).timestamp && { ...raw(spot5), timestamp: raw(spot5).timestamp.map(t => t + shift / 1000) } : raw([]);
  const r = await scanForEntry({ ...acct, orb_on: 0, cross_on: 0 }, { now: ms('10:10') + shift + 3000, adapter: dhan, pause: noPause, instruments });
  assert.equal(r.skipped, 'no fresh ORB signal');
  assert.ok(!dhan.calls.some(c => c[0] === 'order'));
});

test('AI Algo Trading page data: readiness, strategy switches, day SL left; strategies switch on their own', async () => {
  const base = `http://127.0.0.1:${server.address().port}`, H = { 'Content-Type': 'application/json', Cookie: cookie };
  stmt("UPDATE broker_accounts SET agent_on = 1, status = 'connected', orb_on = 1, cross_on = 1 WHERE id = ?").run(acct.id);
  const live = await (await fetch(`${base}/api/algo/live`, { headers: H })).json();
  assert.deepEqual(live.readiness.map(r => r.id), ['dhan', 'connected', 'protection', 'orders', 'subscription', 'lossLimit']);
  assert.equal(live.account.orbOn, true);
  assert.equal(live.account.emaCrossOn, true);
  assert.ok(live.budget.left >= 0 && 'squareOff' in live.rules);
  const off = await fetch(`${base}/api/brokers/${acct.id}/strategies`, { method: 'POST', headers: H, body: JSON.stringify({ orb: false }) });
  assert.equal(off.status, 200);
  const row = stmt('SELECT orb_on, cross_on FROM broker_accounts WHERE id = ?').get(acct.id);
  assert.deepEqual([row.orb_on, row.cross_on], [0, 1], 'only ORB switched off');
  stmt('UPDATE broker_accounts SET orb_on = 1 WHERE id = ?').run(acct.id);
});

test('SENSEX selected: its index candles, BSE option chain and BSE order segment are used', async () => {
  flatBook();
  const D5 = '2026-10-23', shift = Date.parse(`${D5}T00:00:00+05:30`) - Date.parse(`${D}T00:00:00+05:30`);
  const dhan = fakeDhan(), seen = { candles: [], chain: [], inst: null };
  dhan.intradayCandles = async q => { seen.candles.push([q.securityId, q.exchangeSegment]);
    const bars = q.securityId === '51' ? spot5 : [['10:00', 114, 118, 110.03, 117]];
    const r = raw(bars); return { ...r, timestamp: r.timestamp.map(t => t + shift / 1000) }; };
  const chainFn = dhan.optionChain.bind(dhan);
  dhan.optionChain = async q => { seen.chain.push(q.underlyingScrip); return chainFn(q); };
  const inst = async u => { seen.inst = u.key; return instruments(); };
  const r = await scanForEntry({ ...acct, algo_underlying: 'SENSEX' }, { now: ms('10:10') + shift + 3000, adapter: dhan, pause: noPause, instruments: inst });
  assert.equal(r.entered, true, JSON.stringify(r));
  assert.ok(seen.candles.some(([id, seg]) => id === '51' && seg === 'IDX_I'), 'SENSEX index candles');
  assert.ok(seen.candles.some(([id, seg]) => id === 'C1' && seg === 'BSE_FNO'), 'premium candles from BSE F&O');
  assert.deepEqual(seen.chain, [51]);
  assert.equal(seen.inst, 'SENSEX');
  const [buy, sl] = dhan.calls.filter(c => c[0] === 'order').map(c => c[1]);
  assert.deepEqual([buy.exchangeSegment, sl.exchangeSegment], ['BSE_FNO', 'BSE_FNO']);
  assert.match(buy.symbol, /^SENSEX /);
  assert.ok(buy.qty <= 1000, 'SENSEX freeze quantity');
  stmt(`UPDATE auto_trades SET status = 'closed' WHERE user_id = ? AND status IN ('open', 'closing', 'placing')`).run(uid);
});

test('several indices: stored as a list, each scanned on its own on the same 5-minute close', async () => {
  assert.deepEqual(algoIndices({ algo_underlying: 'NIFTY,SENSEX' }), ['NIFTY', 'SENSEX']);
  assert.deepEqual(algoIndices({ algo_underlying: '' }), ['NIFTY']);
  assert.deepEqual(algoIndices({ algo_underlying: 'BANKNIFTY,junk' }), ['BANKNIFTY']);
  const base = `http://127.0.0.1:${server.address().port}`, H = { 'Content-Type': 'application/json', Cookie: cookie };
  stmt("UPDATE broker_accounts SET status = 'connected', agent_on = 1 WHERE id = ?").run(acct.id);
  const post = body => fetch(`${base}/api/brokers/${acct.id}/strategies`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  assert.equal((await post({ underlyings: ['SENSEX', 'nifty'] })).status, 200);
  assert.equal(stmt('SELECT algo_underlying FROM broker_accounts WHERE id = ?').get(acct.id).algo_underlying, 'NIFTY,SENSEX');
  assert.equal((await post({ underlyings: [] })).status, 400, 'at least one index');
  assert.equal((await post({ underlyings: ['FINNIFTY'] })).status, 400, 'only supported indices');
  const live = await (await fetch(`${base}/api/algo/live`, { headers: H })).json();
  assert.deepEqual(live.account.underlyings, ['NIFTY', 'SENSEX']);
  // Same minute, two indices: the second is not blocked by the first one's "candle done".
  flatBook();
  const D6 = '2026-10-26', shift = Date.parse(`${D6}T00:00:00+05:30`) - Date.parse(`${D}T00:00:00+05:30`), now = ms('10:10') + shift + 3000;
  const quiet = fakeDhan(); quiet.intradayCandles = async () => { const r = raw(spot5); return { ...r, timestamp: r.timestamp.map(t => t + shift / 1000) }; };
  const a1 = { ...acct, algo_underlying: 'NIFTY,SENSEX', orb_on: 0, cross_on: 0 };   // scan only, no trade
  const n = await scanForEntry(a1, { now, adapter: quiet, pause: noPause, instruments, underlying: 'NIFTY' });
  const sx = await scanForEntry(a1, { now, adapter: quiet, pause: noPause, instruments, underlying: 'SENSEX' });
  assert.notEqual(sx.skipped, 'candle done', JSON.stringify([n, sx]));
  assert.equal((await scanForEntry(a1, { now: now + 4000, adapter: quiet, pause: noPause, instruments, underlying: 'SENSEX' })).skipped, 'no breakout to watch');
  stmt("UPDATE broker_accounts SET algo_underlying = 'NIFTY' WHERE id = ?").run(acct.id);
});

test('Algo Trading switch: refused with protection off; stopping protection stops it', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const id = acct.id;
  stmt("UPDATE broker_accounts SET agent_on = 0, algo_on = 0, status = 'connected' WHERE id = ?").run(id);   // earlier background syncs hit the real Dhan with a fake token
  const off = await fetch(`${base}/api/brokers/${id}/algo`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ on: true }) });
  assert.equal(off.status, 409);
  assert.match((await off.json()).message, /protection on first/);
  stmt('UPDATE broker_accounts SET agent_on = 1, algo_on = 1 WHERE id = ?').run(id);
  const stop = await fetch(`${base}/api/brokers/${id}/agent`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ on: false }) });
  const { marketOpen } = await import('../src/lib/time.js');
  if (marketOpen()) {   // market hours: Algo Trading (and the Protection it needs) cannot be switched off
    assert.equal(stop.status, 409); assert.equal((await stop.json()).code, 'ALGO_LOCKED');
    const algoOff = await fetch(`${base}/api/brokers/${id}/algo`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ on: false }) });
    assert.equal(algoOff.status, 409);
    assert.equal(stmt('SELECT algo_on, agent_on FROM broker_accounts WHERE id = ?').get(id).algo_on, 1);
  } else {
    assert.equal(stop.status, 200);
    assert.equal(stmt('SELECT algo_on FROM broker_accounts WHERE id = ?').get(id).algo_on, 0, 'stopping protection stops Algo Trading too');
  }
});

test('Algo Trading lock: on during 09:15-15:30 on a weekday, free before / after and at weekends', async () => {
  const { algoLocked } = await import('../src/modules/risk/service.js');
  const at = s => Date.parse(`${s}+05:30`);
  assert.equal(algoLocked({ algo_on: 1 }, at('2026-10-22T10:00:00')), true);
  assert.equal(algoLocked({ algo_on: 1 }, at('2026-10-22T09:14:00')), false, 'before the open');
  assert.equal(algoLocked({ algo_on: 1 }, at('2026-10-22T15:30:00')), false, 'after the close');
  assert.equal(algoLocked({ algo_on: 1 }, at('2026-10-24T11:00:00')), false, 'Saturday');
  assert.equal(algoLocked({ algo_on: 0 }, at('2026-10-22T10:00:00')), false, 'Algo Trading off: nothing to lock');
});

test('ORB live entry: after the breakout candle closes, enter the moment the next candle trades past its high', async () => {
  // 10:00 closes at 106 above the 105 OR High (its high 107); the 10:05 candle is still forming.
  const { normalizeScalperCandles: norm } = await import('../src/modules/scalper/routes.js');
  const five = norm(raw(spot5.slice(0, 3)));
  const day = new Date(ms('10:00') + 19800000).toISOString().slice(0, 10), at = ms('10:05') + 3000;
  const watch = orbLive(five, at, day, null, { mode: 'live' });
  assert.deepEqual(watch.pending, { direction: 'CE', level: 107, until: ms('10:10') }, 'watch 107 for the rest of the 10:05 candle');
  assert.ok(orbLive(five, at + 60_000, day, 106.9, { mode: 'live' }).pending, 'not crossed yet: keep watching');
  const go = orbLive(five, at + 90_000, day, 107.2, { mode: 'live' }).setup;
  assert.deepEqual([go.direction, go.trigger, go.live, go.breakoutAt, go.confirmedAt, go.enteredAt], ['BUY_CE', 107, true, ms('10:00'), ms('10:05'), at + 90_000], 'enter at once, in the live candle');
  // No colour or body check any more: a red candle that still trades past the high enters.
  assert.ok(orbLive([...five, ...norm(raw([['10:05', 107, 107.5, 104, 104.5]]))], ms('10:10') + 3000, day, null, { mode: 'live' }).setup);
  // The default (yesterday's rule) needs the confirming candle closed green with a real body: that red one is not a trade.
  assert.equal(orbLive([...five, ...norm(raw([['10:05', 107, 107.5, 104, 104.5]]))], ms('10:10') + 3000, day).setup, undefined);
  assert.equal(orbLive(five, at, day).pending, undefined, 'nothing is watched live');
});

test('dynamic SL: at entry + 1 × the risk (each strategy\'s default) the Dhan stop order moves to the entry price, once', async () => {
  const id = Number(stmt(`INSERT INTO auto_trades (user_id, day, signal_key, direction, status, security_id, exchange_segment, symbol, qty, entry_order_id, entry_price, sl_price, sl_order_id, seen_open, detail, created_at)
    VALUES (?, ?, 'be-test', 'CE', 'open', 'C9', 'NSE_FNO', 'NIFTY-C9', 650, 'E9', 120, 110, 'S9', 1, '{}', ?)`).run(uid, D, Date.now()).lastInsertRowid);
  const calls = [], at = { px: 124.9 };
  const dhan = { async ltp() { return at.px; }, async modifyStopLoss(oid, o) { calls.push([oid, o]); return { id: oid }; } };
  const row = () => stmt('SELECT * FROM auto_trades WHERE id = ?').get(id);
  assert.equal(await costToCost(row(), dhan, ms('10:29')), null, '+4.9 of a 10 risk: below 1R, not yet');
  at.px = 129.9;
  assert.equal(await costToCost(row(), dhan, ms('10:30')), null, '+9.9: still under 1R');
  at.px = 130;
  assert.equal(await costToCost(row(), dhan, ms('10:31')), 120, '+10 ≥ 1R: stop to cost');
  assert.deepEqual(calls, [['S9', { triggerPrice: 120, price: 108, qty: 650 }]]);
  assert.equal(row().sl_price, 120);
  assert.equal(await costToCost(row(), dhan, ms('10:32')), null, 'already at cost: never moved again');
  assert.equal(calls.length, 1);
  stmt('DELETE FROM auto_trades WHERE id = ?').run(id);
});


test('live ticks: ORB entry on the tick-built 5-minute candle right at the close, and the EMA 9 exit the same way', async () => {
  flatBook();
  const D5 = '2026-10-16', shift = Date.parse(`${D5}T00:00:00+05:30`) - Date.parse(`${D}T00:00:00+05:30`), at = hhmm => ms(hhmm) + shift;
  const shifted = bars => { const r = raw(bars); return { ...r, timestamp: r.timestamp.map(t => t + shift / 1000) }; };
  // Dhan has not published the 10:05 index candle yet; the feed has its five 1-minute candles.
  const minutes = { '10:05': [106.2, 106.9, 106.1, 106.8], '10:06': [106.8, 107.4, 106.6, 107.3], '10:07': [107.3, 108, 107, 107.6], '10:08': [107.6, 107.9, 106, 107.1], '10:09': [107.1, 107.9, 107, 107.8] };
  const saved = { ...FEED };
  const tickMinutes = extra => (u, key, minute) => {
    const hit = Object.entries({ ...minutes, ...extra }).find(([hm]) => at(hm) === minute);
    return u === uid && key === 'IDX_I:13' && hit ? { open: hit[1][0], high: hit[1][1], low: hit[1][2], close: hit[1][3] } : null;
  };
  FEED.minute = tickMinutes({});
  try {
    const dhan = fakeDhan();
    dhan.intradayCandles = async q => { dhan.calls.push(['candles', q.securityId, q.interval]);
      return q.securityId === '13' ? shifted(spot5.filter(b => b[0] !== '10:05')) : shifted(['C1', 'P1'].includes(q.securityId) ? [['10:00', 114, 118, 110.03, 117], ['10:05', 117, 121, 116, 120]] : []); };
    const r = await scanForEntry(acct, { now: at('10:10') + 500, adapter: dhan, pause: noPause, instruments });
    assert.equal(r.entered, true, JSON.stringify(r));
    const row = stmt('SELECT * FROM auto_trades WHERE user_id = ? ORDER BY id DESC').get(uid);
    assert.equal(JSON.parse(row.detail).setup.candleSource, 'live ticks', '0.5 s after the close, before Dhan published it');

    // EMA 9 exit: 10:10 closed at 100 (REST); 10:15 is only on the feed, closing at 99 → two closes under EMA 9.
    stmt(`UPDATE auto_trades SET status = 'open', seen_open = 1 WHERE id = ?`).run(row.id);
    setBook(uid, { positions: [{ securityId: 'C1', symbol: 'NIFTY-C1', qty: row.qty }], orders: [{ id: 'S1', symbol: 'NIFTY-C1' }], funds: { available: 80000, used: 117000 }, at: Date.now() });
    FEED.minute = tickMinutes({ '10:15': [100, 101, 98.5, 99.6], '10:16': [99.6, 100, 98, 99.2], '10:17': [99.2, 99.8, 98.4, 99.5], '10:18': [99.5, 99.9, 98.8, 99.1], '10:19': [99.1, 99.5, 98.7, 99] });
    const ex = fakeDhan({ slStatus: 'pending' });
    ex.intradayCandles = async q => { ex.calls.push(['candles', q.securityId, q.interval]);
      return q.securityId === '13' ? shifted([...spot5, ['10:10', 107, 107, 99, 100]]) : shifted([]); };
    await manageTrade(stmt('SELECT * FROM auto_trades WHERE id = ?').get(row.id), { now: at('10:20') + 500, adapter: ex });
    assert.deepEqual(ex.calls.filter(c => c[0] === 'cancel' || c[0] === 'exit').map(c => c[0]), ['cancel', 'exit']);
    assert.match(stmt('SELECT reason FROM auto_trades WHERE id = ?').get(row.id).reason, /Two 5-minute closes below EMA 9/);
  } finally { Object.assign(FEED, saved); }
});
