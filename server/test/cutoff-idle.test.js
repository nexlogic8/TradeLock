process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { stmt } = await import('../src/db/index.js');
const { createUser } = await import('../src/modules/auth/service.js');
const { adapterFor, accountFor } = await import('../src/modules/broker/registry.js');
const { syncAccount } = await import('../src/modules/risk/monitor.js');
const { dayState } = await import('../src/modules/risk/service.js');

for (const scenario of ['idle', 'closed trade', 'carried position', 'pending order']) {
  test(`cutoff: ${scenario}`, async t => {
    const now = Date.parse('2026-10-15T15:01:00+05:30');
    t.mock.method(Date, 'now', () => now);
    const uid = createUser({ email: `${scenario.replaceAll(' ', '-')}@cutoff.test`, password: null, name: 'Cutoff test' });
    stmt("INSERT INTO broker_accounts (user_id, broker, client_id, status, created_at) VALUES (?, 'mock', ?, 'connected', ?)")
      .run(uid, `cutoff-${uid}`, now);
    const acct = accountFor(uid);
    const adapter = adapterFor(acct);
    let activations = 0;
    const positions = scenario === 'carried position' ? [{ symbol: 'TEST', qty: 1, realized: 0, unrealized: 0 }] : [];
    const orders = scenario === 'pending order' ? [{ id: 'pending', symbol: 'TEST', side: 'BUY' }] : [];
    const trades = scenario === 'closed trade' ? [
      { id: 'buy', symbol: 'TEST', side: 'BUY', qty: 1, price: 100, ts: now - 120000 },
      { id: 'sell', symbol: 'TEST', side: 'SELL', qty: 1, price: 100, ts: now - 60000 },
    ] : [];
    adapter.snapshot = async () => ({ positions, orders, trades, funds: { available: 100000, used: 0 } });
    adapter.getKillSwitch = async () => activations > 0;
    adapter.activateKillSwitch = async () => { activations++; return { message: 'Locked' }; };
    adapter.cancelOrder = async () => ({ status: 'cancelled' });
    await syncAccount(acct, { force: true });
    await new Promise(resolve => setImmediate(resolve));
    await syncAccount(acct, { force: true });
    await new Promise(resolve => setImmediate(resolve));
    const state = dayState(uid);
    assert.equal(state.paused, 1, 'cutoff still blocks new TradeLock entries');
    assert.equal(state.pause_reason, 'rule:cutoff');
    // The Indian-market lock: TradeLock holds it, the broker's account-wide switch is never used (activations 0).
    assert.equal(activations, 0, 'broker kill switch never switched on');
    if (scenario === 'idle') {
      assert.equal(state.ks_armed, null);
      assert.equal(state.ks_active_at, null);
    } else if (scenario === 'carried position') {
      assert.equal(state.ks_armed, 'rule:cutoff', 'open position is left alone until flat');
      assert.equal(state.ks_active_at, null);
    } else {
      assert.ok(state.ks_active_at, 'trading activity retains cutoff protection (market locked)');
    }
  });
}
