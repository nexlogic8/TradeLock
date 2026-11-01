// Broker HTTP client: keep-alive pool, timeouts, and the same contract on the background thread.
process.env.DB_PATH = ':memory:';
const { test, before, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { createServer } = await import('node:http');
const { request } = await import('../src/lib/httpclient.js');
const { workerRequest } = await import('../src/lib/httpworker.js');

let server, base;
const sockets = new Set();
before(async () => {
  server = createServer((req, res) => {
    sockets.add(req.socket);
    if (req.url === '/slow') return setTimeout(() => res.end('{}'), 2000);
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => res.writeHead(req.url === '/missing' ? 404 : 200).end(JSON.stringify({ method: req.method, url: req.url, token: req.headers['access-token'], body })));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections(); server.close(); });

for (const [name, send] of [['inline', request], ['worker thread', workerRequest]]) {
  test(`${name}: status, body and headers round-trip`, async () => {
    const r = await send('POST', `${base}/orders?x=1`, { headers: { 'access-token': 'abc' }, body: { qty: 75 } });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text), { method: 'POST', url: '/orders?x=1', token: 'abc', body: '{"qty":75}' });
    assert.equal((await send('GET', `${base}/missing`)).status, 404, 'HTTP errors are returned, not thrown');
  });

  test(`${name}: timeout and connection errors carry a code`, async () => {
    await assert.rejects(send('GET', `${base}/slow`, { timeoutMs: 200 }), e => e.code === 'TIMEOUT');
    await assert.rejects(send('GET', 'http://127.0.0.1:1/x', { timeoutMs: 1000 }), e => e.code === 'NETWORK');
  });
}

test('connections are reused (keep-alive pool)', async () => {
  sockets.clear();
  for (let i = 0; i < 20; i++) await request('GET', `${base}/positions`);
  assert.equal(sockets.size, 1, '20 sequential calls share one connection');
});
