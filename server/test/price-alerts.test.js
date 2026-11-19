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

test('an index alert can carry an order: the CE / PE shown is bought at market once when the index reaches the level', async () => {
  const { stmt } = await import('../src/db/index.js');
  const uid = createUser({ email: 'index-order@alerts.test', password: null, name: 'I' });
  const placed = [], realPlace = al.ALERT_ORDER.place;
  al.ALERT_ORDER.place = async (u, body) => { placed.push({ u, body }); return { order: { id: 'X1' } }; };
  try {
    const order = { securityId: '51334', segment: 'NSE_FNO', symbol: 'NIFTY 2026-11-24 25400 CE', side: 'BUY', qty: 325, lots: 5, leg: 'ce' };
    const a = al.createAlert(uid, { segment: 'IDX_I', securityId: '13', symbol: 'NIFTY 50', price: 25450, ltp: 25400, order });
    assert.equal(a.dir, 'above');
    assert.deepEqual(a.order, order, 'kept with the alert');
    assert.equal(al.checkAlerts(uid, 'IDX_I:13', 25440).length, 0, 'below the level: nothing');
    assert.equal(al.checkAlerts(uid, 'IDX_I:13', 25451).length, 1, 'the index reached it');
    await new Promise(r => setTimeout(r, 20));
    assert.equal(placed.length, 1);
    assert.deepEqual(placed[0].body, { symbol: order.symbol, securityId: '51334', exchangeSegment: 'NSE_FNO', side: 'BUY', qty: 325, type: 'MARKET', productType: 'INTRADAY' });
    assert.equal(al.checkAlerts(uid, 'IDX_I:13', 25460).length, 0, 'fires once');
    // Refused by the gate: reported, not retried.
    al.ALERT_ORDER.place = async () => { throw new Error('Your Paper kill switch is on'); };
    assert.deepEqual(await al.placeFromAlert(uid, { ...a, triggeredPrice: 25451 }), { placed: false, reason: 'Your Paper kill switch is on' });
    // An order alert set yesterday never buys today.
    const old = al.createAlert(uid, { segment: 'IDX_I', securityId: '13', symbol: 'NIFTY 50', price: 25500, ltp: 25400, order });
    stmt('UPDATE price_alerts SET created_at = ? WHERE id = ?').run(Date.now() - 2 * 86_400_000, old.id);
    assert.ok(!al.activeAlerts(uid).some(x => x.id === old.id), 'dropped from the list');
    assert.equal(al.checkAlerts(uid, 'IDX_I:13', 25600).length, 0, 'and never fires');
  } finally { al.ALERT_ORDER.place = realPlace; }
});
