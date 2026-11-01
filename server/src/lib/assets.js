// Content-fingerprinted static assets, so browsers and the Android WebView cache JS/CSS forever and
// never re-ask the server on app open.
//
// - Every file under web/js, web/css and web/fonts gets a short content hash.
// - The app shell (index.html) is rendered with ?v=<hash> on its stylesheets and main.js, plus an
//   import map that gives every ES module its ?v=<hash> URL: relative imports and import() resolve
//   through it, so a module only changes URL when its content changes.
// - Every module on the boot path gets a <link rel="modulepreload">: the browser fetches them all in
//   parallel instead of discovering them one import level at a time (9 levels deep).
// - static.js serves a request whose ?v= matches the file's current hash as immutable for a year.
// The import map is inline, so its sha256 goes into the Content-Security-Policy (see app.js).
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const ROOTS = ['js', 'css', 'fonts'];
let cache = null;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name), st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push({ full, mtime: st.mtimeMs, size: st.size });
  }
  return out;
}

const urlOf = full => '/' + path.relative(config.webDir, full).split(path.sep).join('/');
const importsOf = (src, fromUrl) => [...src.matchAll(/^\s*import\s[^'"]*['"](\.{1,2}\/[^'"]+)['"]/gm)]
  .map(m => new URL(m[1], `https://x${fromUrl}`).pathname);

function build() {
  const files = ROOTS.flatMap(r => { try { return walk(path.join(config.webDir, r)); } catch { return []; } });
  const signature = files.map(f => `${f.full}:${f.mtime}:${f.size}`).join('|');
  if (cache?.signature === signature) return cache;
  const hashes = new Map(), sources = new Map();
  for (const f of files) {
    const buf = readFileSync(f.full), url = urlOf(f.full);
    hashes.set(url, createHash('sha1').update(buf).digest('hex').slice(0, 10));
    if (/\.m?js$/.test(url)) sources.set(url, buf.toString('utf8'));
  }
  const v = url => `${url}?v=${hashes.get(url)}`;
  const imports = {};
  for (const url of sources.keys()) imports[url] = v(url);
  const importMap = JSON.stringify({ imports });
  // Modules loaded at boot: main.js and everything it imports statically.
  const boot = [], seen = new Set();
  (function visit(url) {
    if (seen.has(url) || !sources.has(url)) return;
    seen.add(url);
    for (const dep of importsOf(sources.get(url), url)) visit(dep);
    boot.push(url);
  })('/js/main.js');
  const shell = readFileSync(path.join(config.webDir, 'index.html'), 'utf8')
    // Fonts keep plain URLs: fonts.css asks for them without ?v, and a preload must use the same URL.
    .replace(/(href|src)="(\/(?:css|js)\/[^"?]+)(?:\?[^"]*)?"/g, (m, attr, url) => hashes.has(url) ? `${attr}="${v(url)}"` : m)
    .replace(/\s*<link rel="modulepreload"[^>]*>/g, '')
    .replace('<script type="module"', `<script type="importmap">${importMap}</script>\n  `
      + boot.map(url => `<link rel="modulepreload" href="${v(url)}">`).join('\n  ') + '\n  <script type="module"');
  const shellBuf = Buffer.from(shell);
  cache = { signature, hashes, shell: shellBuf, shellEtag: `"${createHash('sha1').update(shellBuf).digest('hex').slice(0, 16)}"`,
    importMapHash: `'sha256-${createHash('sha256').update(importMap).digest('base64')}'` };
  return cache;
}

/** Fingerprints, rebuilt when a file under web/ changes (one stat walk; cheap at this size). */
export function assets() {
  if (!cache || !config.isProd) return build();
  return cache;
}

/** True when `v` is the current fingerprint of `url` (then it may be cached forever). */
export const isCurrent = (url, v) => !!v && assets().hashes.get(url) === v;
