process.env.DB_PATH = ':memory:';
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { decodeDhanQuotePacket } = await import('../src/modules/scalper/live.js');

function header(code, length, segment = 2, id = 12345) {
  const b = Buffer.alloc(length);
  b.writeUInt8(code, 0); b.writeUInt16LE(length, 1); b.writeUInt8(segment, 3); b.writeUInt32LE(id, 4);
  return b;
}

test('decodes Dhan quote packets into typed live ticks', () => {
  const b = header(4, 50);
  b.writeFloatLE(245.65, 8); b.writeInt16LE(65, 12); b.writeUInt32LE(1_700_000_000, 14);
  b.writeFloatLE(240, 18); b.writeUInt32LE(9000, 22); b.writeUInt32LE(400, 26); b.writeUInt32LE(500, 30);
  const tick = decodeDhanQuotePacket(b);
  assert.equal(tick.type, 'tick'); assert.equal(tick.exchangeSegment, 'NSE_FNO'); assert.equal(tick.securityId, '12345');
  assert.ok(Math.abs(tick.ltp - 245.65) < 0.001); assert.equal(tick.lastQty, 65); assert.equal(tick.volume, 9000);
});

test('quote packets carry the day open, close, high and low (bytes 34–49)', () => {
  const q = header(4, 50);
  q.writeFloatLE(132.45, 8); q.writeFloatLE(257.95, 34); q.writeFloatLE(212.8, 38); q.writeFloatLE(320.25, 42); q.writeFloatLE(81, 46);
  const t = decodeDhanQuotePacket(q);
  assert.deepEqual([t.ltp, t.dayOpen, t.dayClose, t.dayHigh, t.dayLow].map(v => Math.round(v * 100) / 100), [132.45, 257.95, 212.8, 320.25, 81]);
});

test('decodes full packets with market depth and rejects malformed packets', () => {
  // Dhan full packet: 162 bytes, depth (5 × 20 bytes) from byte 62 (checked against a live packet).
  const b = header(8, 162);
  b.writeFloatLE(100.25, 8); b.writeUInt32LE(1234, 22); b.writeUInt32LE(55, 34); b.writeFloatLE(99, 46);
  b.writeUInt32LE(10, 62); b.writeUInt32LE(20, 66); b.writeFloatLE(100.2, 74); b.writeFloatLE(100.3, 78);
  const tick = decodeDhanQuotePacket(b);
  assert.equal(tick.ltp, 100.25); assert.equal(tick.oi, 55); assert.equal(tick.dayOpen, 99);
  assert.equal(tick.depth.length, 5); assert.ok(Math.abs(tick.depth[0].bid - 100.2) < 0.001); assert.ok(Math.abs(tick.depth[0].ask - 100.3) < 0.001);
  assert.equal(decodeDhanQuotePacket(Buffer.from([4, 0])), null);
  assert.equal(decodeDhanQuotePacket(Buffer.from([50])).type, 'feed-status');
});

test('subscriptions: Algo Trading near-ATM options in Full mode (depth); a mode change unsubscribes first', async () => {
  const { subscriptionSteps } = await import('../src/modules/scalper/live.js');
  const none = new Map(), next = new Map([['IDX_I:13', 17], ['NSE_FNO:1', 21], ['NSE_FNO:2', 17]]);
  assert.deepEqual(subscriptionSteps(none, next), [[17, ['IDX_I:13', 'NSE_FNO:2']], [21, ['NSE_FNO:1']]]);
  assert.deepEqual(subscriptionSteps(next, next), [], 'nothing changed: nothing sent');
  const later = new Map([['IDX_I:13', 17], ['NSE_FNO:2', 21]]);
  assert.deepEqual(subscriptionSteps(next, later), [[18, ['NSE_FNO:2']], [22, ['NSE_FNO:1']], [21, ['NSE_FNO:2']]], 'NSE_FNO:1 dropped, NSE_FNO:2 Quote → Full');
});
