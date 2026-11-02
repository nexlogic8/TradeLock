// Pre-open readiness for Gap 09:15: the 08:55 check (a notification with what 09:15 will do, or what stops it) and the
// 09:13 route (a trading broker that does not answer is replaced by the other one, Dhan <-> linked StoxKart, with the
// Algo Trading switches in use carried over). The broker calls are stood in for through PREOPEN_IO.
process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
const { test, before, after, beforeEach } = await import('node:test');
const { createServer } = await import('node:http');
const { createHandler } = await import('../src/lib/app.js');
const { buildRouter } = await import('../src/modules/index.js');
const assert = (await import('node:assert/strict')).default;
const { stmt } = await import('../src/db/index.js');
const { setBook } = await import('../src/modules/broker/book.js');
const { upsertAccount } = await import('../src/modules/broker/registry.js');
const { saveRules, getRules } = await import('../src/modules/rules/service.js');
const { switchTradeVia } = await import('../src/modules/broker/switch.js');
const { preopenCheck, preopenRoute, PREOPEN_IO, AUTO } = await import('../src/modules/scalper/autotrade.js');

let uid, server;
const saved = { ...PREOPEN_IO };
const row = () => stmt('SELECT * FROM broker_accounts WHERE user_id = ?').get(uid);
const notes = () => stmt('SELECT title, body, level FROM notifications WHERE user_id = ? ORDER BY id').all(uid);
// The trading broker's sync: answers (connected, with funds) or not (degraded, the book left as it was).
const syncs = answers => async acct => {
  const ok = answers(acct);
  stmt('UPDATE broker_accounts SET status = ?, last_error = ? WHERE id = ?').run(ok ? 'connected' : 'degraded', ok ? null : 'Dhan DH-905: Input exception', acct.id);
  if (ok) setBook(uid, { positions: [], orders: [], funds: { available: 150000, used: 0 }, at: Date.now() });
};
const otherAnswers = (funds = 120000) => () => ({ snapshot: async () => ({ positions: [], orders: [], funds: { available: funds, used: 0 } }) });
const otherFails = () => () => ({ snapshot: async () => { throw new Error('StoxKart: session refused'); } });

before(async () => {
  server = createServer(createHandler(buildRouter()));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  await fetch(`http://127.0.0.1:${server.address().port}/api/auth/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'preopen@example.com', password: 'longpassword' }) });
  uid = stmt('SELECT id FROM users WHERE email = ?').get('preopen@example.com').id;
  const active = getRules(uid).active;
  saveRules(uid, { ...active, cutoff: { ...active.cutoff, on: false } }, undefined, null, 'algo');   // the Algo Trading rule set
  upsertAccount(uid, { broker: 'dhan', clientId: 'C778', accessToken: 'test-token-not-real-0123456789' });
});
after(() => { Object.assign(PREOPEN_IO, saved); server.close(); });
beforeEach(() => {
  Object.assign(PREOPEN_IO, saved);
  stmt('DELETE FROM notifications WHERE user_id = ?').run(uid);
  stmt('DELETE FROM auto_trades WHERE user_id = ?').run(uid);
  stmt('DELETE FROM broker_stash WHERE user_id = ?').run(uid);
  stmt(`UPDATE broker_accounts SET agent_on = 1, algo_on = 1, gap_on = 1, cross_on = 1, orb_on = 0, trade_via = 'own', status = 'connected', last_error = NULL WHERE user_id = ?`).run(uid);
});

test('08:55, all well: "Ready for 09:15" with the strike, the funds and the exit', async () => {
  PREOPEN_IO.sync = syncs(() => true);
  const r = await preopenCheck(row());
  assert.equal(r.ok, true, JSON.stringify(r));
  const [n] = notes();
  assert.equal(n.title, 'Ready for 09:15 via Dhan');
  assert.match(n.body, /ITM2 of the nearest expiry on the first tick, 80% of the ₹150000 available/);
  assert.match(n.body, new RegExp(`exit at ${AUTO.gap.exitAt}`));
});

test('08:55: Algo Trading off, and Dhan not answering while StoxKart does: both said, with the 09:13 switch', async () => {
  stmt('UPDATE broker_accounts SET algo_on = 0 WHERE user_id = ?').run(uid);
  PREOPEN_IO.sync = syncs(() => false);
  PREOPEN_IO.probe = otherAnswers();
  const r = await preopenCheck(row());
  assert.equal(r.ok, false);
  const [n] = notes();
  assert.equal(n.title, 'Before 09:15: Gap 09:15 is not ready');
  assert.match(n.body, /Algo Trading is off for Dhan/);
  assert.match(n.body, /Dhan is not answering \(degraded: Dhan DH-905/);
  assert.match(n.body, /StoxKart answers \(₹120000 available\): if Dhan has not recovered by 09:13, Algo Trading switches to StoxKart/);
});

test('09:13: Dhan answers on the retry: nothing switched, nothing said', async () => {
  let n = 0;
  PREOPEN_IO.sync = syncs(() => ++n > 1);
  PREOPEN_IO.probe = () => assert.fail('the other broker is not needed');
  const r = await preopenRoute(row(), { pause: async () => {} });
  assert.deepEqual(r, { ok: true });
  assert.equal(row().trade_via, 'own');
  assert.equal(notes().length, 0);
});

test('09:13: Dhan still not answering, StoxKart answers: switched to StoxKart with the same switches, and said', async () => {
  // StoxKart's own parked switches are all off: the fallback must not bring those back.
  stmt(`INSERT INTO broker_stash (user_id, broker, kind, data, saved_at) VALUES (?, 'stoxkart', 'flags', ?, ?)`)
    .run(uid, JSON.stringify({ agent_on: 0, algo_on: 0, cross_on: 0, orb_on: 0, gap_on: 0, manual_on: 0, algo_underlying: 'NIFTY' }), Date.now());
  PREOPEN_IO.sync = syncs(acct => acct.trade_via === 'stoxkart');
  PREOPEN_IO.probe = otherAnswers();
  PREOPEN_IO.switchVia = (acct, on, o) => switchTradeVia(acct, on, { ...o, sync: PREOPEN_IO.sync });
  const r = await preopenRoute(row(), { pause: async () => {} });
  assert.deepEqual(r, { switched: 'stoxkart', status: 'connected' });
  const a = row();
  assert.deepEqual([a.trade_via, a.agent_on, a.algo_on, a.gap_on, a.cross_on], ['stoxkart', 1, 1, 1, 1], 'trading through StoxKart, Algo Trading still on');
  const [n] = notes();
  assert.equal(n.title, 'Algo Trading switched to StoxKart for 09:15');
  assert.match(n.body, /Dhan did not answer before the open \(degraded: Dhan DH-905.*StoxKart did, with ₹120000 available/);
  const stash = JSON.parse(stmt(`SELECT data FROM broker_stash WHERE user_id = ? AND broker = 'dhan' AND kind = 'flags'`).get(uid).data);
  assert.equal(stash.algo_on, 1, "Dhan's switches parked as they were");
});

test('09:13: neither broker answers, or something is open: not switched, a critical notification', async () => {
  PREOPEN_IO.sync = syncs(() => false);
  PREOPEN_IO.probe = otherFails();
  const r = await preopenRoute(row(), { pause: async () => {} });
  assert.ok(r.failed);
  assert.equal(row().trade_via, 'own');
  let [n] = notes();
  assert.equal(n.title, 'Gap 09:15 may not trade today: Dhan is not answering');
  assert.match(n.body, /StoxKart cannot take over: StoxKart: session refused\. Reconnect Dhan now\./);

  stmt('DELETE FROM notifications WHERE user_id = ?').run(uid);
  PREOPEN_IO.probe = otherAnswers();
  setBook(uid, { positions: [{ securityId: 'X1', qty: 65 }], orders: [], funds: { available: 1000, used: 0 }, at: Date.now() - 600_000 });
  const busy = await preopenRoute(row(), { pause: async () => {} });
  assert.ok(busy.failed);
  assert.equal(row().trade_via, 'own', 'never switched with a position open');
  [n] = notes();
  assert.match(n.body, /Not switched to StoxKart: 1 open position open/);
});

test('09:13: Gap 09:15 or Algo Trading off: no check at all', async () => {
  stmt('UPDATE broker_accounts SET gap_on = 0 WHERE user_id = ?').run(uid);
  PREOPEN_IO.sync = () => assert.fail('no sync');
  assert.deepEqual(await preopenRoute(row()), { skipped: 'gap off' });
});
