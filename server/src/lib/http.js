import { HttpError } from './errors.js';

const MAX_BODY = 64 * 1024;

/** Tiny method + path router. Patterns use `:name` segments. */
export class Router {
  #routes = [];

  on(method, pattern, handler, opts = {}) {
    const keys = [];
    const source = pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'));
    this.#routes.push({ method, re: new RegExp(`^${source}/?$`), keys, handler, opts });
    return this;
  }
  get(p, h, o) { return this.on('GET', p, h, o); }
  post(p, h, o) { return this.on('POST', p, h, o); }
  put(p, h, o) { return this.on('PUT', p, h, o); }
  patch(p, h, o) { return this.on('PATCH', p, h, o); }
  delete(p, h, o) { return this.on('DELETE', p, h, o); }

  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.#routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      return { handler: r.handler, opts: r.opts, params };
    }
    if (pathMatched) throw new HttpError(405, 'METHOD_NOT_ALLOWED', `${method} is not allowed here`);
    throw new HttpError(404, 'NOT_FOUND', 'No such endpoint');
  }
}

/** Raw request body (for webhook signature checks). */
export async function readRaw(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, 'BODY_TOO_LARGE', 'Request body is too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, 'BODY_TOO_LARGE', 'Request body is too large');
    chunks.push(c);
  }
  if (!size) return {};
  if (!String(req.headers['content-type'] || '').includes('application/json')) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send JSON with Content-Type: application/json');
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { value = null; }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'INVALID_JSON', 'Request body must be a JSON object');
  }
  return value;
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip malformed */ }
    }
  }
  return out;
}

export function setCookie(res, name, value, { maxAge, httpOnly = true, secure = false, sameSite = 'Lax', path = '/' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
  if (maxAge !== undefined) c += `; Max-Age=${Math.floor(maxAge / 1000)}`;
  if (httpOnly) c += '; HttpOnly';
  if (secure) c += '; Secure';
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, c) : c);
}

export function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
  });
  res.end(json);
}
