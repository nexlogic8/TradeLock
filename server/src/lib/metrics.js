// In-process runtime metrics for the admin dashboard and alerts (memory only, reset on restart).
const bootAt = Date.now();
const buckets = new Map(); // minute -> { req, err }
let sse = 0;
let lastTickAt = null;
let lastTickMs = 0;

const minute = () => Math.floor(Date.now() / 60000);

export function recordRequest(status) {
  const m = minute();
  const b = buckets.get(m) || { req: 0, err: 0 };
  b.req++;
  if (status >= 500) b.err++;
  buckets.set(m, b);
  if (buckets.size > 120) for (const k of buckets.keys()) if (k < m - 90) buckets.delete(k);
}

export const sseOpened = () => { sse++; };
export const sseClosed = () => { sse = Math.max(0, sse - 1); };

export function recordTick(ms) {
  lastTickAt = Date.now();
  lastTickMs = ms;
}

export function metrics() {
  const m = minute();
  let requestsLastHour = 0, errorsLastHour = 0, errorsLast10m = 0;
  for (const [k, b] of buckets) {
    if (k > m - 60) { requestsLastHour += b.req; errorsLastHour += b.err; }
    if (k > m - 10) errorsLast10m += b.err;
  }
  return {
    bootAt, uptimeMs: Date.now() - bootAt,
    requestsLastHour, errorsLastHour, errorsLast10m,
    sseConnections: sse,
    monitor: { lastTickAt, lastTickMs },
  };
}
