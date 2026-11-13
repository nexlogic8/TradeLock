// Kill switch scope 'indian' (13 Nov 2026): the kill switch locks NSE / BSE only; commodity (MCX) stays open. Dhan's own
// switch (whole account) is not used: TradeLock cancels NSE / BSE orders and closes NSE / BSE positions while it is on.
process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { createUser } = await import('../src/modules/auth/service.js');
const { dayState, patchDay } = await import('../src/modules/risk/service.js');
const { ist } = await import('../src/lib/time.js');
const { tryKillSwitch, enforceMarketLock, isCommodity, KILL_SCOPE } = await import('../src/modules/emergency/service.js');

const fake = ({ positions = [], orders = [] } = {}) => {
  const calls = [];
  return { calls, label: 'Dhan', async getKillSwitch() { return false; }, async snapshot() { return { positions, orders, funds: { available: 1e5 } }; },
    async activateKillSwitch() { calls.push(['dhan-killswitch']); return {}; }, async cancelOrder(id) { calls.push(['cancel', id]); return {}; },
    async exitPosition(p) { calls.push(['exit', p.symbol]); return { id: 'X' }; } };
};
const nse = { symbol: 'NIFTY 25000 CE', securityId: '1', exchangeSegment: 'NSE_FNO', qty: 65 };
const mcx = { symbol: 'CRUDEOIL FUT', securityId: '9', exchangeSegment: 'MCX_COMM', qty: 100 };

test('segments: MCX / NCDEX are commodity, NSE / BSE (and unknown) are locked', () => {
  assert.equal(KILL_SCOPE.mode, 'indian');
  assert.deepEqual(['MCX_COMM', 'NSE_FNO', 'BSE_FNO', 'NSE_EQ', undefined].map(isCommodity), [true, false, false, false, false]);
});

test('an MCX position does not hold the lock back; MCX orders are not cancelled; Dhan’s switch stays off', async () => {
  const uid = createUser({ email: 'lock1@test.in', password: null, name: 'Lock' });
  const a = fake({ positions: [mcx], orders: [{ id: 'm1', symbol: 'GOLD', exchangeSegment: 'MCX_COMM' }, { id: 'n1', symbol: 'NIFTY', exchangeSegment: 'NSE_FNO' }] });
  const r = await tryKillSwitch(uid, null, 'rule:maxLoss', a);
  assert.equal(r.status, 'active', r.text);
  assert.deepEqual(a.calls, [['cancel', 'n1']], 'only the NSE order cancelled; no Dhan kill switch');
  assert.ok(dayState(uid).ks_active_at > 0);
});

test('an NSE position arms it (locks once NSE / BSE is flat)', async () => {
  const uid = createUser({ email: 'lock2@test.in', password: null, name: 'Lock' });
  const r = await tryKillSwitch(uid, null, 'rule:cutoff', fake({ positions: [nse, mcx] }));
  assert.equal(r.status, 'armed');
  assert.equal(dayState(uid).ks_active_at, null);
});

test('while locked: a new NSE position (e.g. from the Dhan app) is closed at market; MCX is left alone', async () => {
  const uid = createUser({ email: 'lock3@test.in', password: null, name: 'Lock' });
  patchDay(uid, ist().day, { ks_armed: 'rule:maxLoss', ks_active_at: Date.now() });
  const a = fake();
  const done = await enforceMarketLock(uid, a, { positions: [nse, mcx], orders: [{ id: 'n2', symbol: 'BANKNIFTY', exchangeSegment: 'NSE_FNO' }] }, dayState(uid));
  assert.deepEqual(a.calls, [['cancel', 'n2'], ['exit', 'NIFTY 25000 CE']]);
  assert.equal(done.length, 2);
  // Not sent again within the retry window (the exit order is on its way).
  assert.deepEqual(await enforceMarketLock(uid, a, { positions: [nse], orders: [] }, dayState(uid)), []);
  // A lock the broker holds itself: nothing to enforce.
  const b = fake();
  assert.deepEqual(await enforceMarketLock(uid, b, { positions: [{ ...nse, securityId: '2' }], orders: [] }, { ...dayState(uid), ks_armed: 'broker' }), []);
});
