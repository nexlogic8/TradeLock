// Saves every out-of-the-money strike of an index's live contracts (1-minute OHLC, volume, OI) into history.db
// (option_far_1m), so cheap far options (₹3) can be backtested. Dhan serves a contract's candles only while it trades
// (its expired-options API covers ATM ±10 at most), so this has to run every day; a missed day is fetched by the next
// run's look-back (--days). Resumable: each contract and date range is logged in far_fetch_log.
//
//   node server/src/workers/far-strikes.js [--underlying NIFTY] [--days 3] [--to YYYY-MM-DD] [--max-expiry-days 42]
//                                          [--itm 500] [--pause 400] [--refresh] [--force]
//   --days: today and the days before it (default 3); --max-expiry-days: contracts expiring within that many days;
//   --itm: also strikes up to this many points in the money; --refresh: fetch again even if logged (same-day data
//   can be incomplete right after the close); --force: run during market hours (normally refused, to keep Dhan's
//   data quota for live trading).
import { sharedSource } from '../modules/broker/market-data.js';
import { openHistory } from '../modules/backtest/history-store.js';
import { UNDERLYINGS } from '../modules/scalper/underlyings.js';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const has = name => process.argv.includes(`--${name}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const istDay = ms => new Date(ms + 19_800_000).toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const UNDERLYING = String(arg('underlying', 'NIFTY')).toUpperCase(), U = UNDERLYINGS[UNDERLYING];
if (!U) { console.error(`Unknown --underlying ${UNDERLYING}: use ${Object.keys(UNDERLYINGS).join(', ')}`); process.exit(1); }
const TO = arg('to', istDay(Date.now())), FROM = addDays(TO, -Number(arg('days', 3)) + 1);
const MAX_EXPIRY = addDays(TO, Number(arg('max-expiry-days', 42))), ITM = Number(arg('itm', 500)), PAUSE = Number(arg('pause', 400));
const marketHours = (now = Date.now()) => { const t = new Date(now + 19_800_000), hm = t.toISOString().slice(11, 16); return t.getUTCDay() >= 1 && t.getUTCDay() <= 5 && hm >= '09:00' && hm < '15:30'; };
const log = (...a) => console.log(`[far-strikes ${new Date().toISOString()}]`, ...a);

const keepAlive = setInterval(() => {}, 60_000);   // the broker transport can leave nothing on the event loop mid-request
const store = openHistory();
const done = store.db.prepare('SELECT 1 FROM far_fetch_log WHERE underlying = ? AND expiry = ? AND side = ? AND strike = ? AND from_day = ? AND to_day = ?');
const logged = store.db.prepare('INSERT OR REPLACE INTO far_fetch_log VALUES (?, ?, ?, ?, ?, ?, ?, ?)');

async function main() {
  if (marketHours() && !has('force')) { log('market hours: not running (use --force)'); return; }
  const a = sharedSource().adapter, scrip = Number(U.securityId);
  const expiries = (await a.optionExpiries({ underlyingScrip: scrip, underlyingSeg: 'IDX_I' })).filter(e => e >= FROM && e <= MAX_EXPIRY);
  log(`${UNDERLYING} ${FROM} … ${TO}, expiries ${expiries.join(' ')}`);
  let requests = 0, rows = 0, errors = 0;
  for (const exp of expiries) {
    await sleep(3_500);   // option chain: one request every 3 s
    const ch = await a.optionChain({ underlyingScrip: scrip, underlyingSeg: 'IDX_I', expiry: exp });
    const spot = Number(ch?.last_price), legs = [];
    for (const [k, v] of Object.entries(ch?.oc || {})) {
      const strike = Number(k);
      if (v.ce?.security_id && !(spot > 0 && strike < spot - ITM)) legs.push({ strike, side: 'CE', id: v.ce.security_id });
      if (v.pe?.security_id && !(spot > 0 && strike > spot + ITM)) legs.push({ strike, side: 'PE', id: v.pe.security_id });
    }
    log(`${exp}: ${legs.length} contracts (spot ${spot})`);
    for (const L of legs) {
      if (!has('refresh') && done.get(UNDERLYING, exp, L.side, L.strike, FROM, TO)) continue;
      for (let tries = 0; tries < 3; tries++) {
        await sleep(PAUSE);
        try {
          const r = await a.intradayCandles({ securityId: L.id, exchangeSegment: U.optionSegment, instrument: 'OPTIDX', interval: '1', fromDate: `${FROM} 09:15:00`, toDate: `${TO} 15:30:00` });
          const d = r?.data || r || {}, t = d.timestamp || [];
          store.saveFar(UNDERLYING, exp, L.side, L.strike, t.map((time, i) => ({ time: Number(time), open: d.open[i], high: d.high[i], low: d.low[i], close: d.close[i], volume: d.volume?.[i], oi: d.open_interest?.[i] })));
          logged.run(UNDERLYING, exp, L.side, L.strike, FROM, TO, t.length, Date.now());
          requests++; rows += t.length; break;
        } catch (e) { errors++; log(`error ${exp} ${L.side} ${L.strike}: ${e.message}`); await sleep(3_000); }
      }
    }
  }
  log(`done: ${requests} requests, ${rows} candles, ${errors} errors`);
}

main().catch(e => { log('failed:', e.message); process.exitCode = 1; }).finally(() => { clearInterval(keepAlive); store.close(); });
