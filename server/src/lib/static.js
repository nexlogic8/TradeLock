import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { HttpError } from './errors.js';
import { assets, isCurrent } from './assets.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.apk': 'application/vnd.android.package-archive',   // the Android app (web/downloads, /android page)
};

const statFile = async f => {
  const s = await stat(f).catch(() => null);
  return s?.isFile() ? s : null;
};

/** Serves web/ with ETag revalidation. Unknown extensionless paths fall back to index.html. */
export async function serveStatic(req, res, url) {
  if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { throw new HttpError(400, 'BAD_PATH', 'Malformed path'); }
  if (rel.endsWith('/')) rel += 'index.html';

  let file = path.join(config.webDir, rel);
  if (!file.startsWith(config.webDir + path.sep)) throw new HttpError(404, 'NOT_FOUND', 'File not found');
  let st = await statFile(file);
  // The admin console is its own app: /admin and /admin/<menu> all load web/admin/index.html.
  const isAdmin = rel === '/admin' || rel.startsWith('/admin/');
  if (isAdmin) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (!st && isAdmin && !path.extname(rel)) { file = path.join(config.webDir, 'admin', 'index.html'); st = await statFile(file); }
  if (!st) {
    if (path.extname(rel) && !(rel.endsWith('/index.html') && url.pathname.endsWith('/'))) throw new HttpError(404, 'NOT_FOUND', 'File not found');
    // Clean URLs for standalone pages: /privacy → privacy.html; anything else is the app.
    const page = await statFile(`${file}.html`);
    if (page) { file = `${file}.html`; st = page; }
    else { file = path.join(config.webDir, 'index.html'); st = await statFile(file); }
  }

  // The app shell: rendered with fingerprinted asset URLs, an import map and boot modulepreloads.
  if (file === path.join(config.webDir, 'index.html')) {
    const { shell, shellEtag } = assets();
    res.setHeader('ETag', shellEtag);
    res.setHeader('Cache-Control', 'no-cache');
    if (req.headers['if-none-match'] === shellEtag) { res.writeHead(304); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': shell.length });
    return res.end(req.method === 'HEAD' ? undefined : shell);
  }
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  res.setHeader('ETag', etag);
  // A URL carrying the file's current fingerprint never changes content: cache it for a year.
  // Fonts keep their names, so a month. Everything else revalidates (cheap 304).
  const forever = isCurrent(rel, url.searchParams.get('v'));
  res.setHeader('Cache-Control', forever ? 'public, max-age=31536000, immutable'
    : rel.startsWith('/fonts/') ? 'public, max-age=2592000' : 'no-cache');
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304);
    return res.end();
  }
  if (path.extname(file) === '.apk') res.setHeader('Content-Disposition', `attachment; filename="${path.basename(file)}"`);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}
