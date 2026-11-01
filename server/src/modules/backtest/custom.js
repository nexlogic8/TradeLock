// "My strategies" backtest: a user's saved strategy (strategy/service.js) replayed on the local 1-minute history
// (history.db), so it runs in seconds and never calls Dhan. NIFTY only (the stored history).
//   Bars: NIFTY 1-minute candles grouped into the strategy's timeframe (1 / 3 / 5 / 15 minutes from 09:15).
//   Entry rules, checked on each completed bar (long → buy the ATM CE, short → the ATM PE):
//     ema       fast EMA above the slow EMA (long) / below (short), seeded across sessions as on the chart
//     vwap      close above the session VWAP (long) / below (short); the index has no volume, so its VWAP is the
//               session's running average of (high + low + close) / 3
//     rsi       RSI 14 at or above the minimum (long) / at or below 100 − minimum (short)
//     breakout  close above the highest high of the previous N bars (long) / below the lowest low (short)
//     volume    not applied: the index has no volume
//   A signal is the bar on which all the switched-on rules become true together (they were not all true on the bar
//   before), so a crossover strategy enters on the cross, not on every bar after it.
//   Fill: the option's open in the minute after the signal bar closes, + slippage; the strike is the nearest-weekly
//   ATM at that minute and stays fixed for the trade.
//   Stop / target / trailing: on the option premium (default) or on the NIFTY index (setting `measure`).
//     Stop % or ₹ (₹ = the loss on the whole quantity), target R × the risk or %, trailing % below the best price.
//     Checked every minute; the stop wins when both are touched in the same minute. Premium levels fill at the level
//     (or the minute's open past it); index levels fill at the option's close of the minute the index reaches them.
//   Exit also on the opposite signal (setting, on by default: the position is reversed) and at the square-off.
//   One trade at a time, at most `maxTrades` a day. Charges as on each date (orb5-options.js), brokerage per order.
import { Worker } from 'node:worker_threads';
import { openHistory } from './history-store.js';
import { optionCharges } from '../scalper/orb5-options.js';
import { niftyLotSize } from '../scalper/option-backtest.js';

export const CUSTOM_DEFAULTS = Object.freeze({ lots: 1, slippage: 0.5, brokeragePerOrder: 15, measure: 'premium', oppositeExit: true, maxTrades: 100 });
// Built-in strategies offered next to the user's own (ids are strings; saved strategies have numeric ids).
// stopMode / targetMode 'none': no stop / no target, the trade ends on the opposite signal or the square-off.
const crossover = (name, emaFast, emaSlow) => ({ name, market: 'fo', timeframe: '1m', direction: 'both',
  entries: { vwap: false, ema: true, rsi: false, breakout: false, volume: false, emaFast, emaSlow, rsiMin: 55, breakoutBars: 20, volumeMultiple: 1.5 },
  exits: { stopMode: 'none', stopValue: 0, targetMode: 'none', targetValue: 0, trailing: false, trailValue: 0.5, squareOff: '15:15' } });
export const CUSTOM_BUILT_IN = Object.freeze({
  ema59: crossover('EMA 5/9 crossover 1m (built-in)', 5, 9),
  ema35: { name: 'EMA 3/5 crossover 1m (built-in)', market: 'fo', timeframe: '1m', direction: 'both',
    entries: { vwap: false, ema: true, rsi: false, breakout: false, volume: false, emaFast: 3, emaSlow: 5, rsiMin: 55, breakoutBars: 20, volumeMultiple: 1.5 },
    exits: { stopMode: 'none', stopValue: 0, targetMode: 'none', targetValue: 0, trailing: false, trailValue: 0.5, squareOff: '15:15' } },
});
export const CUSTOM_TIMEFRAMES = Object.freeze({ '1m': 1, '3m': 3, '5m': 5, '15m': 15 });

const TICK = 0.05, UNDERLYING = 'NIFTY';
const sec = day => Date.parse(`${day}T00:00:00+05:30`) / 1000;
const OPEN_S = (9 * 60 + 15) * 60, CLOSE_S = (15 * 60 + 30) * 60;
const inSession = t => { const s = (t + 19_800) % 86_400; return s >= OPEN_S && s < CLOSE_S; };
const dayOf = s => new Date(s * 1000 + 19_800_000).toISOString().slice(0, 10);
const hm = s => new Date(s * 1000 + 19_800_000).toISOString().slice(11, 16);
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const tick = x => Math.round(x / TICK) * TICK;
const r2 = x => Math.round(x * 100) / 100;

/** The same in a worker thread, so a long run never holds up the server (live Algo Trading shares its event loop). */
export function customBacktestInWorker(params) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./custom-worker.js', import.meta.url), { workerData: params });
    w.once('message', m => (m.error ? reject(Object.assign(new Error(m.error), { code: m.code })) : resolve(m.result)));
    w.once('error', reject);
    w.once('exit', c => c && reject(new Error(`Backtest worker stopped (code ${c})`)));
  });
}

/** Run `strategy` (a normalized saved strategy) from startDate to endDate (IST days). `store` defaults to data/history.db. */
export function customBacktest({ startDate, endDate, strategy, ...options }, store) {
  const own = !store; store ||= openHistory();
  try { return run(store, startDate, endDate, strategy, { ...CUSTOM_DEFAULTS, ...options }); }
  finally { if (own) store.close(); }
}

/** Bars of `tf` minutes from each session's 1-minute candles: { time (bucket start), last (its last minute), open, high, low, close, day }. */
export function groupBars(oneMinute, tf) {
  const out = [];
  for (const c of oneMinute) {
    const d = dayOf(c.time), start = sec(d) + OPEN_S, bucket = start + Math.floor((c.time - start) / (tf * 60)) * tf * 60, b = out.at(-1);
    if (b && b.time === bucket) { b.high = Math.max(b.high, c.high); b.low = Math.min(b.low, c.low); b.close = c.close; b.last = c.time; }
    else out.push({ time: bucket, last: c.time, open: c.open, high: c.high, low: c.low, close: c.close, day: d });
  }
  return out;
}
const emaOf = (xs, n) => { const k = 2 / (n + 1); let e = null; return xs.map(x => (e = e == null ? x : x * k + e * (1 - k))); };
function rsiOf(closes, n = 14) {
  let gain = 0, loss = 0;
  return closes.map((x, i) => {
    if (i === 0) return null;
    const ch = x - closes[i - 1], g = Math.max(0, ch), l = Math.max(0, -ch);
    if (i <= n) { gain += g; loss += l; if (i < n) return null; gain /= n; loss /= n; }
    else { gain = (gain * (n - 1) + g) / n; loss = (loss * (n - 1) + l) / n; }
    return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  });
}
/** For each bar: whether the switched-on rules all point long / short. */
export function ruleStates(bars, strategy) {
  const e = strategy.entries, closes = bars.map(b => b.close);
  const fast = e.ema ? emaOf(closes, e.emaFast) : null, slow = e.ema ? emaOf(closes, e.emaSlow) : null, rsi = e.rsi ? rsiOf(closes) : null;
  let day = '', sum = 0, n = 0;
  const vwap = bars.map(b => { if (b.day !== day) { day = b.day; sum = 0; n = 0; } sum += (b.high + b.low + b.close) / 3; n++; return sum / n; });
  return bars.map((b, i) => {
    let long = true, short = true;
    if (e.ema) { long &&= fast[i] > slow[i]; short &&= fast[i] < slow[i]; }
    if (e.vwap) { long &&= b.close > vwap[i]; short &&= b.close < vwap[i]; }
    if (e.rsi) { const r = rsi[i]; long &&= r != null && r >= e.rsiMin; short &&= r != null && r <= 100 - e.rsiMin; }
    if (e.breakout) {
      const from = i - e.breakoutBars;
      if (from < 0) { long = false; short = false; }
      else { let hi = -Infinity, lo = Infinity; for (let j = from; j < i; j++) { hi = Math.max(hi, bars[j].high); lo = Math.min(lo, bars[j].low); } long &&= b.close > hi; short &&= b.close < lo; }
    }
    if (strategy.direction === 'long') short = false;
    if (strategy.direction === 'short') long = false;
    return { long, short, fast: fast?.[i], slow: slow?.[i], vwap: vwap[i], rsi: rsi?.[i] };
  });
}

function run(store, startDate, endDate, strategy, s) {
  const tf = CUSTOM_TIMEFRAMES[strategy.timeframe];
  const e = strategy.entries;
  // Warm-up: 10 calendar days before the start seed the EMAs / RSI / breakout lookback.
  const idx = store.index(UNDERLYING, sec(addDays(startDate, -10)), sec(addDays(endDate, 1))).filter(c => inSession(c.time));
  const bars = groupBars(idx, tf), states = ruleStates(bars, strategy);
  const minute = new Map(idx.map(c => [c.time, c]));
  const q = {
    atm: store.db.prepare('SELECT strike, open FROM option_1m WHERE underlying = ? AND expiry_code = 1 AND side = ? AND offset = 0 AND time = ?'),
    day: store.db.prepare('SELECT time, open, high, low, close FROM option_1m WHERE underlying = ? AND expiry_code = 1 AND side = ? AND strike = ? AND time >= ? AND time < ? ORDER BY time'),
  };
  // Signals on completed bars inside the range, before the square-off.
  const signals = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], st = states[i], prev = states[i - 1];
    if (b.day < startDate || b.day > endDate || hm(b.last + 60) >= strategy.exits.squareOff) continue;
    const dir = st.long && !prev.long ? 'CE' : st.short && !prev.short ? 'PE' : null;
    if (dir) signals.push({ day: b.day, at: b.last + 60, barTime: b.time, side: dir, spot: b.close, fast: st.fast, slow: st.slow, vwap: st.vwap, rsi: st.rsi });
  }
  const byDay = new Map();
  for (const x of signals) { if (!byDay.has(x.day)) byDay.set(x.day, []); byDay.get(x.day).push(x); }
  const trades = [], skipped = [], x = strategy.exits;
  let cum = 0, peak = 0, maxDrawdown = 0;
  const equity = [];
  for (const [d, list] of byDay) {
    const close = sec(d) + CLOSE_S, sqAt = sec(d) + Number(x.squareOff.slice(0, 2)) * 3600 + Number(x.squareOff.slice(3)) * 60;
    let k = 0, entries = 0, nextFree = 0;
    while (k < list.length) {
      const sig = list[k++];
      if (sig.at < nextFree) continue;                    // a position was still open then
      if (entries >= s.maxTrades) { skipped.push({ day: d, at: sig.at, side: sig.side, reason: `max ${s.maxTrades} trades a day` }); continue; }
      const atm = q.atm.get(UNDERLYING, sig.side, sig.at);
      if (!atm) { skipped.push({ day: d, at: sig.at, side: sig.side, reason: 'option price missing' }); continue; }
      const rows = q.day.all(UNDERLYING, sig.side, atm.strike, sig.at, close), lotSize = niftyLotSize(d), qty = s.lots * lotSize;
      if (!rows.length || rows[0].time !== sig.at) { skipped.push({ day: d, at: sig.at, side: sig.side, reason: 'option price missing' }); continue; }
      const entry = r2(tick(rows[0].open + s.slippage)), idxEntry = minute.get(sig.at)?.open ?? sig.spot;
      // Levels: on the premium (price p) or on the index (CE gains when NIFTY rises, PE when it falls).
      const onIndex = s.measure === 'index' && x.stopMode === 'percent', dirSign = sig.side === 'CE' ? 1 : -1;
      const base = onIndex ? idxEntry : entry;
      const riskPts = x.stopMode === 'none' ? Infinity : x.stopMode === 'amount' ? x.stopValue / qty : base * x.stopValue / 100;
      const targetPts = x.targetMode === 'none' ? Infinity : x.targetMode === 'rr' ? riskPts * x.targetValue : base * x.targetValue / 100;
      // Levels in "favourable" units: the premium, or dirSign × the index (higher is better either way).
      const start = onIndex ? dirSign * idxEntry : entry;
      let stop = start - riskPts, best = start, exit = null;
      const target = start + targetPts, opp = list.filter(o => o.at > sig.at && o.side !== sig.side), oppAt = s.oppositeExit && opp.length ? opp[0].at : Infinity;
      if (!onIndex && Number.isFinite(stop) && stop < TICK) stop = TICK;
      for (let j = 0; j < rows.length; j++) {
        const r = rows[j], c = minute.get(r.time);
        if (r.time >= sqAt) { exit = { price: r.open, at: r.time, reason: `Square-off ${x.squareOff}` }; break; }
        if (r.time >= oppAt) { exit = { price: r.open, at: r.time, reason: 'Opposite signal' }; break; }
        if (onIndex && !c) continue;
        const lo = onIndex ? Math.min(dirSign * c.high, dirSign * c.low) : r.low, hi = onIndex ? Math.max(dirSign * c.high, dirSign * c.low) : r.high;
        const open = onIndex ? dirSign * c.open : r.open;
        if (lo <= stop) { exit = { price: onIndex ? r.close : Math.min(stop, open), at: r.time, reason: x.trailing && stop > start - riskPts ? 'Trailing stop' : 'Stop-loss' }; break; }
        if (hi >= target) { exit = { price: onIndex ? r.close : Math.max(target, open), at: r.time, reason: 'Target' }; break; }
        if (x.trailing) { best = Math.max(best, hi); stop = Math.max(stop, onIndex ? best - Math.abs(best) * x.trailValue / 100 : best * (1 - x.trailValue / 100)); }
      }
      if (!exit) { const last = rows.at(-1); exit = { price: last.close, at: last.time, reason: 'Session end (option data stops)' }; }
      if (!(exit.price > 0)) { skipped.push({ day: d, at: sig.at, side: sig.side, reason: 'exit price missing' }); continue; }
      const gross = (exit.price - entry) * qty, charges = optionCharges(d, entry * qty, exit.price * qty, { brokeragePerOrder: s.brokeragePerOrder }).total, net = r2(gross - charges);
      cum = r2(cum + net); peak = Math.max(peak, cum); maxDrawdown = Math.max(maxDrawdown, peak - cum);
      entries++;
      trades.push({ day: d, side: sig.side, strike: atm.strike, signalAt: sig.at - 60, spot: r2(sig.spot), entryAt: sig.at, entry, stop: onIndex || !Number.isFinite(riskPts) ? null : r2(Math.max(TICK, start - riskPts)),
        target: onIndex || !Number.isFinite(target) ? null : r2(target), exitAt: exit.at, exit: r2(exit.price), exitReason: exit.reason, lots: s.lots, lotSize, qty,
        gross: r2(gross), charges: r2(charges), net, cumulative: cum });
      equity.push({ time: exit.at, value: cum });
      // An opposite-signal exit reverses: that signal is next in the list and enters at the same minute.
      nextFree = exit.reason === 'Opposite signal' ? exit.at : exit.at + 1;
    }
  }
  const wins = trades.filter(t => t.net > 0), losses = trades.filter(t => t.net <= 0), sum = a => r2(a.reduce((acc, t) => acc + t.net, 0));
  const reasons = {}; for (const t of trades) reasons[t.exitReason.startsWith('Square-off') ? 'Square-off' : t.exitReason] = (reasons[t.exitReason.startsWith('Square-off') ? 'Square-off' : t.exitReason] || 0) + 1;
  const days = {};
  for (const t of trades) { const r = (days[t.day] ??= { day: t.day, trades: 0, wins: 0, net: 0, charges: 0 }); r.trades++; if (t.net > 0) r.wins++; r.net = r2(r.net + t.net); r.charges = r2(r.charges + t.charges); }
  const sessions = new Set(idx.map(c => dayOf(c.time)).filter(d => d >= startDate && d <= endDate));
  const notes = [];
  if (e.volume) notes.push('Volume rule not applied: the NIFTY index has no volume.');
  if (strategy.market === 'equity') notes.push('Saved for equity; tested on NIFTY options (the stored history).');
  if (s.measure === 'index' && x.stopMode === 'amount') notes.push('A ₹ stop is always on the premium (the whole quantity).');
  return {
    strategy, settings: s, sessions: sessions.size, signals: signals.length,
    oneMinuteBars: idx.filter(c => { const d = dayOf(c.time); return d >= startDate && d <= endDate; }).length,
    summary: { trades: trades.length, wins: wins.length, winRate: trades.length ? wins.length / trades.length * 100 : 0, net: sum(trades),
      gross: r2(trades.reduce((a, t) => a + t.gross, 0)), charges: r2(trades.reduce((a, t) => a + t.charges, 0)),
      averageWin: wins.length ? sum(wins) / wins.length : 0, averageLoss: losses.length ? sum(losses) / losses.length : 0,
      maxDrawdown: r2(maxDrawdown), best: trades.length ? Math.max(...trades.map(t => t.net)) : 0, worst: trades.length ? Math.min(...trades.map(t => t.net)) : 0,
      exitReasons: reasons, skipped: skipped.length },
    days: Object.values(days), trades, skipped, equityCurve: equity, notes,
  };
}
