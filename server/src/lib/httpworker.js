// Broker HTTP on a background thread. Thousands of agents poll every few seconds; sending requests and
// reading replies (sockets, TLS, HTTP parsing) runs on this worker, on the server's other CPU core, so
// the main thread keeps its time for rules, dashboards and the website.
// The worker returns raw { status, text }; JSON parsing and everything else stays on the main thread.
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { request, HttpClientError } from './httpclient.js';

if (!isMainThread && parentPort) {
  parentPort.on('message', ({ id, method, url, opts }) => {
    request(method, url, opts).then(
      res => parentPort.postMessage({ id, status: res.status, text: res.text }),
      err => parentPort.postMessage({ id, error: err.message, code: err.code || 'NETWORK' }),
    );
  });
}

let worker = null;
let seq = 0;
const pending = new Map();

function start() {
  worker = new Worker(new URL(import.meta.url));
  worker.on('message', m => {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error !== undefined) p.reject(new HttpClientError(m.error, m.code));
    else p.resolve({ status: m.status, text: m.text });
  });
  // If the thread ever dies, fail what was in flight and start a new one on the next request.
  const fail = e => {
    worker = null;
    for (const p of pending.values()) p.reject(new HttpClientError(e?.message || 'HTTP worker stopped', 'NETWORK'));
    pending.clear();
  };
  worker.on('error', fail);
  worker.on('exit', code => { if (worker) fail(new Error(`HTTP worker exited (${code})`)); });
  // Never keep the process alive by itself (after the listeners: adding one re-references the port).
  worker.unref();
}

/** Same contract as httpclient.request(), executed on the worker thread. */
export function workerRequest(method, url, opts = {}) {
  if (!worker) start();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, method, url, opts });
  });
}
