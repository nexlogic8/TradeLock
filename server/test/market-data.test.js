// One Dhan account supplies market data for every user (MARKET_DATA_USER_ID); orders stay with each user's broker.
process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
process.env.MARKET_DATA_USER_ID = '1';
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { stmt } = await import('../src/db/index.js');
const { withSharedData, sharedSource } = await import('../src/modules/broker/market-data.js');
const { marketFeedCredentials } = await import('../src/modules/broker/registry.js');
const { encrypt } = await import('../src/lib/crypto.js');

test('market data comes from the shared account (cached, one call for many users); orders stay with the user', async () => {
  assert.equal(sharedSource(), null, 'nothing shared until that account is connected');
  for (const [id, email] of [[1, 'data@example.com'], [2, 'user@example.com']]) stmt(`INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, 'x', 'x', 1)`).run(id, email);
  stmt(`INSERT INTO broker_accounts (user_id, broker, client_id, token_enc, status, created_at) VALUES (1, 'dhan', 'DATA1', ?, 'connected', 1)`).run(encrypt('shared-token-not-real-0123456789'));
  const src = sharedSource();
  assert.equal(src.clientId, 'DATA1');
  let calls = 0;
  src.adapter = { ...src.adapter, optionChain: async () => { calls++; return { data: { last_price: 22753.2 } }; } };
  const own = { optionChain: async () => { throw new Error('own token has no Data APIs'); }, placeOrder: async () => ({ id: 'mine' }) };
  const a = withSharedData(own), b = withSharedData(own);
  const args = { underlyingScrip: 13, underlyingSeg: 'IDX_I', expiry: '2026-11-03' };
  const [x, y] = await Promise.all([a.optionChain(args), b.optionChain(args)]);
  assert.equal(x.data.last_price, 22753.2);
  assert.equal(y, x);
  assert.equal(calls, 1, 'two users, one chain call');
  assert.equal((await a.placeOrder({})).id, 'mine', 'orders use the user\'s own broker');
  const feed = marketFeedCredentials(2);
  assert.deepEqual([feed.key, feed.clientId], ['shared', 'DATA1'], 'live feed logs in with the shared account');
});
