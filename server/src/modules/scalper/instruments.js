// Dhan's instrument master is authoritative for lot and tick sizes; never guess them.
const INDEX_OPTIONS = new Set(['NSE:NIFTY', 'NSE:BANKNIFTY', 'BSE:SENSEX']);
// MCX commodities Power Scalper trades (scalper/underlyings.js MCX_UNDERLYINGS): their options and futures.
const MCX_SYMBOLS = new Set(['CRUDEOILM', 'GOLDM']);
const MCX_LINE = /,(CRUDEOILM|GOLDM),/;
const KINDS = new Set(['OPTIDX', 'OPTFUT', 'FUTCOM']);
let cache, pending;

function parseRows(csv, keep) {
  const split = line => (line.match(/("(?:[^"]|"")*"|[^,]*)(,|$)/g) || [])
    .map(s => s.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"').trim());
  const lines = csv.replace(/^﻿/, '').split(/\r?\n/);
  const headers = split(lines.shift());
  const out = [];
  for (const line of lines) {
    // Most of the master is not an index option or one of the MCX commodities: skip those rows before the (slow) cell
    // split, which otherwise held the event loop for seconds on every hourly refresh.
    if (!line.includes('OPTIDX') && !MCX_LINE.test(line)) continue;
    const cells = split(line), row = Object.fromEntries(headers.map((h,i) => [h,cells[i]]));
    if (!KINDS.has(row.INSTRUMENT) || !keep(row)) continue;
    // Dhan's detailed master publishes option ticks as paise
    // (for example, 5.0000 means ₹0.05). Convert to rupees before using it
    // for stop prices and risk sizing.
    const rawTickSize = Number(row.TICK_SIZE);
    const tickSize = rawTickSize >= 1 ? rawTickSize / 100 : rawTickSize;
    out.push({ exchange:row.EXCH_ID, underlying:row.UNDERLYING_SYMBOL, securityId:row.SECURITY_ID, instrument:row.INSTRUMENT, meta:{ lotSize: Number(row.LOT_SIZE), tickSize,
      expiry: row.SM_EXPIRY_DATE?.slice(0,10), strike: Number(row.STRIKE_PRICE), option: row.OPTION_TYPE } });
  }
  return out;
}
/** NIFTY options keyed by security id (the AI signal scan's view). */
export function parseInstruments(csv) {
  return new Map(parseRows(csv, row => row.INSTRUMENT === 'OPTIDX' && row.EXCH_ID === 'NSE' && row.UNDERLYING_SYMBOL === 'NIFTY').map(r => [r.securityId, r.meta]));
}
// The master is large: only the very first load waits for it. Later an hour-old copy is still served at
// once while a fresh one downloads in the background (lot sizes change rarely, and never mid-session).
async function load() {
  if (cache && Date.now() - cache.at < 3_600_000) return cache;
  if (cache) { refresh().catch(() => {}); return cache; }
  return refresh();
}
function refresh() {
  if (!pending) pending = (async () => {
    const response = await fetch('https://images.dhan.co/api-data/api-scrip-master-detailed.csv', { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error('Instrument lot and tick sizes are unavailable. Retry the signal scan.');
    const rows = parseRows(await response.text(), row => row.INSTRUMENT === 'OPTIDX' ? INDEX_OPTIONS.has(`${row.EXCH_ID}:${row.UNDERLYING_SYMBOL}`)
      : row.EXCH_ID === 'MCX' && MCX_SYMBOLS.has(row.UNDERLYING_SYMBOL));
    const options = rows.filter(r => r.instrument !== 'FUTCOM');
    const nifty = new Map(options.filter(r => r.exchange === 'NSE' && r.underlying === 'NIFTY').map(r => [r.securityId, r.meta]));
    if (!nifty.size) throw new Error('NIFTY instrument metadata is unavailable.');
    // NSE, BSE and MCX can reuse a numeric id, so the all-option map is keyed by exchange as well.
    const all = new Map(options.map(r => [`${r.exchange}:${r.securityId}`, { ...r.meta, underlying:r.underlying }]));
    // MCX futures per commodity, nearest expiry first: the underlying of its option chain.
    const futures = new Map();
    for (const r of rows.filter(x => x.instrument === 'FUTCOM')) {
      if (!futures.has(r.underlying)) futures.set(r.underlying, []);
      futures.get(r.underlying).push({ securityId:r.securityId, expiry:r.meta.expiry });
    }
    for (const list of futures.values()) list.sort((a, b) => a.expiry.localeCompare(b.expiry));
    cache = { nifty, all, futures, at: Date.now() };
    return cache;
  })().finally(() => { pending = null; });
  return pending;
}
export async function niftyInstruments() { return (await load()).nifty; }
/** NIFTY, BANKNIFTY (NSE), SENSEX (BSE) and the MCX commodities' options keyed by `${exchange}:${securityId}`. */
export async function indexOptionInstruments() { return (await load()).all; }
/** An MCX commodity's futures ({ securityId, expiry }), nearest expiry first. */
export async function mcxFutures(symbol) { return (await load()).futures.get(String(symbol).toUpperCase()) || []; }
