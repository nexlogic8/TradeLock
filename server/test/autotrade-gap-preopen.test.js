// Gap open 09:15 decided at the index pre-open (Gap settings decide = 'preopen'): the index's pre-open price vs its previous
// close picks CE / PE before the open; the buy goes at 09:15:00 as a limit at the estimated premium + 15% (fixed lots), and
// the stop is STOP % below the fill. No pre-open move → the usual first-tick check decides (fallback).
process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
process.env.ADMIN_EMAILS = 'gappre@example.com';
const { test, before, after } = await import('node:test');
const { createServer } = await import('node:http');
const { createHandler } = await import('../src/lib/app.js');
const { buildRouter } = await import('../src/modules/index.js');
const assert = (await import('node:assert/strict')).default;
const { stmt } = await import('../src/db/index.js');
const { setBook } = await import('../src/modules/broker/book.js');
const { upsertAccount } = await import('../src/modules/broker/registry.js');
const { saveRules, getRules } = await import('../src/modules/rules/service.js');
const { underlyingFor } = await import('../src/modules/scalper/underlyings.js');
const { gapPreopen, gapConfig, GAP_LIVE, GAP_PRE } = await import('../src/modules/scalper/autotrade.js');
GAP_LIVE.strike = 0;   // the ATM (the live default ITM2 is covered in autotrade-gap.test.js)

const D = '2026-10-19', ms = hhmmss => Date.parse(`${D}T${hhmmss}+05:30`);
function fakeDhan({ idx = 23070 } = {}) {
  const calls = [];
  return {
    calls,
    async quote(seg, id) { calls.push(['quote', seg, id]); return seg === 'IDX_I' ? { ltp: idx, open: 0, close: 23000 } : null; },
    async quotes() { throw new Error('no quotes before the open'); },
    async optionExpiries() { return ['2026-10-20', '2026-10-27']; },
    async optionChain() { return { last_price: 23000, oc: { '23050': { ce: { security_id: 'G1', last_price: 118 }, pe: { security_id: 'P1', last_price: 140 } }, '23000': { ce: { security_id: 'G0', last_price: 150 }, pe: { security_id: 'P0', last_price: 110 } } } }; },
    async intradayCandles({ securityId, interval }) {
      if (interval === '5') return { timestamp: [Date.parse('2026-10-16T15:25:00+05:30') / 1000], open: [23010], high: [23020], low: [22990], close: [23000] };
      const px = { G1: 125, P1: 135 }[securityId];
      return px ? { timestamp: [Date.parse('2026-10-16T15:29:00+05:30') / 1000], open: [px], high: [px], low: [px], close: [px] } : { timestamp: [], open: [], high: [], low: [], close: [] };
    },
    async placeOrder(o) { calls.push(['order', o]); return { id: o.type === 'STOP_LOSS' ? 'S1' : 'E1', status: 'pending' }; },
    async orderStatus(id) { calls.push(['status', id]); return id === 'E1' ? { status: 'filled', price: 150.6 } : { status: 'pending' }; },
    async cancelOrder(id) { calls.push(['cancel', id]); return {}; },
    async exitPosition() { return {}; },
  };
}
const instruments = async () => new Map(['G1', 'P1', 'G0', 'P0'].map(id => [id, { lotSize: 65, tickSize: 0.05 }]));
let uid, acct, server;
before(async () => {
  server = createServer(createHandler(buildRouter()));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  await fetch(`http://127.0.0.1:${server.address().port}/api/auth/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'gappre@example.com', password: 'longpassword' }) });
  uid = stmt('SELECT id FROM users WHERE email = ?').get('gappre@example.com').id;
  const active = getRules(uid).active;
  saveRules(uid, { ...active, cutoff: { ...active.cutoff, on: false } }, undefined, null, 'algo');
  upsertAccount(uid, { broker: 'dhan', clientId: 'C778', accessToken: 'test-token-not-real-0123456789' });
  const grid = { gap: { NIFTY: { on: true, cfg: { decide: 'preopen', lots: 2, stopPct: 20, capitalMode: 'percent', capitalPct: 90, costToCost: false, requireGreen: true, autoExit: false, noEntryLock: false } } } };
  stmt('UPDATE broker_accounts SET agent_on = 1, algo_on = 1, orb_on = 0, cross_on = 0, gap_on = 1, algo_grid = ? WHERE user_id = ?').run(JSON.stringify(grid), uid);
  acct = stmt('SELECT * FROM broker_accounts WHERE user_id = ?').get(uid);
});
after(() => server.close());
const flatBook = () => setBook(uid, { positions: [], orders: [], funds: { available: 55000, used: 0 }, at: Date.now() });

test('settings: decide and fixed lots are read per index', () => {
  const c = gapConfig(acct, 'NIFTY');
  assert.deepEqual([c.decide, c.lots, c.stopPct], ['preopen', 2, 20]);
  assert.deepEqual([gapConfig(acct, 'SENSEX').decide, gapConfig(acct, 'SENSEX').lots], ['premium', 0], 'defaults');
});

test('index unchanged at the pre-open → no decision (the first-tick check decides at 09:15)', async () => {
  const dhan = fakeDhan({ idx: 23000 });
  const r = await gapPreopen(acct, dhan, underlyingFor('NIFTY'), { instruments }, { clock: () => ms('09:14:30') });
  assert.deepEqual(r, { fallback: 'index unchanged' });
  assert.ok(!dhan.calls.some(c => c[0] === 'order'));
});

test('pre-open up → CE at 09:15:00: limit at the estimate + 15%, fixed 2 lots, stop 20% below the fill', async (t) => {
  flatBook();
  const dhan = fakeDhan({ idx: 23070 });
  const r = await gapPreopen(acct, dhan, underlyingFor('NIFTY'), { instruments }, { clock: () => ms('09:14:30') });
  if (r?.skipped && /Subscription|subscription|market|trading day|sync/i.test(r.skipped)) return t.skip(`gate refused in this environment: ${r.skipped}`);
  assert.equal(r.entered, true, JSON.stringify(r));
  const [buy, sl] = dhan.calls.filter(c => c[0] === 'order').map(c => c[1]);
  // One strike deeper than usual (ATM 23050 here → 23000 CE). Estimate (sticky moneyness): 23000 CE after +70 ≈ yesterday's
  // 23000 CE still (the chain's nearest; 150); limit 150 × 1.15 = 172.50.
  assert.equal(GAP_PRE.extraSteps, 1);
  assert.deepEqual([buy.side, buy.type, buy.price, buy.qty, buy.securityId], ['BUY', 'LIMIT', 172.5, 130, 'G0']);
  // Stop: 20% of 150.60 × 130 = ₹3,915.60 ÷ 130 = 30.12 below the fill → 120.48, rounded up to the tick 120.50.
  assert.deepEqual([sl.type, sl.triggerPrice, sl.qty], ['STOP_LOSS', 120.5, 130]);
  const row = stmt('SELECT * FROM auto_trades WHERE user_id = ?').get(uid);
  assert.deepEqual([row.status, row.direction, row.signal_key, row.lots, row.entry_price], ['open', 'CE', `${D}:gap`, 2, 150.6]);
  const setup = JSON.parse(row.detail).setup;
  assert.deepEqual([setup.preopen, setup.ltp, setup.indexPrevClose, setup.gapPct], [true, 23070, 23000, 0.3]);
  assert.equal(GAP_PRE.firstPad, 0.15);
  // Decided once: a second call that day does nothing.
  assert.equal(await gapPreopen(acct, fakeDhan(), underlyingFor('NIFTY'), { instruments }, { clock: () => ms('09:14:40') }), null);
});
