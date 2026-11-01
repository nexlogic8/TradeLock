// End-to-end over HTTP against an in-memory database and the demo broker.
process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
const { test, before, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { createServer } = await import('node:http');
const { createHandler } = await import('../src/lib/app.js');
const { buildRouter } = await import('../src/modules/index.js');
const { syncAccount } = await import('../src/modules/risk/monitor.js');
const { accountFor } = await import('../src/modules/broker/registry.js');

let server, base, cookie = '';

// Cookie jar like a browser: every Set-Cookie is kept by name; an emptied cookie is removed.
const mergeCookies = (prev, list) => {
  const jar = new Map((prev || '').split('; ').filter(Boolean).map(c => [c.split('=')[0], c]));
  for (const s of list) { const kv = s.split(';')[0]; const k = kv.split('=')[0]; if (kv.endsWith('=')) jar.delete(k); else jar.set(k, kv); }
  return [...jar.values()].join('; ');
};
async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body && { 'Content-Type': 'application/json' }), ...(cookie && { Cookie: cookie }) },
    body: body && JSON.stringify(body),
  });
  cookie = mergeCookies(cookie, res.headers.getSetCookie());
  return { status: res.status, body: await res.json().catch(() => null) };
}

before(async () => {
  server = createServer(createHandler(buildRouter()));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('protected routes require a session', async () => {
  assert.equal((await call('GET', '/api/dashboard')).status, 401);
});


/** Cancel pending orders and exit open positions (one trade at a time needs a flat book). */
async function flatten(sync) {
  const d = (await call('GET', '/api/dashboard')).body;
  for (const o of d.orders) await call('DELETE', `/api/orders/${o.id}`);
  for (const p of d.positions.filter(p => p.qty !== 0)) {
    const r = await call('POST', '/api/orders', { symbol: p.symbol, side: p.qty > 0 ? 'SELL' : 'BUY', qty: Math.abs(p.qty) });
    assert.equal(r.status, 201, `exit of ${p.symbol}`);
  }
  await sync();
}

test('signup, connect demo broker, trade until the cap blocks', async () => {
  const signup = await call('POST', '/api/auth/signup', { email: 'trader@example.com', password: 'longpassword', name: 'Test Trader' });
  assert.equal(signup.status, 201);
  assert.equal(signup.body.user.subscription.status, 'trial');

  const dup = await call('POST', '/api/auth/signup', { email: 'TRADER@example.com', password: 'longpassword' });
  assert.equal(dup.body.code, 'EMAIL_TAKEN');

  const conn = await call('POST', '/api/brokers/connect', { broker: 'mock' });
  assert.equal(conn.status, 200);
  assert.ok(conn.body.checks.every(c => c.ok));

  const dash = await call('GET', '/api/dashboard');
  assert.equal(dash.body.entries, 2, 'demo morning has two entries');
  assert.equal(dash.body.realized, 3480);

  // One trade at a time: a new entry is refused while the demo position is open.
  const busy = await call('POST', '/api/orders', { symbol: 'NIFTY 25100 CE', side: 'BUY', qty: 75 });
  assert.equal(busy.status, 403);
  assert.equal(busy.body.extra.rule, 'TRADE_RUNNING');
  await flatten(() => syncAccount(accountFor(signup.body.user.id), { force: true }));
  const third = await call('POST', '/api/orders', { symbol: 'NIFTY 25100 CE', side: 'BUY', qty: 75 });
  assert.equal(third.status, 201);
  await syncAccount(accountFor(signup.body.user.id));

  const fourth = await call('POST', '/api/orders', { symbol: 'NIFTY 25200 CE', side: 'BUY', qty: 75 });
  assert.equal(fourth.status, 403);
  assert.equal(fourth.body.code, 'ORDER_BLOCKED');

  const exit = await call('POST', '/api/orders', { symbol: 'NIFTY 25100 CE', side: 'SELL', qty: 75 });
  assert.equal(exit.status, 201, 'exits pass even when entries are blocked');
  assert.equal(exit.body.reducing, true);

  const notes = await call('GET', '/api/notifications');
  assert.ok(notes.body.items.some(n => n.title === 'Trade cap reached'));
});

test('Power Scalper market data is restricted to a connected Dhan account', async () => {
  const res = await call('GET', '/api/scalper');
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'DHAN_REQUIRED');
});

test('rules validate and save', async () => {
  const { body } = await call('GET', '/api/rules');
  const rules = { ...body.active, maxLoss: { ...body.active.maxLoss, mode: 'amount', value: 3000 } };
  const saved = await call('PUT', '/api/rules', { rules });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.active.maxLoss.value, 3000, 'tightening applies immediately');
  assert.equal(body.active.maxLoss.mode, 'percent', 'new accounts default to % of capital');
  assert.equal(body.capital, 250000, 'demo broker opening balance is the starting capital');
  const bad = await call('PUT', '/api/rules', { rules: { ...rules, maxTrades: { on: true, value: -1, action: 'pause' } } });
  assert.equal(bad.status, 400);
});

test('emergency stop requires STOP and reports results', async () => {
  const missing = await call('POST', '/api/emergency', { actions: ['pause'] });
  assert.equal(missing.body.code, 'CONFIRM_REQUIRED');
  const ok = await call('POST', '/api/emergency', { actions: ['pause', 'cancel'], confirm: 'STOP' });
  assert.equal(ok.status, 202);
  await new Promise(r => setTimeout(r, 100));
  const latest = await call('GET', '/api/emergency/latest');
  assert.equal(latest.body.record.status, 'completed');
  assert.equal(latest.body.record.results[0].status, 'done');
  const resume = await call('POST', '/api/emergency/resume');
  assert.equal(resume.status, 409, 'the trade-cap pause from earlier cannot be lifted the same day');
  assert.equal(resume.body.code, 'RULE_PAUSE');
});

test('cross-site POST is rejected', async () => {
  const res = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Origin: 'https://evil.example', Cookie: cookie } });
  assert.equal(res.status, 403);
});

test('P&L calendar: a month of days with a summary', async () => {
  const { stmt } = await import('../src/db/index.js');
  const me = (await call('GET', '/api/auth/me')).body.user;
  const add = (day, realized, entries, breaches = 0) => stmt(`INSERT OR REPLACE INTO day_state (user_id, day, realized, entries, wins, losses, breaches, sync_ok)
    VALUES (?, ?, ?, ?, ?, ?, ?, 10)`).run(me.id, day, realized, entries, realized > 0 ? 1 : 0, realized < 0 ? 1 : 0, breaches);
  add('2026-03-02', 1500, 2);
  add('2026-03-03', -800, 3, 1);
  add('2026-03-04', 0, 0);
  add('2026-04-01', 999, 1);   // other month: excluded
  const r = (await call('GET', '/api/analytics/calendar?month=2026-03')).body;
  assert.equal(r.month, '2026-03');
  assert.deepEqual(r.days.map(d => [d.day, d.pnl]), [['2026-03-02', 1500], ['2026-03-03', -800], ['2026-03-04', 0]]);
  assert.deepEqual(r.summary, { net: 700, tradingDays: 2, greenDays: 1, redDays: 1, trades: 5, limitDays: 1,
    best: { day: '2026-03-02', pnl: 1500 }, worst: { day: '2026-03-03', pnl: -800 } });
  assert.match((await call('GET', '/api/analytics/calendar?month=bad')).body.month, /^\d{4}-\d{2}$/, 'bad month falls back to the current one');
});

test('notification deletion validates ids and isolates accounts', async () => {
  const { notify, listNotifications } = await import('../src/modules/notifications/service.js');
  const first = (await call('GET', '/api/auth/me')).body.user;
  const own = notify(first.id, { kind: 'risk', title: 'Delete me' });
  const originalCookie = cookie;
  const second = await call('POST', '/api/auth/signup', { email: 'notification-other@example.com', password: 'longpassword' });
  assert.equal(second.status, 201);
  const other = notify(second.body.user.id, { kind: 'risk', title: 'Keep me' });
  cookie = originalCookie;
  assert.equal((await call('POST', '/api/notifications/delete', { id: 'bad' })).status, 400);
  assert.equal((await call('POST', '/api/notifications/delete', { id: other.id })).status, 200);
  assert.ok(listNotifications(second.body.user.id).some(n => n.id === other.id));
  const deleted = await call('POST', '/api/notifications/delete', { id: own.id });
  assert.equal(deleted.status, 200);
  assert.ok(!listNotifications(first.id).some(n => n.id === own.id));
  assert.equal(deleted.body.unread, (await call('GET', '/api/notifications')).body.unread);
  cookie = '';
  assert.equal((await call('POST', '/api/notifications/delete', { id: other.id })).status, 401);
  cookie = originalCookie;
});

test('AI paper P&L and loss cap stay independent from broker P&L', async () => {
  const signup = await call('POST', '/api/auth/signup', { email: 'paper-pnl@example.com', password: 'longpassword', name: 'Paper PnL' });
  assert.equal(signup.status, 201);
  const userId = signup.body.user.id;
  const { patchDay } = await import('../src/modules/risk/service.js');
  const { ist } = await import('../src/lib/time.js');
  patchDay(userId, ist().day, { realized: -5000, unrealized: 0 });

  const initial = (await call('GET', '/api/algo')).body;
  const saved = await call('PUT', '/api/algo', { config: { ...initial.config, paperEnabled: true, maxDailyLoss: 1500 } });
  assert.equal(saved.status, 200);

  const { stmt } = await import('../src/db/index.js');
  const makeProposal = (action, strike) => stmt(`INSERT INTO algo_events (user_id, kind, action, detail, created_at)
    VALUES (?, 'proposal', ?, ?, ?)`).run(userId, action, JSON.stringify({ expiry: '2026-10-15', contract: {
      securityId: String(strike), strike, option: action === 'BUY_CE' ? 'CE' : 'PE', ask: 100, bid: 99, ltp: 99.5,
    } }), Date.now()).lastInsertRowid;
  const proposalId = makeProposal('BUY_CE', 25000);
  const opened = await call('POST', '/api/algo/paper-trades/open', { proposalId, quantity: 50 });
  assert.equal(opened.status, 200);
  assert.equal(opened.body.trade.entryPrice, 100);

  let status = (await call('GET', '/api/algo')).body;
  assert.equal(status.safety.realPnlToday, -5000);
  assert.equal(status.safety.paper.todayPnl, -50, 'paper open P&L is marked from its own entry and option bid');

  const closed = await call('POST', '/api/algo/paper-trades/close', { id: opened.body.trade.id, exitPrice: 50 });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.trade.realizedPnl, -2500);
  status = (await call('GET', '/api/algo')).body;
  assert.equal(status.safety.realPnlToday, -5000, 'paper closes never alter broker P&L');
  assert.equal(status.safety.paper.todayPnl, -2500);

  const nextId = makeProposal('BUY_PE', 25000);
  const capped = await call('POST', '/api/algo/paper-trades/open', { proposalId: nextId, quantity: 50 });
  assert.equal(capped.status, 403);
  assert.equal(capped.body.code, 'PAPER_DAILY_LIMIT', 'the paper cap is enforced using paper P&L only');
});

test('automatic paper scanning is opt-in and persists its one-minute five-minute configuration', async () => {
  const signup = await call('POST', '/api/auth/signup', { email: 'auto-paper@example.com', password: 'longpassword', name: 'Auto Paper' });
  assert.equal(signup.status, 201);
  const initial = (await call('GET', '/api/algo')).body;
  assert.equal(initial.config.autoTrading, false);
  assert.equal(initial.scanner.enabled, false);
  assert.equal(initial.scanner.intervalSeconds, 60);
  assert.equal(initial.scanner.timeframe, '5m');
  const saved = await call('PUT', '/api/algo', { config: { ...initial.config, paperEnabled: true, autoTrading: true, autoQuantity: 25 } });
  assert.equal(saved.status, 200);
  const status = (await call('GET', '/api/algo')).body;
  assert.equal(status.config.autoTrading, true);
  assert.equal(status.config.autoQuantity, 25);
  assert.equal(status.scanner.enabled, true);
});
