// Price alerts from the Power Scalper chart (server/src/modules/alerts): direction, firing once, the Android app's list.
process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { createUser } = await import('../src/modules/auth/service.js');
const al = await import('../src/modules/alerts/service.js');
const { toTick } = await import('../../web/js/pages/scalper-chart-levels.js');

test('an alert above the price rings on the way up, one below on the way down; each fires once', () => {
  const uid = createUser({ email: 'al@test', password: null, name: 'A' });
  const key = 'MCX_COMM:4410';
  const up = al.createAlert(uid, { segment: 'MCX_COMM', securityId: '4410', symbol: 'CRUDEOILM 17 NOV 8300 CE', price: 190, ltp: 180 });
  const down = al.createAlert(uid, { segment: 'MCX_COMM', securityId: '4410', symbol: 'CRUDEOILM 17 NOV 8300 CE', price: 170, ltp: 180 });
  assert.deepEqual([up.dir, down.dir], ['above', 'below']);
  assert.deepEqual([...al.alertKeys(uid)], [key], 'the feed follows the contract');
  assert.equal(al.checkAlerts(uid, key, 185).length, 0, 'between the two: nothing');
  assert.equal(al.checkAlerts(uid, 'MCX_COMM:9999', 999).length, 0, 'another contract: nothing');
  const fired = al.checkAlerts(uid, key, 190.5);
  assert.deepEqual(fired.map(a => [a.id, a.triggeredPrice]), [[up.id, 190.5]]);
  assert.equal(al.checkAlerts(uid, key, 191).length, 0, 'fired once only');
  assert.deepEqual(al.checkAlerts(uid, key, 169.9).map(a => a.id), [down.id]);
  assert.equal(al.activeAlerts(uid).length, 0);
  // The Android app: alerts fired after the last one it rang for.
  assert.deepEqual(al.firedAlertsAfter(uid, 0).map(a => a.id), [up.id, down.id]);
  assert.deepEqual(al.firedAlertsAfter(uid, up.id).map(a => a.id), [down.id]);
  assert.equal(al.lastAlertId(uid), down.id);
});

test('moving an alert re-reads its side from the current price; removing it stops it', () => {
  const uid = createUser({ email: 'al2@test', password: null, name: 'B' });
  const a = al.createAlert(uid, { segment: 'NSE_FNO', securityId: '51', symbol: 'NIFTY 23000 CE', price: 120, ltp: 100 });
  const moved = al.moveAlert(uid, a.id, { price: 90, ltp: 100 });
  assert.deepEqual([moved.price, moved.dir], [90, 'below']);
  assert.equal(al.checkAlerts(uid, 'NSE_FNO:51', 121).length, 0, 'the old level no longer rings');
  al.deleteAlert(uid, a.id);
  assert.equal(al.checkAlerts(uid, 'NSE_FNO:51', 80).length, 0);
  assert.throws(() => al.createAlert(uid, { segment: 'NSE_FNO', securityId: '51', symbol: 'X', price: 0, ltp: 100 }), /price/);
});

test('chart: the menu price snaps to the tick', () => {
  assert.deepEqual([toTick(2843.07), toTick(180.024), toTick(136788.4, 1)], [2843.05, 180, 136788]);
});
