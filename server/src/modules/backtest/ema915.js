// EMA 9/15 5m · 30° angle backtest: the live Algo Trading strategy (scalper/autotrade.js, EMA_TREND) replayed on the
// local 1-minute history (history.db), so it runs in seconds and never calls Dhan.
//   Candles: NIFTY 5-minute candles (09:15, 09:20, …) from the 1-minute ones; EMA 9, EMA 15 and ATR 14 (Wilder) run
//     across sessions, as on the chart and live.
//   Signal: EMA 9 above EMA 15 (CE) / below (PE), crossed today. Angle = atan(EMA 9's change over the candle ÷ ATR 14).
//     The first candle of the leg (the crossover candle or up to AFTER_CROSS candles after it) whose angle reaches
//     MIN_ANGLE is the signal; the leg is then used up, traded or not (as live: one trade per crossover).
//   Entry: the ATM option of the next expiry (slot 2) at the open of the minute the signal candle closes into,
//     + SLIPPAGE ₹ a unit. Not after LAST_ENTRY, and not while a trade is open (one at a time).
//   Stop: 1 tick below the option's own low during the 5-minute signal candle. Hit when a 1-minute low reaches it.
//   Cost to cost (COST_TO_COST_R > 0, as live): after a minute whose option high reaches entry + R × (entry − stop),
//     the stop is the entry price from the next minute on.
//   Exit: the next minute's open after the first opposite-colour 5-minute NIFTY candle that starts at or after the
//     entry (red for CE, green for PE), the stop, or the square-off. Charges as on each date.
import { Worker } from 'node:worker_threads';
import { openHistory } from './history-store.js';
import { optionCharges } from '../scalper/orb5-options.js';
import { lotSizeOn } from '../scalper/option-backtest.js';
import { BACKTEST_INDICES } from './gap.js';

// As EMA_TREND in scalper/autotrade.js (not imported: that module opens the database, and this runs in a worker).
const EMA_TREND = Object.freeze({ fast: 9, slow: 15, minAngle: 30, atrPeriod: 14, afterCross: 3 });
export const EMA915_DEFAULTS = Object.freeze({ lots: 1, slippage: 1, minAngle: EMA_TREND.minAngle, afterCross: EMA_TREND.afterCross, costToCostR: 1, lastEntry: '15:00', squareOff: '15:15' });

const TICK = 0.05, BAR = 300;
const sec = day => Date.parse(`${day}T00:00:00+05:30`) / 1000;
const OPEN_S = (9 * 60 + 15) * 60, CLOSE_S = (15 * 60 + 30) * 60;
const inSession = t => { const s = (t + 19_800) % 86_400; return s >= OPEN_S && s < CLOSE_S; };
const dayOf = s => new Date(s * 1000 + 19_800_000).toISOString().slice(0, 10);
const hm = s => new Date(s * 1000 + 19_800_000).toISOString().slice(11, 16);
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const r2 = x => Math.round(x * 100) / 100;

/** The same in a worker thread, so a long run never holds up the server (live Algo Trading shares its event loop). */
export function ema915BacktestInWorker(params) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./ema915-worker.js', import.meta.url), { workerData: params });
    w.once('message', m => (m.error ? reject(Object.assign(new Error(m.error), { code: m.code })) : resolve(m.result)));
    w.once('error', reject);
    w.once('exit', c => c && reject(new Error(`Backtest worker stopped (code ${c})`)));
  });
}

/** Run the backtest from startDate to endDate (IST days). `store` defaults to data/history.db. */
export function ema915Backtest({ startDate, endDate, ...options }, store) {
  const own = !store; store ||= openHistory();
  try { return run(store, startDate, endDate, { ...EMA915_DEFAULTS, ...options }); }
  finally { if (own) store.close(); }
}

function run(store, startDate, endDate, s) {
  const UNDERLYING = BACKTEST_INDICES.includes(s.underlying) ? s.underlying : 'NIFTY';
  // 10 days before the start seed the averages; 1-minute candles by day for the trade path.
  const idx = store.index(UNDERLYING, sec(addDays(startDate, -10)), sec(addDays(endDate, 1))).filter(c => inSession(c.time));
  const five = [], minutes = new Map();
  for (const c of idx) {
    const d = dayOf(c.time), b = sec(d) + OPEN_S + Math.floor(((c.time + 19_800) % 86_400 - OPEN_S) / BAR) * BAR, last = five.at(-1);
    if (last && last.time === b) { last.high = Math.max(last.high, c.high); last.low = Math.min(last.low, c.low); last.close = c.close; }
    else five.push({ time: b, day: d, open: c.open, high: c.high, low: c.low, close: c.close });
    if (!minutes.has(d)) minutes.set(d, []); minutes.get(d).push(c);
  }
  const ema = n => { const k = 2 / (n + 1); let v = null; return five.map(r => (v = v == null ? r.close : r.close * k + v * (1 - k))); };
  const fast = ema(EMA_TREND.fast), slow = ema(EMA_TREND.slow), atr = [];
  { let a = null; five.forEach((c, i) => { const pc = i ? five[i - 1].close : c.close, tr = Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc)); a = a == null ? tr : (a * (EMA_TREND.atrPeriod - 1) + tr) / EMA_TREND.atrPeriod; atr.push(a); }); }
  const angleAt = (i, side) => (atr[i] > 0 ? Math.atan((fast[i] - fast[i - 1]) / atr[i]) * 180 / Math.PI * side : 0);
  const fiveByTime = new Map(five.map(f => [f.time, f]));
  const q = {
    atm: store.db.prepare('SELECT strike FROM option_1m WHERE underlying = ? AND expiry_code = 2 AND side = ? AND offset = 0 AND time = ?'),
    rows: store.db.prepare('SELECT time, open, high, low, close FROM option_1m WHERE underlying = ? AND expiry_code = 2 AND side = ? AND strike = ? AND time >= ? AND time < ? ORDER BY time'),
  };
  const trades = [], skipped = [];
  let busyUntil = 0, legStart = null, legUsed = false, signals = 0, crossovers = 0, cum = 0, peak = 0, maxDrawdown = 0;
  for (let i = 1; i < five.length; i++) {
    const c = five[i], side = Math.sign(fast[i] - slow[i]);
    if (side !== Math.sign(fast[i - 1] - slow[i - 1])) { legStart = i; legUsed = false; if (side && c.day >= startDate && c.day <= endDate) crossovers++; }
    if (c.day < startDate || c.day > endDate) continue;
    if (!side || legStart == null || legUsed || five[legStart].day !== c.day || i - legStart > s.afterCross) continue;
    const angle = angleAt(i, side);
    if (!(angle >= s.minAngle)) continue;
    legUsed = true; signals++;
    const dir = side > 0 ? 'CE' : 'PE', at = c.time + BAR, base = { day: c.day, side: dir, signalAt: c.time, angle: r2(angle) };
    if (hm(at) >= s.lastEntry || at >= sec(c.day) + CLOSE_S) { skipped.push({ ...base, reason: `after the last entry time ${s.lastEntry}` }); continue; }
    if (at < busyUntil) { skipped.push({ ...base, reason: 'a trade was still open' }); continue; }
    const strike = q.atm.get(UNDERLYING, dir, at)?.strike;
    if (!strike) { skipped.push({ ...base, reason: 'ATM option not in the stored history' }); continue; }
    const R = q.rows.all(UNDERLYING, dir, strike, c.time, sec(c.day) + CLOSE_S), rows = new Map(R.map(r => [r.time, r]));
    const sig = R.filter(r => r.time < at), first = rows.get(at);
    if (!sig.length || !first) { skipped.push({ ...base, strike, reason: 'option price missing' }); continue; }
    const stop = r2(Math.max(TICK, Math.min(...sig.map(r => r.low)) - TICK)), entry = r2(first.open + s.slippage);
    if (!(entry > stop)) { skipped.push({ ...base, strike, reason: 'no room for the stop' }); continue; }
    const risk = entry - stop, costAt = s.costToCostR > 0 ? entry + s.costToCostR * risk : Infinity, path = minutes.get(c.day).filter(m => m.time >= at);
    let sl = stop, atCost = false, exit = null, lastClose = first.open;
    for (let j = 0; j < path.length; j++) {
      const m = path[j], r = rows.get(m.time);
      if (hm(m.time) >= s.squareOff) { exit = { price: r?.open ?? lastClose, at: m.time, reason: `Square-off ${s.squareOff}` }; break; }
      if (r && r.low <= sl) { exit = { price: Math.min(sl, r.open), at: m.time, reason: atCost ? 'Stop at cost' : 'Stop-loss' }; break; }
      if (r) lastClose = r.close;
      // This minute closed a 5-minute candle: opposite colour → out at the next minute's open.
      const f = (m.time + 60 - OPEN_S - sec(c.day)) % BAR === 0 ? fiveByTime.get(m.time + 60 - BAR) : null;
      if (f && f.time >= at && (dir === 'CE' ? f.close < f.open : f.close > f.open)) {
        const n = path[j + 1], r1 = n && rows.get(n.time);
        exit = { price: r1?.open ?? lastClose, at: n?.time ?? m.time, reason: `First ${dir === 'CE' ? 'red' : 'green'} 5-min candle ${hm(f.time)}` }; break;
      }
      if (!atCost && r && r.high >= costAt) { atCost = true; sl = entry; }
    }
    if (!exit) exit = { price: lastClose, at: path.at(-1)?.time ?? at, reason: 'Session close' };
    const lotSize = lotSizeOn(UNDERLYING, c.day), qty = s.lots * lotSize, gross = (exit.price - entry) * qty;
    const charges = optionCharges(c.day, entry * qty, exit.price * qty).total, net = r2(gross - charges);
    cum = r2(cum + net); peak = Math.max(peak, cum); maxDrawdown = Math.max(maxDrawdown, peak - cum);
    trades.push({ ...base, strike, entryAt: at, entry, stop, exitAt: exit.at, exit: r2(exit.price), exitReason: exit.reason, r: r2((exit.price - entry) / risk),
      lots: s.lots, lotSize, qty, gross: r2(gross), charges: r2(charges), net, cumulative: cum });
    busyUntil = exit.at;
  }
  const wins = trades.filter(x => x.net > 0), losses = trades.filter(x => x.net <= 0), sum = a => r2(a.reduce((acc, x) => acc + x.net, 0)), months = {};
  for (const x of trades) {
    const m = (months[x.day.slice(0, 7)] ??= { month: x.day.slice(0, 7), trades: 0, wins: 0, stops: 0, net: 0 });
    m.trades++; if (x.net > 0) m.wins++; if (x.exitReason === 'Stop-loss') m.stops++; m.net = r2(m.net + x.net);
  }
  const span = (sec(endDate) - sec(startDate)) / 86_400 + 1;
  const summary = { trades: trades.length, wins: wins.length, winRate: trades.length ? wins.length / trades.length * 100 : 0,
    stops: trades.filter(x => x.exitReason === 'Stop-loss').length, atCost: trades.filter(x => x.exitReason === 'Stop at cost').length,
    net: sum(trades), charges: r2(trades.reduce((a, x) => a + x.charges, 0)), averageTrade: trades.length ? sum(trades) / trades.length : 0,
    averageWin: wins.length ? sum(wins) / wins.length : 0, averageLoss: losses.length ? sum(losses) / losses.length : 0,
    averageR: trades.length ? trades.reduce((a, x) => a + x.r, 0) / trades.length : 0, maxDrawdown: r2(maxDrawdown),
    perMonth: trades.length / (span / 30.4), skipped: skipped.length };
  const oneMinuteBars = idx.filter(c => { const d = dayOf(c.time); return d >= startDate && d <= endDate; }).length;
  const sessions = [...minutes.keys()].filter(d => d >= startDate && d <= endDate).length;
  return { settings: s, sessions, crossovers, signals, oneMinuteBars, summary, months: Object.values(months), trades, skipped,
    equityCurve: trades.map(x => ({ time: x.exitAt, value: x.cumulative })) };
}
