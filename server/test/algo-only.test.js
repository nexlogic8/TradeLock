process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { manualExcess } = await import('../src/modules/scalper/autotrade.js');
const { checkOrder } = await import('../src/modules/risk/gate.js');
const { DEFAULT_RULES } = await import('../src/modules/rules/service.js');

const pos = (securityId, qty, extra = {}) => ({ symbol: `OPT${securityId}`, securityId, exchangeSegment: 'NSE_FNO', productType: 'INTRADAY', qty, ...extra });
const auto = (security_id, qty) => ({ security_id, qty, status: 'open' });

test('a manual option position opened today is closed in full', () => {
  assert.deepEqual(manualExcess([pos('51348', 65)], []).map(p => [p.securityId, p.qty]), [['51348', 65]]);
  assert.deepEqual(manualExcess([pos('51349', -130)], []).map(p => p.qty), [-130], 'a short sold by hand is bought back');
});

test('the automatic trade is never touched; only quantity added on top of it is closed', () => {
  assert.deepEqual(manualExcess([pos('51348', 65)], [auto('51348', 65)]), []);
  assert.deepEqual(manualExcess([pos('51348', 195)], [auto('51348', 65)]).map(p => p.qty), [130]);
  assert.deepEqual(manualExcess([pos('51348', 65), pos('51349', 75)], [auto('51348', 65)]).map(p => p.securityId), ['51349']);
});

test('carried positions, flat rows and non-F&O are left alone', () => {
  assert.deepEqual(manualExcess([pos('1', 65, { carryQty: 65 })], []), [], 'carried in from yesterday');
  assert.deepEqual(manualExcess([pos('1', 0, { realized: -500 })], []), []);
  assert.deepEqual(manualExcess([pos('2885', 10, { exchangeSegment: 'NSE_EQ', productType: 'CNC' })], []), [], 'shares are not option trades');
  // carried 65 long, then 130 sold today: net -65 short. Close what is open (65), never more.
  assert.deepEqual(manualExcess([pos('1', -65, { carryQty: 65 })], []).map(p => p.qty), [-65]);
});

test('with Algo Trading on, TradeLock refuses manual entries but still allows exits', () => {
  const base = { rules: DEFAULT_RULES, positions: [pos('51348', 65)], orders: [], entries: 0, pnl: 0, minutes: 600, capital: 300000, subscriptionActive: true, algoOnly: true };
  const entry = checkOrder({ symbol: 'OPT51349', side: 'BUY', qty: 65 }, base);
  assert.equal(entry.ok, false); assert.equal(entry.code, 'ALGO_ONLY');
  const exit = checkOrder({ symbol: 'OPT51348', side: 'SELL', qty: 65 }, base);
  assert.deepEqual([exit.ok, exit.reducing], [true, true]);
  assert.equal(checkOrder({ symbol: 'OPT51349', side: 'BUY', qty: 65 }, { ...base, positions: [], algoOnly: false }).ok, true, 'Algo Trading off: manual entries as before');
});

test('manual trades allowed: the guard never closes a manual position', async () => {
  const { closeManualEntries } = await import('../src/modules/scalper/autotrade.js');
  let exits = 0;
  const adapter = { exitPosition: async () => { exits++; return { id: 'X' }; } };
  assert.deepEqual(await closeManualEntries({ user_id: 987654, algo_on: 1, agent_on: 1, manual_on: 1 }, { adapter }), []);
  assert.equal(exits, 0);
});
