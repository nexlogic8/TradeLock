import { HttpError } from './errors.js';

// Fixed-window limiter, in memory. Good for a single process; use Redis when scaling out.
const hits = new Map();

export function limit(key, max, windowMs) {
  const now = Date.now();
  let h = hits.get(key);
  if (!h || h.reset < now) hits.set(key, (h = { n: 0, reset: now + windowMs }));
  if (++h.n > max) {
    const mins = Math.max(1, Math.ceil((h.reset - now) / 60000));
    throw new HttpError(429, 'RATE_LIMITED', `Too many attempts. Try again in ${mins} min.`);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [k, h] of hits) if (h.reset < now) hits.delete(k);
}, 60_000).unref();
