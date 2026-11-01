// EMA 9/15 5m with a 30° EMA 9 angle (its own switch, ema915_on): the signal, one trade per crossover, the opposite-colour
// 5-minute exit, and the switch on the AI Algo Trading page.
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
const { emaTrendSetup, emaTrendExit, atrSeries, scanForEntry, manageTrade, EMA_TREND } = await import('../src/modules/scalper/autotrade.js');

const D = '2026-10-20', at = hhmm => Date.parse(`${D}T${hhmm}:00+05:30`), BAR = 300_000;
const bar = (time, close, open = close) => ({ time, open, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, close });
// A flat previous session at 100 (ATR ≈ 2), then today a slide from 99 to 90 (09:15 … 10:00): EMA 9 under EMA 15.
const base = (() => {
  const out = [];
  for (let i = 0; i < 40; i++) out.push(bar(Date.parse('2026-10-19T12:00:00+05:30') + i * BAR, 100));
  for (let i = 0; i < 10; i++) out.push(bar(at('09:15') + i * BAR, 99 - i));
  return out;
})();
// 10:05 closes at 120: EMA 9 crosses above EMA 15 rising at about 52°.
const steep = [...base, bar(at('10:05'), 120, 91)];
// A slow climb instead: EMA 9 crosses EMA 15 at 10:25 at only about 27°; the 10:30 candle then lifts it at about 46°.
const creep = [...base, ...[93, 96, 98, 100, 102].map((c, k) => bar(at('10:05') + k * BAR, c, c - 1))];
const late = [...creep, bar(at('10:30'), 114, 102)];

test('ATR is Wilder’s average of the true range', () => {
  const a = atrSeries([{ high: 11, low: 9, close: 10 }, { high: 14, low: 12, close: 13 }], 14);
  assert.deepEqual(a.map(x => Math.round(x * 1000) / 1000), [2, Math.round((2 * 13 + 4) / 14 * 1000) / 1000], 'true range 4: the gap from the 10 close to the 14 high');
});

test('a crossover with EMA 9 at 30° or steeper is the signal; a shallow one is not', () => {
  const x = emaTrendSetup(steep, at('10:10') + 3000, D);
  assert.deepEqual([x.strategy, x.direction, x.breakoutAt, x.crossAt, x.interval], ['EMA 9/15 5m', 'BUY_CE', at('10:05'), at('10:05'), '5']);
  assert.ok(x.ema9 > x.ema15 && x.angle >= 50 && x.angle < 55, JSON.stringify(x));
  assert.equal(emaTrendSetup(creep, at('10:30') + 3000, D), null, 'crossed at 27°: under 30°, no trade');
  assert.equal(emaTrendSetup(steep, at('10:11'), D), null, 'older than the 45-second entry window');
  assert.equal(emaTrendSetup(steep, at('10:08'), D), null, 'a candle still forming is never used');
  const down = steep.map(b => b.time >= at('09:15') ? { ...b, close: 200 - b.close, open: 200 - b.open, high: 200 - b.low, low: 200 - b.high } : b);
  assert.equal(emaTrendSetup(down, at('10:10') + 3000, D).direction, 'BUY_PE', 'mirror image: PE');
});

test('the angle can come up to 3 candles after the crossover; once per crossover', () => {
  const x = emaTrendSetup(late, at('10:35') + 3000, D);
  assert.deepEqual([x.direction, x.breakoutAt, x.crossAt], ['BUY_CE', at('10:30'), at('10:25')], 'entered on 10:30, the leg of the 10:25 crossover');
  assert.ok(x.angle >= EMA_TREND.minAngle);
  const after = [...late, bar(at('10:35'), 125, 114)];
  assert.equal(emaTrendSetup(after, at('10:40') + 3000, D), null, 'a second steep candle in the same leg: already signalled');
  const tooLate = [...creep, ...[103, 104, 105].map((c, k) => bar(at('10:30') + k * BAR, c, c - 1)), bar(at('10:45'), 125, 105)];
  assert.equal(emaTrendSetup(tooLate, at('10:50') + 3000, D), null, '4 candles after the crossover: too late');
});

test('exit: the first opposite-colour 5-minute candle since the entry', () => {
  const since = at('10:10'), green = bar(since, 125, 120), red = bar(since + BAR, 118, 124);
  assert.equal(emaTrendExit([...steep, green], { direction: 'CE', since, now: since + BAR + 1000 }), null, 'green: hold the CE');
  assert.match(emaTrendExit([...steep, green, red], { direction: 'CE', since, now: since + 2 * BAR + 1000 }), /First red 5-minute candle \(10:15\) since the entry/);
  assert.equal(emaTrendExit([...steep, green, red], { direction: 'CE', since, now: since + 2 * BAR - 1000 }), null, 'still forming');
  assert.match(emaTrendExit([...steep, green], { direction: 'PE', since, now: since + BAR + 1000 }), /First green/);
});

// ---- live entry and exit against a fake Dhan ------------------------------------------------------------
const asRaw = bars => ({ timestamp: bars.map(b => b.time / 1000), open: bars.map(b => b.open), high: bars.map(b => b.high), low: bars.map(b => b.low), close: bars.map(b => b.close) });
function fakeDhan(spot) {
  const calls = [];
  return {
    calls,
    async optionExpiries() { return ['2026-10-20', '2026-10-27']; },
    async optionChain({ expiry }) { calls.push(['chain', expiry]); return { last_price: 23010, oc: { '23000': { ce: { security_id: 'C1', top_ask_price: 120 }, pe: { security_id: 'P1', top_ask_price: 90 } } } }; },
    async intradayCandles(q) {
      calls.push(['candles', q.securityId, q.interval]);
      return q.securityId === '13' ? asRaw(spot) : asRaw([{ time: at('10:05'), open: 104, high: 121, low: 110.03, close: 118 }]);
    },
    async placeOrder(o) { calls.push(['order', o]); return { id: o.type === 'STOP_LOSS' ? 'S1' : 'E1', status: 'pending' }; },
    async orderStatus(id) { return id === 'E1' ? { status: 'filled', price: 120.5 } : { status: 'pending' }; },
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
    body: JSON.stringify({ email: 'ema915@example.com', password: 'longpassword' }) });
  cookie = res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  uid = stmt('SELECT id FROM users WHERE email = ?').get('ema915@example.com').id;
  const active = getRules(uid).active;
  saveRules(uid, { ...active, cutoff: { ...active.cutoff, on: false } });
  upsertAccount(uid, { broker: 'dhan', clientId: 'C915', accessToken: 'test-token-not-real-0123456789' });
  stmt("UPDATE broker_accounts SET agent_on = 1, algo_on = 1, status = 'connected', orb_on = 0, cross_on = 0, gap_on = 0 WHERE user_id = ?").run(uid);
  acct = stmt('SELECT * FROM broker_accounts WHERE user_id = ?').get(uid);
});
after(() => server.close());
const flatBook = () => setBook(uid, { positions: [], orders: [], funds: { available: 200000, used: 0 }, at: Date.now() });

test('the switch is off by default: the steep crossover is not traded', async () => {
  flatBook();
  assert.equal(acct.ema915_on, 0);
  const DAY = 86_400_000, dhan = fakeDhan(steep.map(b => ({ ...b, time: b.time + DAY })));   // the next day: its own 5-minute scan
  const r = await scanForEntry(acct, { now: at('10:10') + DAY + 3500, adapter: dhan, pause: noPause, instruments });
  assert.ok(!r.entered, JSON.stringify(r));
  assert.ok(!dhan.calls.some(c => c[0] === 'order'));
});

test('switch on: market buy of the next-expiry ATM, SL one tick below the option 5-minute signal candle; exit on the first red candle', async () => {
  flatBook();
  const dhan = fakeDhan(steep);
  const r = await scanForEntry({ ...acct, ema915_on: 1 }, { now: at('10:10') + 3500, adapter: dhan, pause: noPause, instruments });
  assert.equal(r.entered, true, JSON.stringify(r));
  assert.deepEqual(dhan.calls.find(c => c[0] === 'chain'), ['chain', '2026-10-27'], 'next expiry');
  const [buy, sl] = dhan.calls.filter(c => c[0] === 'order').map(c => c[1]);
  assert.deepEqual([buy.side, buy.type, buy.securityId], ['BUY', 'MARKET', 'C1']);
  assert.equal(sl.triggerPrice, 110, 'one tick below the 110.03 low of the option 10:05 candle');
  assert.ok(dhan.calls.some(c => c[0] === 'candles' && c[1] === 'C1' && c[2] === '5'), 'the option 5-minute candle');
  const row = stmt('SELECT * FROM auto_trades WHERE user_id = ? ORDER BY id DESC').get(uid);
  assert.equal(row.signal_key, `${D}:t:${at('10:05')}`, 'claimed by its crossover');
  assert.equal(JSON.parse(row.detail).setup.strategy, 'EMA 9/15 5m');
  const note = stmt('SELECT body FROM notifications WHERE user_id = ? ORDER BY id DESC').get(uid).body;
  assert.match(note, /EMA 9 angle 5\d\.\d+°/);
  assert.match(note, /the first red 5-minute candle/);

  // 10:10 closes green (hold), 10:15 red: out at market, the stop cancelled first.
  setBook(uid, { positions: [{ securityId: 'C1', symbol: 'NIFTY-C1', qty: row.qty }], orders: [{ id: 'S1', symbol: 'NIFTY-C1' }], funds: { available: 100000, used: 100000 }, at: Date.now() });
  const green = [...steep, bar(at('10:10'), 125, 120)];
  const hold = fakeDhan(green);
  await manageTrade(stmt('SELECT * FROM auto_trades WHERE id = ?').get(row.id), { now: at('10:15') + 5000, adapter: hold });
  assert.ok(!hold.calls.some(c => c[0] === 'exit'), 'green candle: hold');
  const out = fakeDhan([...green, bar(at('10:15'), 118, 124)]);
  await manageTrade(stmt('SELECT * FROM auto_trades WHERE id = ?').get(row.id), { now: at('10:20') + 5000, adapter: out });
  assert.deepEqual(out.calls.filter(c => c[0] === 'cancel' || c[0] === 'exit').map(c => c[0]), ['cancel', 'exit']);
  const t = stmt('SELECT status, reason FROM auto_trades WHERE id = ?').get(row.id);
  assert.equal(t.status, 'closing');
  assert.match(t.reason, /First red 5-minute candle \(10:15\)/);
  stmt("UPDATE auto_trades SET status = 'closed' WHERE id = ?").run(row.id);
});

test('AI Algo Trading page: the EMA 9/15 switch turns on and off on its own', async () => {
  const base = `http://127.0.0.1:${server.address().port}`, H = { 'Content-Type': 'application/json', Cookie: cookie };
  const on = await fetch(`${base}/api/brokers/${acct.id}/strategies`, { method: 'POST', headers: H, body: JSON.stringify({ ema915: true }) });
  assert.equal(on.status, 200);
  assert.equal((await on.json()).account.ema915On, true);
  const live = await (await fetch(`${base}/api/algo/live`, { headers: H })).json();
  assert.equal(live.account.ema915On, true);
  const row = stmt('SELECT ema915_on, orb_on, cross_on, gap_on FROM broker_accounts WHERE id = ?').get(acct.id);
  assert.deepEqual([row.ema915_on, row.orb_on, row.cross_on, row.gap_on], [1, 0, 0, 0], 'only EMA 9/15 switched on');
  // Off again with ORB on (during market hours one strategy must stay on while Algo Trading runs).
  const off = await fetch(`${base}/api/brokers/${acct.id}/strategies`, { method: 'POST', headers: H, body: JSON.stringify({ orb: true, ema915: false }) });
  assert.equal(off.status, 200);
  assert.deepEqual(Object.values(stmt('SELECT ema915_on, orb_on FROM broker_accounts WHERE id = ?').get(acct.id)), [0, 1]);
});

test('Backtest: an EMA 9/15 run can be saved (the strategy is allowed in backtest_runs)', () => {
  const r = stmt(`INSERT INTO backtest_runs (user_id,strategy,start_date,end_date,horizon_bars,created_at,as_of,one_minute_bars,range_sessions,signal_count,metrics_json,candles_gzip)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(uid, 'ema915', D, D, 0, Date.now(), Date.now(), 375, 1, 1, '{}', Buffer.from('{}'));
  assert.equal(stmt('SELECT strategy FROM backtest_runs WHERE id = ?').get(Number(r.lastInsertRowid)).strategy, 'ema915');
});
