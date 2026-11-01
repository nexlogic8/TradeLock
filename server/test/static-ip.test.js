// Each user's own static IP: a fixed address from the server's IPv6 block, and broker calls leave from it.
process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
process.env.IPV6_POOL = '2406:da1a:13ae:3200:a1b2::/80';
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { stmt } = await import('../src/db/index.js');
const { staticIpFor, egressFor, staticIpView, poolAddress, canonicalIp } = await import('../src/modules/broker/static-ip.js');
const { createDhanAdapter } = await import('../src/modules/broker/adapters/dhan.js');

test('every user gets their own fixed address from the block; hand-mapped users keep theirs', () => {
  for (const id of [1, 2, 3, 300]) stmt(`INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, 'x', 'x', 1)`).run(id, `u${id}@example.com`);
  stmt(`INSERT INTO static_ips (user_id, ip, family, assigned_at) VALUES (2, '13.235.49.88', 4, 1)`).run();
  assert.equal(poolAddress(3), '2406:da1a:13ae:3200:a1b2::3');
  assert.equal(staticIpFor(300).ip, '2406:da1a:13ae:3200:a1b2::12c');
  assert.equal(staticIpFor(300).ip, '2406:da1a:13ae:3200:a1b2::12c', 'same address every time');
  assert.notEqual(staticIpFor(1).ip, staticIpFor(3).ip);
  assert.deepEqual(egressFor(2), { family: 4 }, 'the IPv4 user stays on IPv4');
  assert.deepEqual(egressFor(3), { family: 6, localAddress: '2406:da1a:13ae:3200:a1b2::3' });
  assert.deepEqual(staticIpView(3), { ip: '2406:da1a:13ae:3200:a1b2::3', family: 6, own: true });
  assert.equal(canonicalIp('2406:DA1A:13AE:3200:A1B2:0:0:3'), '2406:da1a:13ae:3200:a1b2::3');
  assert.equal(poolAddress(300, '2600:1900:40a0:9b8:0:0:0:0/96'), '2600:1900:40a0:9b8::12c', 'a Google Cloud /96 block');
  assert.equal(poolAddress(3, '2600:1900:40a0:9b8::/64'), null);
});

test("a user's Dhan calls leave from their own address", async () => {
  const seen = [];
  const transport = async (method, url, opts) => { seen.push([opts.family, opts.localAddress]); return { status: 200, text: JSON.stringify({ orderId: '1', orderStatus: 'PENDING' }) }; };
  const a = createDhanAdapter({ clientId: 'C3', accessToken: 'test-token-not-real-0123456789', transport, egress: () => egressFor(3) });
  await a.placeOrder({ symbol: 'X', side: 'BUY', qty: 65, type: 'MARKET', securityId: '51334', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY' });
  await a.snapshot().catch(() => {});
  assert.ok(seen.length >= 2);
  assert.ok(seen.every(([f, la]) => f === 6 && la === '2406:da1a:13ae:3200:a1b2::3'), JSON.stringify(seen));
});
