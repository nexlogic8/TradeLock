// Gap open 09:15 live entry: the signal on the ATM options' first ticks after 09:15:00 (gapFirstTick), or at 09:15:02 from a
// quote when no first ticks came (one quote request, chain prefetched); the MARKET buy of 80% of the funds at the premium now on
// the nearest expiry (the rest covers the broker blocking a market order above it); the stop from the Risk rules' daily
// stop-loss, the cancel when it is not filled, and the exit on the first opposite-colour 1-minute candle.
process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
process.env.ADMIN_EMAILS = 'gap@example.com';   // the full strategy view (lib/access.js)
const { test, before, after } = await import('node:test');
const { createServer } = await import('node:http');
const { createHandler } = await import('../src/lib/app.js');
const { buildRouter } = await import('../src/modules/index.js');
const assert = (await import('node:assert/strict')).default;
const { stmt } = await import('../src/db/index.js');
const { setBook } = await import('../src/modules/broker/book.js');
const { patchDay } = await import('../src/modules/risk/service.js');
const { upsertAccount } = await import('../src/modules/broker/registry.js');
const { saveRules, getRules } = await import('../src/modules/rules/service.js');
const { gapPick, premiumGreen, gapExitCandle, scanForEntry, manageTrade, gapFirstTick, strikeFrom, stopGone, AUTO, FEED, GAP_LIVE } = await import('../src/modules/scalper/autotrade.js');
// The ATM tests below trade the ATM; the live default (ITM2) has its own test at the end.
assert.equal(GAP_LIVE.strike, 2, 'live: ITM2');
GAP_LIVE.strike = 0;

const D = '2026-10-19', ms = hhmmss => Date.parse(`${D}T${hhmmss}+05:30`);
const raw = bars => ({ timestamp: bars.map(b => ms(b[0]) / 1000), open: bars.map(b => b[1]), high: bars.map(b => b[2]), low: bars.map(b => b[3]), close: bars.map(b => b[4]) });

test('gap rule from the premiums: the one side that gapped up and is green; both or neither → no trade', () => {
  assert.deepEqual(gapPick({ CE: { prev: 125, open: 140, ltp: 150 }, PE: { prev: 110, open: 95, ltp: 98 } }), { direction: 'CE', gapPct: 12 });
  assert.deepEqual(gapPick({ CE: { prev: 160, open: 140, ltp: 150 }, PE: { prev: 90, open: 95, ltp: 98 } }), { direction: 'PE', gapPct: 5.56 });
  assert.ok(gapPick({ CE: { prev: 125, open: 140, ltp: 150 }, PE: { prev: 90, open: 95, ltp: 98 } }).skip.startsWith('both'), 'both gapped up green');
  assert.ok(gapPick({ CE: { prev: 125, open: 140, ltp: 139 }, PE: { prev: 110, open: 95, ltp: 98 } }).skip.startsWith('no premium'), 'CE gapped up but red');
  assert.ok(gapPick({ CE: { prev: 160, open: 140, ltp: 150 }, PE: { prev: 110, open: 95, ltp: 98 } }).skip, 'neither gapped up');
  assert.equal(premiumGreen({ open: 140, ltp: 150 }), true);
  assert.equal(premiumGreen({ open: 140, ltp: 139 }), false, 'red');
  assert.equal(premiumGreen({ open: 140, ltp: 140 }), false, 'flat');
  assert.equal(premiumGreen({ open: null, ltp: 150 }), false, 'no open');
  // Live (requireGreen off): the gap alone decides, so a premium back below its open still counts.
  assert.equal(AUTO.gap.requireGreen, false);
  assert.deepEqual(gapPick({ CE: { prev: 125, open: 140, ltp: 139 }, PE: { prev: 110, open: 95, ltp: 98 } }, { requireGreen: false }), { direction: 'CE', gapPct: 12 });
  assert.ok(gapPick({ CE: { prev: 125, open: 140, ltp: 139 }, PE: { prev: 90, open: 95, ltp: 94 } }, { requireGreen: false }).skip.startsWith('both'));
});

test('exit: first completed index 1-minute candle of the other colour, from the entry candle on', () => {
  const one = [['09:15:00', 100, 104, 99, 103], ['09:16:00', 103, 106, 102, 105], ['09:17:00', 105, 106, 101, 102], ['09:18:00', 102, 103, 100, 101]]
    .map(b => ({ time: ms(b[0]), open: b[1], high: b[2], low: b[3], close: b[4] }));
  const since = ms('09:15:10');
  assert.equal(gapExitCandle(one, { direction: 'CE', since, now: ms('09:17:30') }), null, '09:17 red but not closed yet');
  assert.equal(gapExitCandle(one, { direction: 'CE', since, now: ms('09:18:03') }).time, ms('09:17:00'));
  assert.equal(gapExitCandle(one, { direction: 'PE', since, now: ms('09:16:03') }).time, ms('09:15:00'), 'the entry candle itself counts');
});

// ---- live lifecycle against a fake Dhan ----
function fakeDhan({ fills = true, ltp = 23070, idxOpen = 23060, fillPrice = 150.6, partQty = 0, peOpen = 95, cePrev = 125, pePrev = 110, lastTrade = {} } = {}) {
  const calls = [];
  const one = (seg, id) => (seg === 'IDX_I' ? { ltp, open: idxOpen, high: 23080, low: 22900, close: 23000 } : id === 'P1' ? { ltp: 98, open: peOpen, high: 99, low: 94, close: 90 } : { ltp: 150, open: 140, high: 152, low: 138, close: 130 });
  return {
    calls,
    async quote(seg, id) { calls.push(['quote', seg, id]); return one(seg, id); },
    async quotes(by) { calls.push(['quotes', by]); return Object.fromEntries(Object.entries(by).map(([seg, ids]) => [seg, Object.fromEntries(ids.map(id => [String(id), one(seg, String(id))]))])); },
    async optionExpiries() { return ['2026-10-20', '2026-10-27', '2026-11-03']; },
    async optionChain({ expiry }) { calls.push(['chain', expiry]); return { last_price: 23070, oc: { '23050': { ce: { security_id: 'G1', top_ask_price: 150.2, last_price: cePrev }, pe: { security_id: 'P1', last_price: pePrev } }, '23100': { ce: { security_id: 'G2', top_ask_price: 120 } } } }; },
    async intradayCandles({ securityId, interval }) {
      calls.push(['candles', securityId, interval]);
      if (interval === '5') return { timestamp: [Date.parse('2026-10-16T15:25:00+05:30') / 1000], open: [23010], high: [23020], low: [22990], close: [23000] };   // yesterday's last candle
      // An option's 1-minute candles: its last trade of the previous session when the test gives one.
      if (securityId !== '13') { const px = lastTrade[securityId]; return px ? { timestamp: [Date.parse('2026-10-16T15:29:00+05:30') / 1000], open: [px], high: [px], low: [px], close: [px] } : { timestamp: [], open: [], high: [], low: [], close: [] }; }
      return raw([['09:15:00', 23060, 23090, 23055, 23085], ['09:16:00', 23085, 23100, 23080, 23095], ['09:17:00', 23095, 23096, 23070, 23075]]);
    },
    async placeOrder(o) { calls.push(['order', o]); return { id: o.type === 'STOP_LOSS' ? 'GS1' : 'GE1', status: 'pending' }; },
    async orderStatus(id) { calls.push(['status', id]); if (id !== 'GE1') return this.cancelled?.has(id) ? { status: 'failed', filledQty: 0 } : { status: 'pending' }; if (fills) return { status: 'filled', price: fillPrice };
      return partQty && calls.some(x => x[0] === 'cancel') ? { status: 'failed', reason: 'Order cancelled', filledQty: partQty, price: 151 } : { status: 'pending', filledQty: partQty }; },
    async cancelOrder(id) { calls.push(['cancel', id]); (this.cancelled ??= new Set()).add(id); return { status: 'cancelled' }; },
    async exitPosition(p) { calls.push(['exit', p.symbol]); return { id: 'GX1', status: 'pending' }; },
  };
}
const instruments = async () => new Map([['G1', { lotSize: 65, tickSize: 0.05 }], ['G2', { lotSize: 65, tickSize: 0.05 }], ['P1', { lotSize: 65, tickSize: 0.05 }]]);
const noPause = async () => {};
let uid, acct, server;
before(async () => {
  server = createServer(createHandler(buildRouter()));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  await fetch(`http://127.0.0.1:${server.address().port}/api/auth/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'gap@example.com', password: 'longpassword' }) });
  uid = stmt('SELECT id FROM users WHERE email = ?').get('gap@example.com').id;
  const active = getRules(uid).active;
  saveRules(uid, { ...active, cutoff: { ...active.cutoff, on: false } }, undefined, null, 'algo');   // the Algo Trading rule set
  upsertAccount(uid, { broker: 'dhan', clientId: 'C777', accessToken: 'test-token-not-real-0123456789' });
  stmt('UPDATE broker_accounts SET agent_on = 1, algo_on = 1, orb_on = 0, cross_on = 0, gap_on = 1 WHERE user_id = ?').run(uid);
  acct = stmt('SELECT * FROM broker_accounts WHERE user_id = ?').get(uid);
});
after(() => server.close());
const flatBook = () => setBook(uid, { positions: [], orders: [], funds: { available: 200000, used: 0 }, at: Date.now() });

test('gap switch defaults to off; when on (no first ticks), 09:15:02 market-buys 80% of the funds of the nearest expiry, stop from the daily stop-loss', async (t) => {
  const fresh = stmt('SELECT gap_on FROM broker_accounts WHERE user_id != ? LIMIT 1').get(uid);
  if (fresh) assert.equal(fresh.gap_on, 0);
  flatBook();
  const dhan = fakeDhan();
  const early = await scanForEntry(acct, { now: ms('09:15:01'), adapter: dhan, pause: noPause, instruments });
  assert.ok(!dhan.calls.some(c => c[0] === 'quotes'), `not before 09:15:02 (${JSON.stringify(early)})`);
  const r = await scanForEntry(acct, { now: ms('09:15:02'), adapter: dhan, pause: noPause, instruments });
  if (r.skipped && /Subscription|subscription|market|trading day/i.test(r.skipped)) return t.skip(`gate refused in this environment: ${r.skipped}`);
  assert.equal(r.entered, true, JSON.stringify(r));
  assert.deepEqual(dhan.calls.find(c => c[0] === 'chain'), ['chain', '2026-10-20'], 'nearest expiry');
  const [buy, sl] = dhan.calls.filter(c => c[0] === 'order').map(c => c[1]);
  assert.deepEqual([buy.side, buy.type, buy.price, buy.qty, buy.securityId, buy.refPrice], ['BUY', 'MARKET', undefined, 1040, 'G1', 150], '80% of ₹2,00,000 / (150 × 65) = 16 lots, market order');
  assert.deepEqual([sl.type, sl.triggerPrice, sl.qty], ['STOP_LOSS', 141, 1040], 'daily SL 5% of ₹2,00,000 = ₹10,000 ÷ 1,040 qty = ₹9.62 below the 150.60 fill, rounded up to a tick');
  const qs = dhan.calls.filter(c => c[0] === 'quotes');
  assert.equal(qs.length, 1, 'one quote request at 09:15:02');
  assert.ok(qs[0][1].NSE_FNO.includes('G1') && qs[0][1].IDX_I.includes('13'), 'index and nearby options in the same request');
  assert.ok(!dhan.calls.some(c => c[0] === 'quote'), 'no second quote request');
  const row = stmt('SELECT * FROM auto_trades WHERE user_id = ?').get(uid);
  assert.deepEqual([row.status, row.direction, row.signal_key, row.expiry, row.lots], ['open', 'CE', `${D}:gap`, '2026-10-20', 16]);
  // Checked once a day: a later pass in the window does not trade again.
  const again = await scanForEntry(acct, { now: ms('09:15:20'), adapter: fakeDhan(), pause: noPause, instruments });
  assert.notEqual(again.entered, true);
  assert.equal(stmt('SELECT COUNT(*) AS n FROM auto_trades WHERE user_id = ?').get(uid).n, 1);
});

test('the gap CE exits at market at 09:16:00 whatever the colour: stop cancelled first, then market exit', async (t) => {
  const row = stmt('SELECT * FROM auto_trades WHERE user_id = ?').get(uid);
  if (!row) return t.skip('no gap trade in this environment');
  stmt('UPDATE auto_trades SET seen_open = 1 WHERE id = ?').run(row.id);
  setBook(uid, { positions: [{ securityId: 'G1', symbol: 'NIFTY-G1', qty: 1170 }], orders: [{ id: 'GS1', symbol: 'NIFTY-G1' }], funds: { available: 190000, used: 9789 }, at: Date.now() });
  const hold = fakeDhan();
  assert.equal(AUTO.gap.exitAt, '09:16');
  await manageTrade(stmt('SELECT * FROM auto_trades WHERE id = ?').get(row.id), { now: ms('09:15:59'), adapter: hold });
  assert.ok(!hold.calls.some(c => c[0] === 'exit'), 'before 09:16: hold');
  const dhan = fakeDhan();
  await manageTrade(stmt('SELECT * FROM auto_trades WHERE id = ?').get(row.id), { now: ms('09:16:00'), adapter: dhan });
  assert.deepEqual(dhan.calls.filter(c => c[0] === 'cancel' || c[0] === 'exit').map(c => c[0]), ['cancel', 'exit'], '09:15 was green: exits anyway');
  assert.ok(!dhan.calls.some(c => c[0] === 'candles' && c[2] === '1'), 'no candle needed');
  const t2 = stmt('SELECT status, reason FROM auto_trades WHERE id = ?').get(row.id);
  assert.equal(t2.status, 'closing');
  assert.match(t2.reason, /Fixed exit at 09:16 \(any candle colour\)/);
  // The exit is sent only after Dhan reports the stop cancelled (else its RMS reads a short sale: 2 Nov 2026).
  const order = dhan.calls.map(c => c[0] === 'status' ? `status:${c[1]}` : c[0]).filter(c => ['cancel', 'status:GS1', 'exit'].includes(c));
  assert.deepEqual(order.slice(order.indexOf('cancel')), ['cancel', 'status:GS1', 'exit'], 'cancel → confirmed cancelled → exit');
  assert.equal(JSON.parse(stmt('SELECT detail FROM auto_trades WHERE id = ?').get(row.id).detail).exitOrderId, 'GX1', 'exit order remembered');
  // Flat on the next sync: the exit price comes from the exit order's fill.
  setBook(uid, { positions: [], orders: [], funds: { available: 200000, used: 0 }, at: Date.now() });
  const after = fakeDhan();
  after.orderStatus = async id => id === 'GX1' ? { status: 'filled', price: 217.05, filledQty: 1170 } : { status: 'failed', filledQty: 0 };
  await manageTrade(stmt('SELECT * FROM auto_trades WHERE id = ?').get(row.id), { now: ms('09:16:05'), adapter: after });
  const t3 = stmt('SELECT status, exit_price FROM auto_trades WHERE id = ?').get(row.id);
  assert.deepEqual([t3.status, t3.exit_price], ['closed', 217.05], 'the Exit column shows the fill');
});

test('a stop still pending after the cancel (3 s): no exit yet; one that sold first: nothing to exit', async () => {
  const dhan = fakeDhan();
  assert.equal(await stopGone(dhan, 'GS1', { tries: 3, waitMs: 1 }), null, 'Dhan still shows it pending');
  dhan.orderStatus = async () => ({ status: 'filled', filledQty: 65, price: 94.75 });
  assert.equal(await stopGone(dhan, 'GS1', { tries: 3, waitMs: 1 }), 'filled');
});

test('4 Nov: the order status never shows the fill, but Dhan holds the position → taken over: stop-loss placed, trade open', async (t) => {
  const at = x => Date.parse(`2026-10-06T${x}+05:30`);
  stmt('DELETE FROM auto_trades WHERE user_id = ?').run(uid);
  flatBook();
  const dhan = fakeDhan({ fills: false });
  const place = dhan.placeOrder;
  dhan.placeOrder = async o => (o.type === 'MARKET' ? (dhan.calls.push(['order', o]), { id: '0', status: 'pending' }) : place.call(dhan, o));
  dhan.snapshot = async () => ({ positions: dhan.calls.some(c => c[0] === 'order' && c[1].type === 'MARKET') ? [{ securityId: 'G1', qty: 1040, avg: 151.2 }] : [] });
  const r = await scanForEntry(acct, { now: at('09:15:02'), adapter: dhan, pause: noPause, instruments });
  if (r.skipped && /Subscription|subscription|market|trading day/i.test(r.skipped)) return t.skip(`gate refused in this environment: ${r.skipped}`);
  assert.equal(r.entered, true, JSON.stringify(r));
  const row = stmt('SELECT * FROM auto_trades WHERE user_id = ?').get(uid);
  assert.deepEqual([row.status, row.qty, row.entry_price], ['open', 1040, 151.2], 'not "skipped": the held position is the trade');
  const sl = dhan.calls.find(c => c[0] === 'order' && c[1].type === 'STOP_LOSS')?.[1];
  assert.ok(sl && sl.qty === 1040, 'its stop-loss is at Dhan');
  assert.ok(stmt("SELECT 1 FROM notifications WHERE user_id = ? AND title LIKE '%position found at Dhan%'").get(uid));
  // Nothing held: still "not filled", as before.
  stmt('DELETE FROM auto_trades WHERE user_id = ?').run(uid);
  flatBook();
  const none = fakeDhan({ fills: false });
  none.snapshot = async () => ({ positions: [] });
  const r2 = await scanForEntry(acct, { now: Date.parse('2026-10-05T09:15:02+05:30'), adapter: none, pause: noPause, instruments });
  assert.equal(r2.skipped, 'not filled', JSON.stringify(r2));
});

test('an unfilled limit is cancelled and the day is skipped', async (t) => {
  stmt('DELETE FROM auto_trades WHERE user_id = ?').run(uid);
  flatBook();
  const D2 = '2026-10-21', ms2 = s => Date.parse(`${D2}T${s}+05:30`);
  const dhan = fakeDhan({ fills: false });
  const r = await scanForEntry(acct, { now: ms2('09:15:02'), adapter: dhan, pause: noPause, instruments });
  if (r.skipped && /Subscription|subscription|market|trading day/i.test(r.skipped)) return t.skip(`gate refused in this environment: ${r.skipped}`);
  assert.equal(r.skipped, 'not filled', JSON.stringify(r));
  assert.ok(dhan.calls.some(c => c[0] === 'cancel' && c[1] === 'GE1'));
  assert.ok(!dhan.calls.some(c => c[0] === 'order' && c[1].type === 'STOP_LOSS'), 'no stop for a trade that never filled');
  assert.equal(stmt('SELECT status FROM auto_trades WHERE user_id = ?').get(uid).status, 'skipped');
});

test('PE premium gapped up buys the PE, also when it is back below its open (no green wait)', async (t) => {
  const D3 = '2026-10-22', at = x => Date.parse(`${D3}T${x}+05:30`);
  stmt('DELETE FROM auto_trades WHERE user_id = ?').run(uid);
  flatBook();
  const dhan = fakeDhan({ idxOpen: 22940, ltp: 22930, cePrev: 160, pePrev: 90, peOpen: 101 });   // CE gapped down; PE gapped up 90 → 101, now 98
  const r = await scanForEntry(acct, { now: at('09:15:02'), adapter: dhan, pause: noPause, instruments });
  if (r.skipped && /Subscription|subscription|market|trading day/i.test(r.skipped)) return t.skip(`gate refused in this environment: ${r.skipped}`);
  assert.equal(r.entered, true, JSON.stringify(r));
  const buy = dhan.calls.find(c => c[0] === 'order')[1];
  assert.deepEqual([buy.securityId, buy.type, buy.qty], ['P1', 'MARKET', 1625], 'PE market buy: 80% of ₹2,00,000 / (98 × 65) = 25 lots');
});

test('a partly filled limit keeps the traded part and gives it its stop-loss', async (t) => {
  const D5 = '2026-10-26', at = x => Date.parse(`${D5}T${x}+05:30`);
  stmt('DELETE FROM auto_trades WHERE user_id = ?').run(uid);
  flatBook();
  const dhan = fakeDhan({ fills: false, partQty: 325 });
  const r = await scanForEntry(acct, { now: at('09:15:02'), adapter: dhan, pause: noPause, instruments });
  if (r.skipped && /Subscription|subscription|market|trading day/i.test(r.skipped)) return t.skip(`gate refused in this environment: ${r.skipped}`);
  assert.equal(r.entered, true, JSON.stringify(r));
  const sl = dhan.calls.filter(c => c[0] === 'order').map(c => c[1]).find(o => o.type === 'STOP_LOSS');
  assert.deepEqual([sl.qty, sl.triggerPrice], [325, 120.25], 'stop for the 325 that traded: ₹10,000 ÷ 325 = ₹30.77 below 151, rounded up');
  assert.deepEqual(Object.values(stmt('SELECT lots, qty, status FROM auto_trades WHERE user_id = ?').get(uid)), [5, 325, 'open']);
});

test('no lot cap: funds for more than the freeze quantity → one sliced market order and a sliced stop', async (t) => {
  const D6 = '2026-10-27', at = x => Date.parse(`${D6}T${x}+05:30`);
  stmt('DELETE FROM auto_trades WHERE user_id = ?').run(uid);
  setBook(uid, { positions: [], orders: [], funds: { available: 1000000, used: 0 }, at: Date.now() });
  const dhan = fakeDhan();
  const r = await scanForEntry(acct, { now: at('09:15:02'), adapter: dhan, pause: noPause, instruments });
  if (r.skipped && /Subscription|subscription|market|trading day/i.test(r.skipped)) return t.skip(`gate refused in this environment: ${r.skipped}`);
  assert.equal(r.entered, true, JSON.stringify(r));
  const [buy, sl] = dhan.calls.filter(c => c[0] === 'order').map(c => c[1]);
  assert.deepEqual([buy.type, buy.qty, buy.slice], ['MARKET', 82 * 65, true], '80% of ₹10,00,000 / (150 × 65) = 82 lots, above the freeze: sliced');
  assert.deepEqual([sl.type, sl.qty, sl.slice], ['STOP_LOSS', 82 * 65, true]);
});

test('the stop comes from the Risk rules: no daily stop-loss left → no trade', async (t) => {
  const D7 = '2026-10-20', at = x => Date.parse(`${D7}T${x}+05:30`);
  stmt('DELETE FROM auto_trades WHERE user_id = ?').run(uid);
  flatBook();
  const active = getRules(uid).active;
  saveRules(uid, { ...active, maxLoss: { ...active.maxLoss, on: true, mode: 'percent', value: 0.1 } });   // ₹200 for the day: ₹0.17 a unit
  try {
    const dhan = fakeDhan();
    const r = await scanForEntry(acct, { now: at('09:15:02'), adapter: dhan, pause: noPause, instruments });
    if (r.skipped && /Subscription|subscription|market|trading day/i.test(r.skipped)) return t.skip(`gate refused in this environment: ${r.skipped}`);
    assert.match(String(r.skipped), /too tight a stop/, JSON.stringify(r));
    assert.ok(!dhan.calls.some(c => c[0] === 'order'), 'no order');
  } finally { saveRules(uid, active); }
});

test('Capital per trade (Risk rules) caps the Gap entry below 80% of the funds', async (t) => {
  const at = x => Date.parse(`2026-10-08T${x}+05:30`);
  stmt('DELETE FROM auto_trades WHERE user_id = ?').run(uid);
  flatBook();
  const active = getRules(uid).active;
  saveRules(uid, { ...active, capitalUse: { on: true, mode: 'amount', value: 50000 } });
  try {
    const dhan = fakeDhan();
    dhan.optionExpiries = async () => ['2026-10-13'];
    const r = await scanForEntry(acct, { now: at('09:15:02'), adapter: dhan, pause: noPause, instruments });
    if (r.skipped && /Subscription|subscription|market|trading day/i.test(r.skipped)) return t.skip(`gate refused in this environment: ${r.skipped}`);
    assert.equal(r.entered, true, JSON.stringify(r));
    const buy = dhan.calls.find(c => c[0] === 'order')[1];
    assert.equal(buy.qty, 325, '₹50,000 ÷ (≈₹150 × 65) = 5 lots, not the 16 that 80% of ₹2,00,000 buys');
    // Above 80%: the rule decides, not the built-in 80%, but never past what Dhan blocks for a market buy (the premium
    // + 15%, 98% of the funds): ₹1,80,000 asked, ₹1,70,435 fits = 17 lots, so the first order is not refused for funds.
    stmt('DELETE FROM auto_trades WHERE user_id = ?').run(uid);
    flatBook();
    saveRules(uid, { ...active, capitalUse: { on: true, mode: 'amount', value: 180000 } });
    const more = fakeDhan();
    more.optionExpiries = async () => ['2026-10-13'];
    const at2 = x => Date.parse(`2026-10-07T${x}+05:30`);
    const r2 = await scanForEntry(acct, { now: at2('09:15:02'), adapter: more, pause: noPause, instruments });
    assert.equal(r2.entered, true, JSON.stringify(r2));
    assert.equal(more.calls.find(c => c[0] === 'order')[1].qty, 1105);
  } finally { saveRules(uid, active); }
});

test('live ticks: the 09:15:02 decision uses feed ticks (no REST quote); the exit is the fixed 09:16 one', async (t) => {
  const D8 = '2026-10-28', at = x => Date.parse(`${D8}T${x}+05:30`);
  stmt('DELETE FROM auto_trades WHERE user_id = ?').run(uid);
  flatBook();
  const ticks = { 'IDX_I:13': { ltp: 23070, dayOpen: 23060 }, 'NSE_FNO:G1': { ltp: 150, dayOpen: 140 }, 'NSE_FNO:P1': { ltp: 98, dayOpen: 95 } };
  const saved = { ...FEED };
  FEED.tick = (u, key, { since = 0 } = {}) => (u === uid && ticks[key] ? { ...ticks[key], at: at('09:15:01') } : null);
  try {
    const dhan = fakeDhan();
    const r = await scanForEntry(acct, { now: at('09:15:02'), adapter: dhan, pause: noPause, instruments });
    if (r.skipped && /Subscription|subscription|market|trading day/i.test(r.skipped)) return t.skip(`gate refused in this environment: ${r.skipped}`);
    assert.equal(r.entered, true, JSON.stringify(r));
    assert.ok(!dhan.calls.some(c => c[0] === 'quotes' || c[0] === 'quote'), 'no REST price request: all from ticks');
    assert.equal(dhan.calls.find(c => c[0] === 'order')[1].securityId, 'G1', 'CE: premium 125 → 140 open → 150 now');
    const row = stmt('SELECT * FROM auto_trades WHERE user_id = ?').get(uid);
    assert.equal(JSON.parse(row.detail).setup.priceSource, 'live ticks');

    // 09:16:00.5: the fixed exit, without any candle.
    stmt('UPDATE auto_trades SET seen_open = 1 WHERE id = ?').run(row.id);
    setBook(uid, { positions: [{ securityId: 'G1', symbol: 'NIFTY-G1', qty: row.qty }], orders: [{ id: 'GS1', symbol: 'NIFTY-G1' }], funds: { available: 190000, used: 9789 }, at: at('09:16:00') });
    FEED.minute = (u, key, minute) => (key === 'IDX_I:13' && minute === at('09:15:00') ? { open: 23060, high: 23075, low: 23040, close: 23045 } : null);
    const ex = fakeDhan();
    await manageTrade(stmt('SELECT * FROM auto_trades WHERE id = ?').get(row.id), { now: at('09:16:00') + 500, adapter: ex });
    assert.ok(!ex.calls.some(c => c[0] === 'candles' && c[2] === '1'), 'no REST 1-minute candles needed');
    assert.deepEqual(ex.calls.filter(c => c[0] === 'cancel' || c[0] === 'exit').map(c => c[0]), ['cancel', 'exit']);
    assert.match(stmt('SELECT reason FROM auto_trades WHERE id = ?').get(row.id).reason, /Fixed exit at 09:16/);
  } finally { Object.assign(FEED, saved); }
});

test('live ticks missing (feed down): the 09:15:02 decision falls back to the REST quote', async (t) => {
  const D9 = '2026-10-29', at = x => Date.parse(`${D9}T${x}+05:30`);
  stmt('DELETE FROM auto_trades WHERE user_id = ?').run(uid);
  flatBook();
  const saved = { ...FEED };
  FEED.tick = () => null;
  try {
    const dhan = fakeDhan();
    const r = await scanForEntry(acct, { now: at('09:15:02'), adapter: dhan, pause: noPause, instruments });
    if (r.skipped && /Subscription|subscription|market|trading day/i.test(r.skipped)) return t.skip(`gate refused in this environment: ${r.skipped}`);
    assert.equal(r.entered, true, JSON.stringify(r));
    assert.equal(dhan.calls.filter(c => c[0] === 'quotes').length, 1, 'one REST price request');
    assert.equal(JSON.parse(stmt('SELECT detail FROM auto_trades WHERE user_id = ?').get(uid).detail).setup.priceSource, 'REST');
  } finally { Object.assign(FEED, saved); }
});

test('previous close = the previous session\'s last traded price (not NSE\'s official close); a no-trade day is notified', async (t) => {
  const D10 = '2026-10-30', at = x => Date.parse(`${D10}T${x}+05:30`);
  stmt('DELETE FROM auto_trades WHERE user_id = ?').run(uid);
  flatBook();
  // The chain (NSE close) says CE 125: opening at 140 would be a gap up. Its last trade was 145: it opened lower.
  const dhan = fakeDhan({ lastTrade: { G1: 145, P1: 112 } });
  dhan.optionExpiries = async () => ['2026-11-03'];
  const r = await scanForEntry(acct, { now: at('09:15:02'), adapter: dhan, pause: noPause, instruments });
  if (r.skipped && /Subscription|subscription|market|trading day/i.test(r.skipped)) return t.skip(`gate refused in this environment: ${r.skipped}`);
  assert.equal(stmt('SELECT COUNT(*) AS n FROM auto_trades WHERE user_id = ?').get(uid).n, 0, JSON.stringify(r));
  assert.ok(!dhan.calls.some(c => c[0] === 'order'), 'no order');
  const n = stmt("SELECT title, body FROM notifications WHERE user_id = ? AND title LIKE '%no Gap 09:15 trade today%' ORDER BY id DESC").get(uid);
  assert.ok(n, 'no-trade notification sent');
  assert.match(n.body, /CE 145 → open 140/, 'uses the last trade 145, not the NSE close 125');
  assert.match(n.body, /neither premium gapped up/);
  assert.match(n.body, /previous close = last trade/);
});

test('no Gap 09:15 entry → the broker kill switch locks the day (kill switch rule on; not when it is off or another strategy is on)', async (t) => {
  const at = (day, x) => Date.parse(`${day}T${x}+05:30`), today = new Date(Date.now() + 19800e3).toISOString().slice(0, 10);
  const withKill = day => {
    const dhan = fakeDhan(), base = dhan.intradayCandles, last = { G1: 145, P1: 112 };   // neither premium gapped up: no trade
    const t = Date.parse(`${day}T15:29:00+05:30`) / 1000 - 86400;   // their last trade the evening before
    dhan.intradayCandles = async q => (last[q.securityId] ? { timestamp: [t], open: [last[q.securityId]], high: [last[q.securityId]], low: [last[q.securityId]], close: [last[q.securityId]] } : base.call(dhan, q));
    dhan.optionExpiries = async () => ['2026-10-20'];
    Object.assign(dhan, { label: 'Dhan', async getKillSwitch() { return false; }, async snapshot() { return { positions: [], orders: [], funds: { available: 200000 } }; },
      async activateKillSwitch() { dhan.calls.push(['killswitch']); return { message: 'Kill switch activated' }; } });
    return dhan;
  };
  const run = async (dhan, day) => {
    stmt('DELETE FROM auto_trades WHERE user_id = ?').run(uid);
    patchDay(uid, today, { ks_armed: null, ks_active_at: null });
    flatBook();
    const r = await scanForEntry(acct, { now: at(day, '09:15:02'), adapter: dhan, pause: noPause, instruments });
    await new Promise(res => setTimeout(res, 30));   // the lock is not awaited by the scan
    return r;
  };
  const rules = getRules(uid).algo;
  try {
    const dhan = withKill('2026-10-14'), r = await run(dhan, '2026-10-14');
    if (r.skipped && /Subscription|subscription|market|trading day/i.test(r.skipped)) return t.skip(`gate refused in this environment: ${r.skipped}`);
    assert.ok(!dhan.calls.some(c => c[0] === 'order'), 'no trade');
    assert.ok(dhan.calls.some(c => c[0] === 'killswitch'), `kill switch activated (${JSON.stringify(r)})`);
    const s = stmt('SELECT ks_armed, ks_active_at FROM day_state WHERE user_id = ? AND day = ?').get(uid, today);
    assert.equal(s.ks_armed, 'gap:no-entry');
    assert.ok(s.ks_active_at > 0);
    assert.match(stmt("SELECT body FROM notifications WHERE user_id = ? AND title LIKE '%kill switch activated%' ORDER BY id DESC").get(uid).body, /no Gap 09:15 entry today/);

    saveRules(uid, { ...rules, killSwitch: { on: false } }, undefined, null, 'algo');
    const off = withKill('2026-10-13');
    const r2 = await run(off, '2026-10-13');
    assert.ok(off.calls.some(c => c[0] === 'quotes') && !off.calls.some(c => c[0] === 'order'), `decided, no trade (${JSON.stringify(r2)})`);
    assert.ok(!off.calls.some(c => c[0] === 'killswitch'), 'kill switch rule off: no lock');
    saveRules(uid, rules, undefined, null, 'algo');

    const orb = withKill('2026-10-12');
    acct = { ...acct, orb_on: 1 };
    await run(orb, '2026-10-12');
    assert.ok(!orb.calls.some(c => c[0] === 'killswitch'), 'ORB still to trade today: no lock');

    const off2 = withKill('2026-10-09');
    acct = { ...acct, orb_on: 0, gap_lock: 0 };
    await run(off2, '2026-10-09');
    assert.ok(off2.calls.some(c => c[0] === 'quotes') && !off2.calls.some(c => c[0] === 'killswitch'), '"Kill switch if no Gap entry" off: no lock');
  } finally {
    acct = { ...acct, orb_on: 0, gap_lock: 1 };
    saveRules(uid, rules, undefined, null, 'algo');
    patchDay(uid, today, { ks_armed: null, ks_active_at: null });
  }
});

test('a refusal for funds re-sizes from what Dhan blocked per lot (2% spare); other refusals are not retried', async () => {
  const { lotsAfterFundsReject } = await import('../src/modules/scalper/autotrade.js');
  // 27 Oct: 24 lots refused, Rs.2512.04 short of about ₹1.53 lakh.
  const fit = lotsAfterFundsReject('RMS:23226102712022:You have insufficient funds. Please add Rs.2512.04 to trade.', 24, 152_700);
  assert.ok(fit >= 22 && fit < 24, String(fit));
  assert.ok(fit * (152_700 + 2512.04) / 24 <= 152_700, 'the re-sized order fits the funds');
  assert.equal(lotsAfterFundsReject('Market is closed', 24, 152_700), 0);
  assert.equal(lotsAfterFundsReject('You have insufficient funds. Please add Rs.900000 to trade.', 2, 1000), 0, 'not even one lot');
});

test('first tick: decided and bought the moment both ATM options trade after 09:15:00 (no REST quote, no 2-second wait)', async (t) => {
  const D11 = '2026-11-02', open = Date.parse(`${D11}T09:15:00+05:30`);
  stmt('DELETE FROM auto_trades WHERE user_id = ?').run(uid);
  flatBook();
  let clock = open - 300;
  const firstAt = open + 120;   // the options' first trades reach the feed 120 ms after the open
  const ticks = { 'IDX_I:13': { ltp: 23070, dayOpen: 23060, at: open - 60_000 }, 'NSE_FNO:G1': { ltp: 141, dayOpen: 140, volume: 975, at: firstAt }, 'NSE_FNO:P1': { ltp: 95, dayOpen: 95, volume: 650, at: firstAt } };
  const saved = { ...FEED };
  FEED.tick = (u, key, { since = 0 } = {}) => { const k = ticks[key]; return u === uid && k && clock >= k.at && k.at >= since ? k : null; };
  try {
    const dhan = fakeDhan();
    const r = await gapFirstTick(acct, dhan, { key: 'NIFTY', label: 'NIFTY 50', symbol: 'NIFTY', securityId: '13', optionSegment: 'NSE_FNO', exchange: 'NSE' },
      { pause: noPause, instruments }, { clock: () => clock, pause: async ms => { clock += ms; } });
    if (r?.skipped && /Subscription|subscription|market|trading day/i.test(r.skipped)) return t.skip(`gate refused in this environment: ${r.skipped}`);
    assert.equal(r?.entered, true, JSON.stringify(r));
    assert.ok(clock >= firstAt && clock < firstAt + 3 * AUTO.gap.pollMs, `decided within a few ms of the first ticks (${clock - open} ms after 09:15:00)`);
    assert.ok(!dhan.calls.some(c => c[0] === 'quotes' || c[0] === 'quote'), 'no REST price request');
    const buy = dhan.calls.find(c => c[0] === 'order')[1];
    assert.deepEqual([buy.securityId, buy.type, buy.qty, buy.refPrice, buy.marketBand], ['G1', 'MARKET', 1105, 141, 0.15], 'CE 125 → 140 (gap up); market buy of 80% of ₹2,00,000 / (141 × 65) = 17 lots, priced from the first tick');
    const row = stmt('SELECT * FROM auto_trades WHERE user_id = ?').get(uid);
    assert.match(JSON.parse(row.detail).setup.priceSource, /first tick \(1\d\d ms after 09:15:00\)/);
    // The 09:15:02 check does not act again that day.
    const again = await scanForEntry(acct, { now: open + 2_000, adapter: fakeDhan(), pause: noPause, instruments });
    assert.notEqual(again.entered, true);
    assert.equal(stmt('SELECT COUNT(*) AS n FROM auto_trades WHERE user_id = ?').get(uid).n, 1);
  } finally { Object.assign(FEED, saved); }
});

test('first tick: the feed silent → the watcher asks Dhan\'s quotes from 09:15:00.8 and enters from them (no 09:15:02 wait)', async (t) => {
  const D12 = '2026-11-03', open = Date.parse(`${D12}T09:15:00+05:30`);
  stmt('DELETE FROM auto_trades WHERE user_id = ?').run(uid);
  flatBook();
  let clock = open - 300;
  const saved = { ...FEED };
  FEED.tick = () => null;
  try {
    const dhan = fakeDhan();
    const u = { key: 'NIFTY', label: 'NIFTY 50', symbol: 'NIFTY', securityId: '13', optionSegment: 'NSE_FNO', exchange: 'NSE' };
    const r = await gapFirstTick(acct, dhan, u, { pause: noPause, instruments }, { clock: () => clock, pause: async ms => { clock += ms; } });
    if (r?.skipped && /Subscription|subscription|market|trading day/i.test(r.skipped)) return t.skip(`gate refused in this environment: ${r.skipped}`);
    assert.equal(r?.entered, true, JSON.stringify(r));
    assert.ok(clock >= open + AUTO.gap.restAfterMs && clock < open + AUTO.gap.restAfterMs + 50, `decided at 09:15:00.8 (${clock - open} ms), not 09:15:02`);
    assert.equal(dhan.calls.filter(c => c[0] === 'quotes').length, 1, 'one REST quote');
    assert.match(JSON.parse(stmt('SELECT detail FROM auto_trades WHERE user_id = ?').get(uid).detail).setup.priceSource, /^REST quote/);
  } finally { Object.assign(FEED, saved); }
});

test('a rejected gap entry is placed again at once (up to 3 orders), its fill confirmed by polling', async (t) => {
  const D13 = '2026-10-23', at = x => Date.parse(`${D13}T${x}+05:30`);
  stmt('DELETE FROM auto_trades WHERE user_id = ?').run(uid);
  flatBook();
  const dhan = fakeDhan();
  let n = 0;
  dhan.placeOrder = async o => { dhan.calls.push(['order', o]); return { id: o.type === 'STOP_LOSS' ? 'GS1' : `GE${++n}`, status: 'pending' }; };
  dhan.orderStatus = async id => { dhan.calls.push(['status', id]); return id === 'GE1' ? { status: 'failed', reason: 'RMS: order not accepted by the exchange yet' } : id === 'GE2' ? { status: 'filled', price: 150.6 } : { status: 'pending' }; };
  const waits = [];
  const r = await scanForEntry(acct, { now: at('09:15:02'), adapter: dhan, pause: async ms => { waits.push(ms); }, instruments });
  if (r.skipped && /Subscription|subscription|market|trading day/i.test(r.skipped)) return t.skip(`gate refused in this environment: ${r.skipped}`);
  assert.equal(r.entered, true, JSON.stringify(r));
  const buys = dhan.calls.filter(c => c[0] === 'order' && c[1].side === 'BUY');
  assert.equal(buys.length, 2, 'placed again after the rejection');
  assert.ok(waits.includes(AUTO.gap.retryMs), 'a short pause before the second order');
  assert.equal(stmt('SELECT entry_order_id FROM auto_trades WHERE user_id = ?').get(uid).entry_order_id, 'GE2');
});

test('live default ITM2: the side from the ATM gap, the buy two strikes into the money (CE below the ATM)', async (t) => {
  const D14 = '2026-10-16', at = x => Date.parse(`${D14}T${x}+05:30`);
  const chain = { last_price: 23070, oc: { '22950': { ce: { security_id: 'C3' }, pe: { security_id: 'Q3' } }, '23000': { ce: { security_id: 'C2' }, pe: { security_id: 'Q2' } },
    '23050': { ce: { security_id: 'G1', last_price: 125 }, pe: { security_id: 'P1', last_price: 110 } }, '23100': { ce: { security_id: 'G2' }, pe: { security_id: 'Q4' } }, '23150': { ce: { security_id: 'G4' }, pe: { security_id: 'Q5' } } } };
  const atm = { strike: 23050, spot: 23070 };
  assert.equal(strikeFrom(chain, atm, 'CE', 2).securityId, 'C3', 'CE ITM2 = 22950');
  assert.equal(strikeFrom(chain, atm, 'PE', 2).securityId, 'Q5', 'PE ITM2 = 23150');
  assert.equal(strikeFrom(chain, atm, 'CE', -1).securityId, 'G2', 'CE OTM1 = 23100');
  assert.equal(strikeFrom(chain, atm, 'PE', 3), null, 'beyond the chain');
  stmt('DELETE FROM auto_trades WHERE user_id = ?').run(uid);
  flatBook();
  GAP_LIVE.strike = 2;
  const saved = { ...FEED };
  FEED.tick = (u, key) => (key === 'NSE_FNO:C3' ? { ltp: 230, dayOpen: 228, at: at('09:15:00') + 300 } : null);
  try {
    const dhan = fakeDhan();
    dhan.optionChain = async ({ expiry }) => { dhan.calls.push(['chain', expiry]); return chain; };
    const inst = async () => new Map(['G1', 'P1', 'C3', 'Q5'].map(id => [id, { lotSize: 65, tickSize: 0.05 }]));
    const r = await scanForEntry(acct, { now: at('09:15:02'), adapter: dhan, pause: noPause, instruments: inst });
    if (r.skipped && /Subscription|subscription|market|trading day/i.test(r.skipped)) return t.skip(`gate refused in this environment: ${r.skipped}`);
    assert.equal(r.entered, true, JSON.stringify(r));
    const buy = dhan.calls.find(c => c[0] === 'order')[1];
    assert.deepEqual([buy.securityId, buy.type, buy.qty, buy.refPrice], ['C3', 'MARKET', 1040, 150], 'ITM2 22950 CE, priced from the 09:15:02 quote (it covers the strikes near the ATM): 80% of ₹2,00,000 / (150 × 65) = 16 lots');
    assert.equal(stmt('SELECT strike FROM auto_trades WHERE user_id = ?').get(uid).strike, 22950);
  } finally { Object.assign(FEED, saved); GAP_LIVE.strike = 0; }
});

test('ITM2 on the first tick: the decision carries only the ATM ticks, so ITM2 is priced from its own first tick', async (t) => {
  const D15 = '2026-10-15', open = Date.parse(`${D15}T09:15:00+05:30`);
  const chain = { last_price: 23070, oc: { '22950': { ce: { security_id: 'C3' }, pe: { security_id: 'Q3' } }, '23000': { ce: { security_id: 'C2' }, pe: { security_id: 'Q2' } },
    '23050': { ce: { security_id: 'G1', last_price: 125 }, pe: { security_id: 'P1', last_price: 110 } }, '23100': { ce: { security_id: 'G2' }, pe: { security_id: 'Q4' } }, '23150': { ce: { security_id: 'G4' }, pe: { security_id: 'Q5' } } } };
  stmt('DELETE FROM auto_trades WHERE user_id = ?').run(uid);
  flatBook();
  GAP_LIVE.strike = 2;
  let clock = open - 100;
  const ticks = { 'IDX_I:13': { ltp: 23070, dayOpen: 23060, at: open - 60_000 }, 'NSE_FNO:G1': { ltp: 141, dayOpen: 140, volume: 975, at: open + 50 },
    'NSE_FNO:P1': { ltp: 95, dayOpen: 95, volume: 650, at: open + 50 }, 'NSE_FNO:C3': { ltp: 230, dayOpen: 228, volume: 130, at: open + 50 } };
  const saved = { ...FEED };
  FEED.tick = (u, key, { since = 0 } = {}) => { const k = ticks[key]; return u === uid && k && clock >= k.at && k.at >= since ? k : null; };
  try {
    const dhan = fakeDhan();
    dhan.optionChain = async ({ expiry }) => { dhan.calls.push(['chain', expiry]); return chain; };
    const inst = async () => new Map(['G1', 'P1', 'C3', 'Q5'].map(id => [id, { lotSize: 65, tickSize: 0.05 }]));
    const r = await gapFirstTick(acct, dhan, { key: 'NIFTY', label: 'NIFTY 50', symbol: 'NIFTY', securityId: '13', optionSegment: 'NSE_FNO', exchange: 'NSE' },
      { pause: noPause, instruments: inst }, { clock: () => clock, pause: async ms => { clock += ms; } });
    if (r?.skipped && /Subscription|subscription|market|trading day/i.test(r.skipped)) return t.skip(`gate refused in this environment: ${r.skipped}`);
    assert.equal(r?.entered, true, JSON.stringify(r));
    const buy = dhan.calls.find(c => c[0] === 'order')[1];
    assert.deepEqual([buy.securityId, buy.qty, buy.refPrice], ['C3', 650, 230], 'ITM2 at its own tick 230: 80% of ₹2,00,000 / (230 × 65) = 10 lots');
    assert.ok(!dhan.calls.some(c => c[0] === 'quote' || c[0] === 'quotes'), 'no REST price request');
  } finally { Object.assign(FEED, saved); GAP_LIVE.strike = 0; }
});

test('Algo page history: earlier days only, newest first, with P&L and % when the trade has an entry and an exit', async () => {
  const { autoTradeHistory } = await import('../src/modules/scalper/autotrade.js');
  stmt('DELETE FROM auto_trades WHERE user_id = ?').run(uid);
  const add = (day, key, status, entry, exit, qty) => stmt(`INSERT INTO auto_trades (user_id, day, signal_key, direction, status, symbol, lots, qty, entry_price, exit_price, created_at)
    VALUES (?, ?, ?, 'CE', ?, 'NIFTY X', ?, ?, ?, ?, ?)`).run(uid, day, key, status, qty / 65, qty, entry, exit, Date.parse(`${day}T09:15:01+05:30`));
  add('2026-11-02', 'a', 'closed', 156.5, 217.05, 65);
  add('2026-11-03', 'b', 'closed', 88.2, 101.03, 195);
  add('2026-11-04', 'c', 'skipped', null, null, 2535);
  add('2026-11-05', 'd', 'open', 200, null, 65);
  const h = autoTradeHistory(uid, '2026-11-05');
  assert.deepEqual(h.map(t => t.day), ['2026-11-04', '2026-11-03', '2026-11-02'], 'today is in Today, not in History');
  assert.deepEqual([h[2].pnl, h[2].pnlPct], [3935.75, 38.69]);
  assert.deepEqual([h[0].pnl, h[0].pnlPct], [null, null], 'no entry: no P&L');
  stmt('DELETE FROM auto_trades WHERE user_id = ?').run(uid);
});
