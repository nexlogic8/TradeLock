// Lean JSON-over-HTTP(S) client for broker APIs. Thousands of agents poll the same host every few
// seconds, so connections are kept alive and reused from a bounded pool: no TLS handshake per call,
// and a burst of requests queues for a free socket instead of opening thousands of connections.
import http from 'node:http';
import https from 'node:https';

const POOL = { keepAlive: true, keepAliveMsecs: 30e3, maxSockets: 256, maxFreeSockets: 256, scheduling: 'lifo' };
const agents = { 'http:': new http.Agent(POOL), 'https:': new https.Agent(POOL) };

export class HttpClientError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

/** Resolves { status, text }. Rejects with code 'TIMEOUT' or 'NETWORK'. Never throws on HTTP status. */
export function request(method, url, { headers = {}, body, timeoutMs = 5000, family = 4, localAddress } = {}) {
  const u = new URL(url);
  const lib = u.protocol === 'https:' ? https : http;
  const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = lib.request(u, {
      method,
      agent: agents[u.protocol],
      // Brokers allow orders only from the account's registered static IP. IPv4 (34.93.19.54) unless the caller
      // asks for IPv6: a second Dhan account registers the server's IPv6, since one IP fits one account.
      family,
      ...(localAddress && { localAddress }),   // the user's own static IP (see broker/static-ip.js)
      headers: { ...headers, ...(payload !== undefined && { 'Content-Length': Buffer.byteLength(payload) }) },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }); });
      res.on('error', e => { clearTimeout(timer); reject(new HttpClientError(e.message, 'NETWORK')); });
    });
    // One timer for the whole exchange (queueing for a socket included).
    const timer = setTimeout(() => req.destroy(new HttpClientError('timeout', 'TIMEOUT')), timeoutMs);
    req.on('error', e => { clearTimeout(timer); reject(e instanceof HttpClientError ? e : new HttpClientError(e.message, 'NETWORK')); });
    req.end(payload);
  });
}
