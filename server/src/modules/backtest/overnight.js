// "Overnight ATM CE + PE" backtest: buy the ATM call AND put (same quantity) near the close, sell both the next
// morning, so the position gains when the index opens with a big gap either way. Replayed on the near-ATM history
// (history.db option_1m: Dhan's expired-options data, nearest weekly expiry ATM ±10 strikes, the next one ±3), so it
// never calls Dhan.
//   Strikes: 'atm' = the ATM call and put at the entry minute (Dhan's ATM then); 'otm1' = one strike out of the money
//     on each side; 'itm1' = one strike in the money on each side.
//   Contract: the nearest weekly expiry. On its expiry day (it would expire at that close) the next one. On the night
//     before it expires (EXPIRY_EVE): 'skip' = no trade that night, 'next' = the next week's contract, 'hold' = hold it.
//   Buy: the close of the entry minute (+ SLIPPAGE). Sell: the open of the exit minute the next trading day, the same
//     strikes (else the first price within 15 minutes after it; none → the night is listed as not traded).
//   SKIP_BREAKS: no trade when the next session is not the next calendar day (weekends, holidays).
//   Sizing: FUNDS_USE % of the running capital (compound) or of the starting capital (fixed), whole lots.
//   Charges: as on the selling date, per option, plus the extra orders of quantity above the exchange's per-order limit.
import { Worker } from 'node:worker_threads';
import { openHistory } from './history-store.js';
import { optionCharges } from '../scalper/orb5-options.js';
import { lotSizeOn, indexExpiry } from '../scalper/option-backtest.js';
import { BACKTEST_INDICES } from './gap.js';

export const OVERNIGHT_DEFAULTS = Object.freeze({ strikes: 'atm', entryTime: '15:25', exitTime: '09:45', expiryEve: 'skip', skipBreaks: true,
  capital: 50000, fundsUse: 100, sizing: 'compound', slippage: 0 });
const FREEZE = { NIFTY: 1800, BANKNIFTY: 600, SENSEX: 1000 };
const BROKERAGE = 20, EXIT_LATE = 15 * 60;
const OFFSETS = Array.from({ length: 21 }, (_, i) => i - 10).join(',');

const sec = day => Date.parse(`${day}T00:00:00+05:30`) / 1000;
const at = (day, hhmm) => Date.parse(`${day}T${hhmm}:00+05:30`) / 1000;
const dayOf = s => new Date(s * 1000 + 19_800_000).toISOString().slice(0, 10);
const hm = s => new Date(s * 1000 + 19_800_000).toISOString().slice(11, 16);
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const r2 = x => Math.round(x * 100) / 100;

export function overnightBacktestInWorker(params) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./overnight-worker.js', import.meta.url), { workerData: params });
    w.once('message', m => (m.error ? reject(Object.assign(new Error(m.error), { code: m.code })) : resolve(m.result)));
    w.once('error', reject);
    w.once('exit', c => c && reject(new Error(`Backtest worker stopped (code ${c})`)));
  });
}

export function overnightBacktest({ startDate, endDate, ...options }, store) {
  const own = !store; store ||= openHistory();
  try { return run(store, startDate, endDate, { ...OVERNIGHT_DEFAULTS, ...options }); }
  finally { if (own) store.close(); }
}

function run(store, startDate, endDate, s) {
  const U = BACKTEST_INDICES.includes(s.underlying) ? s.underlying : 'NIFTY';
  // A week past the end too: the last night sells on the next session.
  const idx = store.index(U, sec(startDate), sec(addDays(endDate, 8)));
  const sessions = new Map();
  for (const c of idx) { const d = dayOf(c.time), h = hm(c.time); if (h < '09:15' || h >= '15:30') continue; if (!sessions.has(d)) sessions.set(d, []); sessions.get(d).push(c); }
  const days = [...sessions.keys()].sort(), tradingDays = new Set(days);
  const expiry = (day, n) => indexExpiry(U, day, n, tradingDays).date;
  const atMinute = store.db.prepare(`SELECT strike, offset, open, close FROM option_1m
    WHERE underlying = ? AND expiry_code = ? AND side = ? AND offset IN (${OFFSETS}) AND time = ?`);
  const strikeFrom = store.db.prepare(`SELECT time, strike, open, close FROM option_1m
    WHERE underlying = ? AND expiry_code = ? AND side = ? AND offset IN (${OFFSETS}) AND time >= ? AND time <= ? ORDER BY time`);
  const [ceOff, peOff] = s.strikes === 'otm1' ? [1, -1] : s.strikes === 'itm1' ? [-1, 1] : [0, 0];
  const trades = [], skipped = [];
  let equity = s.capital, peak = equity, maxDrawdownPct = 0, nights = 0, oneMinuteBars = 0;
  const skip = (day, reason) => skipped.push({ day, reason });

  for (let i = 0; i < days.length; i++) {
    const D = days[i], N = days[i + 1];
    if (D < startDate || D > endDate) continue;
    nights++; oneMinuteBars += sessions.get(D).length;
    if (!N) { skip(D, 'the next session is not in the history yet'); continue; }
    if (s.skipBreaks && addDays(D, 1) !== N) { skip(D, `the next session is ${N} (weekend or holiday): not held`); continue; }
    const eve = expiry(D, 1) === N;
    if (eve && s.expiryEve === 'skip') { skip(D, `the nearest contract expires on ${N}: night skipped`); continue; }
    // Slot at D: 1 = nearest; 2 on its expiry day (it expires at this close) or, by choice, on the eve of its expiry.
    const code = expiry(D, 1) === D || (eve && s.expiryEve === 'next') ? 2 : 1;
    const E = expiry(D, code), codeN = expiry(N, 1) === E ? 1 : expiry(N, 2) === E ? 2 : null;
    const tB = at(D, s.entryTime);
    const ce = atMinute.all(U, code, 'CE', tB).find(r => r.offset === ceOff), pe = atMinute.all(U, code, 'PE', tB).find(r => r.offset === peOff);
    if (!ce || !pe) { skip(D, `no stored ${!ce && !pe ? 'call or put' : !ce ? 'call' : 'put'} price at ${s.entryTime}`); continue; }
    if (!codeN) { skip(D, `the ${E} contract is not in the stored slots on ${N}`); continue; }
    const tX = at(N, s.exitTime);
    const exitOf = (side, strike) => {
      const r = strikeFrom.all(U, codeN, side, tX, tX + EXIT_LATE).find(x => x.strike === strike);
      return r ? { price: r.open, at: r.time } : null;
    };
    const xc = exitOf('CE', ce.strike), xp = exitOf('PE', pe.strike);
    if (!xc || !xp) { skip(D, `no ${!xc ? `${ce.strike} CE` : `${pe.strike} PE`} price on ${N} ${s.exitTime}–${hm(tX + EXIT_LATE)} (the index moved beyond the stored strikes)`); continue; }

    const lotSize = lotSizeOn(U, D), ceIn = r2(ce.close + s.slippage), peIn = r2(pe.close + s.slippage), perLot = (ceIn + peIn) * lotSize;
    const base = s.sizing === 'fixed' ? s.capital : equity, lots = Math.floor((base * s.fundsUse / 100) / perLot);
    if (lots < 1) { skip(D, `₹${Math.round(base * s.fundsUse / 100)} buys no lot of both (₹${Math.round(perLot)} a lot)`); continue; }
    const qty = lots * lotSize, orders = Math.ceil(qty / (FREEZE[U] || 1800));
    let gross = 0, charges = 0;
    const leg = (L, entry, x) => {
      const buy = entry * qty, sell = x.price * qty;
      gross += sell - buy;
      charges += optionCharges(N, buy, sell).total + (orders - 1) * 2 * BROKERAGE * 1.18;
      return { strike: L.strike, entryAt: tB, entry, exitAt: x.at, exit: r2(x.price), pct: r2((x.price / entry - 1) * 100) };
    };
    const ceLeg = leg(ce, ceIn, xc), peLeg = leg(pe, peIn, xp), net = r2(gross - charges), before = equity;
    equity = r2(equity + net); peak = Math.max(peak, equity); maxDrawdownPct = Math.max(maxDrawdownPct, (peak - equity) / peak * 100);
    const dBars = sessions.get(D), nBars = sessions.get(N), close = dBars.filter(b => b.time <= tB).at(-1)?.close ?? dBars.at(-1).close;
    trades.push({ day: D, next: N, expiry: E, index: [close, nBars.filter(b => b.time <= tX).at(-1)?.close ?? nBars[0].open],
      gap: r2(nBars[0].open - dBars.at(-1).close), ce: ceLeg, pe: peLeg, lots, lotSize, qty, orders, invested: r2(perLot * lots),
      gross: r2(gross), charges: r2(charges), net, dayPct: r2(net / before * 100), capitalAfter: equity });
  }

  const wins = trades.filter(x => x.net > 0), sum = a => r2(a.reduce((acc, x) => acc + x.net, 0)), months = {};
  for (const x of trades) {
    const m = (months[x.day.slice(0, 7)] ??= { month: x.day.slice(0, 7), days: 0, wins: 0, net: 0, startCapital: r2(x.capitalAfter - x.net) });
    m.days++; if (x.net > 0) m.wins++; m.net = r2(m.net + x.net); m.endCapital = x.capitalAfter;
  }
  let runL = 0, worstRun = 0; for (const x of trades) { runL = x.net <= 0 ? runL + 1 : 0; worstRun = Math.max(worstRun, runL); }
  const summary = { sessions: nights, traded: trades.length, wins: wins.length, winRate: trades.length ? wins.length / trades.length * 100 : 0,
    net: sum(trades), charges: r2(trades.reduce((a, x) => a + x.charges, 0)), startCapital: s.capital, endCapital: equity,
    returnPct: r2((equity / s.capital - 1) * 100), bestDayPct: trades.length ? Math.max(...trades.map(x => x.dayPct)) : 0,
    worstDayPct: trades.length ? Math.min(...trades.map(x => x.dayPct)) : 0, maxDrawdownPct: r2(maxDrawdownPct), longestLosingRun: worstRun,
    skipped: skipped.length };
  return { settings: { ...s, underlying: U }, sessions: nights, signals: trades.length, oneMinuteBars, summary, months: Object.values(months), trades, skipped,
    equityCurve: trades.map(x => ({ time: x.ce.exitAt, value: x.capitalAfter })) };
}
