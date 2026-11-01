// History backfill: downloads NIFTY 1-minute history into data/history.db for fast backtests.
//   node server/src/workers/history-backfill.js                 last 365 days, up to yesterday
//   node server/src/workers/history-backfill.js --days 180 --to 2026-10-23 --codes 1,2 --pause 1500 --window 10
//   node server/src/workers/history-backfill.js --status        what is stored so far
//   --max-offset 2: only strikes within 2 steps of ATM (fill what the live strategies trade first)
//   --max-per-day 5000: at most that many Dhan requests per IST day (Dhan allows 7,000 a day per account, shared
//     with the live account's Algo Trading), then wait for the next day. Counted from the stored log, so a
//     restart does not reset it.
// What it stores:
//   - index 1m candles (Dhan intraday, ≤ 80 days a request)
//   - expired-options 1m candles (Dhan rollingoption, --window days a request, default 1: since about 28 Oct 2026
//     Dhan refuses a fromDate–toDate span over one day with DH-905 "bad values"; it used to allow 45), CE and PE:
//     expiry slot 1 (nearest weekly) at ATM-10 … ATM+10, slot 2 (the one after) at ATM-3 … ATM+3
//     (the widest offsets Dhan serves for each slot), with volume, OI, IV and spot.
// Resumable: every finished request is logged, so a re-run only fetches what is missing.
// Polite to the broker: one request at a time with a pause between them, no requests during market
// hours (09:00–15:30 IST on weekdays) unless --force, and a long back-off on rate-limit replies, so
// the live account's sync and Algo Trading are never starved of API quota.
import { stmt } from '../db/index.js';
import { adapterFor } from '../modules/broker/registry.js';
import { normalizeScalperCandles } from '../modules/scalper/routes.js';
import { openHistory } from '../modules/backtest/history-store.js';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const has = name => process.argv.includes(`--${name}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const istDay = ms => new Date(ms + 19_800_000).toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const UNDERLYING = 'NIFTY';
const store = openHistory();
// The broker transport can leave nothing on the event loop while a request is in flight; keep the
// process alive until the run ends (otherwise Node exits with code 13 mid-await).
const keepAlive = setInterval(() => {}, 60_000);

if (has('status')) {
  const s = store.summary(), d = t => (t ? istDay(t * 1000) : '-');
  for (const o of s.options) console.log(`options slot ${o.code}: ${o.rows} rows, ${d(o.first)} … ${d(o.last)}`);
  for (const i of s.index) console.log(`index ${i.underlying}: ${i.rows} rows, ${d(i.first)} … ${d(i.last)}`);
  console.log(`requests done: ${s.requests}`);
  store.close(); process.exit(0);
}

const TO = arg('to', istDay(Date.now() - 86_400_000)), DAYS = Number(arg('days', 365)), FROM = addDays(TO, -DAYS + 1);
const CODES = String(arg('codes', '1,2')).split(',').map(Number), PAUSE = Number(arg('pause', 1500)), USER = arg('user', null), WINDOW = Number(arg('window', 1));
const MAX_OFFSET = Number(arg('max-offset', 99));
const offsetsFor = code => { const w = Math.min(code === 1 ? 10 : 3, MAX_OFFSET); return Array.from({ length: 2 * w + 1 }, (_, k) => k - w); };
// No trading on Saturday or Sunday: 1-day windows on those days are skipped (no request, nothing to store).
const weekend = d => [0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay());
const slotName = k => (k === 0 ? 'ATM' : `ATM${k > 0 ? '+' : ''}${k}`);

// The Dhan account to read history with (re-read before each request: the token keeper may renew it).
function account() {
  const rows = USER ? stmt("SELECT * FROM broker_accounts WHERE broker = 'dhan' AND user_id = ?").all(Number(USER))
    : stmt("SELECT * FROM broker_accounts WHERE broker = 'dhan' ORDER BY status = 'connected' DESC, id").all();
  if (!rows.length) throw new Error('No Dhan account connected.');
  return rows[0];
}
function marketHours(now = Date.now()) {
  const t = new Date(now + 19_800_000), day = t.getUTCDay(), hm = t.toISOString().slice(11, 16);
  return day >= 1 && day <= 5 && hm >= '09:00' && hm < '15:30';
}
// Daily request budget (see --max-per-day): leaves Dhan's daily data quota for the live account.
const MAX_PER_DAY = Number(arg('max-per-day', 0));
let quotaDay = '', usedToday = 0;
async function budget(label) {
  for (;;) {
    const day = istDay(Date.now());
    if (day !== quotaDay) {
      quotaDay = day;
      usedToday = store.db.prepare('SELECT COUNT(*) AS n FROM fetch_log WHERE fetched_at >= ?').get(Date.parse(`${day}T00:00:00+05:30`)).n;
    }
    if (!MAX_PER_DAY || usedToday < MAX_PER_DAY) { usedToday++; return; }
    console.log(`[backfill] ${MAX_PER_DAY} requests used today (IST): waiting for tomorrow (${label})`);
    await sleep(30 * 60_000);
  }
}

async function request(label, fn) {
  for (let attempt = 0; ; attempt++) {
    while (!has('force') && marketHours()) { console.log(`[backfill] market hours: waiting until 15:30 IST (${label})`); await sleep(5 * 60_000); }
    await budget(label);
    await sleep(PAUSE);
    try { return await fn(adapterFor(account())); }
    catch (e) {
      if (e?.code === 'TOKEN_EXPIRED') throw e;
      const rate = /too many|rate|805|DH-904/i.test(`${e?.code} ${e?.message}`);
      if (attempt >= 4) { console.log(`[backfill] giving up for now on ${label}: ${e.message}`); return null; }
      const wait = rate ? 60_000 * (attempt + 1) : 5_000 * (attempt + 1);
      console.log(`[backfill] ${label}: ${e.message} — retry in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
}

const started = Date.now(); let done = 0, skipped = 0, failed = 0, rowsTotal = 0;
console.log(`[backfill] ${UNDERLYING} ${FROM} … ${TO}, expiry slots ${CODES.join(',')}, ${WINDOW}-day requests, pause ${PAUSE} ms`);

// 1) index 1-minute candles
for (let a = FROM; a <= TO; a = addDays(a, 80)) {
  const b = addDays(a, 79) < TO ? addDays(a, 79) : TO;
  if (store.fetched('index', UNDERLYING, 0, '', 0, a, b)) { skipped++; continue; }
  const raw = await request(`index ${a}…${b}`, ad => ad.intradayCandles({ securityId: '13', exchangeSegment: 'IDX_I', instrument: 'INDEX', interval: '1', fromDate: `${a} 09:00:00`, toDate: `${b} 15:30:00` }));
  if (!raw) { failed++; continue; }
  const rows = normalizeScalperCandles(raw).map(c => ({ ...c, time: Math.round(c.time / 1000) }));
  store.saveIndex(UNDERLYING, a, b, rows); done++; rowsTotal += rows.length;
  console.log(`[backfill] index ${a}…${b}: ${rows.length} rows`);
}

// 2) expired-options 1-minute candles, WINDOW-day windows [a, b)
const windows = []; for (let a = FROM; a <= TO; a = addDays(a, WINDOW)) if (WINDOW > 1 || !weekend(a)) windows.push([a, addDays(a, WINDOW) > addDays(TO, 1) ? addDays(TO, 1) : addDays(a, WINDOW)]);
const jobs = []; for (const code of CODES) for (const side of ['CE', 'PE']) for (const off of offsetsFor(code)) for (const [a, b] of windows) jobs.push({ code, side, off, a, b });
// Strikes nearest ATM first (what backtests use most), so the useful part is ready early.
jobs.sort((x, y) => Math.abs(x.off) - Math.abs(y.off) || x.code - y.code || x.side.localeCompare(y.side) || x.off - y.off || x.a.localeCompare(y.a));
let n = 0;
for (const { code, side, off, a, b } of jobs) {
  n++;
  if (store.fetched('option', UNDERLYING, code, side, off, a, b)) { skipped++; continue; }
  const label = `slot ${code} ${side} ${slotName(off)} ${a}…${b}`;
  let raw;
  try { raw = await request(label, ad => ad.rollingOption({ expiryFlag: 'WEEK', expiryCode: code, strike: slotName(off), option: side, fromDate: a, toDate: b, interval: '1', full: true, timeoutMs: 45_000 })); }
  catch (e) { console.log(`[backfill] stopped: ${e.message}`); break; }
  if (!raw) { failed++; continue; }
  const rows = raw.filter(r => { const d = istDay(r.time * 1000); return d >= a && d < b; });
  store.saveOptions(UNDERLYING, code, side, off, a, b, rows); done++; rowsTotal += rows.length;
  if (n % 25 === 0 || rows.length === 0) console.log(`[backfill] ${n}/${jobs.length} ${label}: ${rows.length} rows (${Math.round((Date.now() - started) / 60_000)} min)`);
}
const s = store.summary();
console.log(`[backfill] finished in ${Math.round((Date.now() - started) / 60_000)} min: ${done} requests stored (${rowsTotal} rows), ${skipped} already stored, ${failed} failed (re-run to retry)`);
for (const o of s.options) console.log(`[backfill] options slot ${o.code}: ${o.rows} rows, ${istDay(o.first * 1000)} … ${istDay(o.last * 1000)}`);
store.close();
process.exit(0);
