process.env.DB_PATH = ':memory:';
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const c = await import('../src/lib/crypto.js');

test('password hashing round-trip', () => {
  const h = c.hashPassword('correct horse battery');
  assert.ok(c.verifyPassword('correct horse battery', h));
  assert.ok(!c.verifyPassword('wrong', h));
});

test('broker tokens encrypt and decrypt', () => {
  const enc = c.encrypt('eyJ-secret-token');
  assert.notEqual(enc, 'eyJ-secret-token');
  assert.equal(c.decrypt(enc), 'eyJ-secret-token');
});

test('TOTP matches RFC 6238 SHA-1 vector', () => {
  const secret = c.base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(c.totp(secret, 59_000), '287082');
  assert.equal(c.totp(secret, 1_111_111_109_000), '081804');
});
