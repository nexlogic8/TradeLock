// Gap open 09:15 backtest: the live Algo Trading strategy (scalper/autotrade.js) replayed on the local 1-minute
// history (history.db), so it runs in seconds and never calls Dhan.
//   Signal: the ATM CE and PE at 09:15 (Dhan's nearest-expiry ATM). The side whose premium opened above its
//     previous close (gap up) and closed its first minute green is bought; both or neither → no trade.
//   Size: FUNDS_USE % of capital in whole lots (optional lot cap); compounding or fixed capital.
//   Stop: DAILY_SL % of capital ÷ quantity below the entry, rounded up to a tick (as live); a stop under
//     MIN_STOP_PCT % of the premium → no trade. Hit when the option's 1-minute low reaches it.
//   Exit: the next minute's open after the first opposite-colour NIFTY 1-minute candle (the entry candle counts),
//     the stop, or the square-off. Charges as on each date; SLIPPAGE ₹ a unit on the entry.
//   EXIT_CANDLE '5m': the first completed opposite-colour 5-minute candle (09:15–09:19, 09:20–09:24, …; the one the
//     entry is in counts) instead of the 1-minute one; stop, cost to cost and square-off are still checked each minute.
//   EXIT_CANDLE '0916': a fixed exit one minute after the entry, whatever the candle colour: at the 09:16 open (the worst
//     case, filled at 09:16, at the 09:17 open); the stop still applies inside that minute.
//   STRIKE: which strike of the chosen side is traded, in steps from the ATM: +1…+3 = ITM1…ITM3, −1…−3 = OTM1…OTM3
//     (CE: ITM is below the ATM, PE: above it). The signal is still the ATM premiums' gap (as live); the strike is
//     fixed at 09:15 and kept for the trade.
//   Cost to cost (COST_TO_COST_R > 0, as live): after a minute whose option high reaches entry + R × (entry − stop),
//     the stop is the entry price from the next minute on (1-minute data cannot order the moves inside a minute).
// 1-minute candles cannot show the first 2 seconds, so every run gives two bounds:
//   best  = entry at the option's 09:15 open + LATE_ENTRY_PCT % (a live market order fills during the 09:15 spike: the
//           two live fills so far were 2.1% and 8.9% above the open), colour from the whole first minute
//   worst = entry at the 09:16 open, after that minute is known; exits counted from 09:16
import { Worker } from 'node:worker_threads';
import { openHistory } from './history-store.js';
import { optionCharges } from '../scalper/orb5-options.js';
import { lotSizeOn, indexExpiry } from '../scalper/option-backtest.js';

export const GAP_DEFAULTS = Object.freeze({ underlying: 'NIFTY', capital: 100000, compound: true, fundsUse: 90, dailySlPct: 20, lotCap: 0, slippage: 1, squareOff: '15:15', minStopPct: 1, costToCostR: 1, exitCandle: '0916', strike: 0, lateEntryPct: 5, minGapPts: 0, tradeAmount: 0, entryMode: 'open', retestMin: 15, retestSlPct: 5 });   // ENTRY_MODE 'open' (live: at 09:15) or 'retest' (a limit buy at the 09:15 open when the option comes back to it within RETEST_MIN minutes, stop RETEST_SL_PCT below)   // TRADE_AMOUNT: with fixed sizing, this many rupees a trade (0 = FUNDS_USE % of the starting capital)   // MIN_GAP_PTS: trade only when NIFTY opens at least this many points from the previous close (0 = any gap)   // exit at 09:16 any colour, as live (AUTO.gap.exitAt)   // cost to cost at 1R, as live (AUTO.costToCostR)
export const GAP_MODES = Object.freeze({ best: 'Late entry: fill above the 09:15 open', worst: 'Worst case: fill at the 09:16 open' });

const TICK = 0.05;
/** The stored-history index a run uses: NIFTY, BANKNIFTY or SENSEX (default NIFTY). */
export const BACKTEST_INDICES = ['NIFTY', 'BANKNIFTY', 'SENSEX'];
const indexKey = u => (BACKTEST_INDICES.includes(String(u || '').toUpperCase()) ? String(u).toUpperCase() : 'NIFTY');
const sec = day => Date.parse(`${day}T00:00:00+05:30`) / 1000;
// The session, 09:15–15:30 IST. Dhan pads older history with flat candles outside it (and a few after 15:30):
// only session candles count, for the 09:15 candle, the exit path and the previous close.
const OPEN_S = (9 * 60 + 15) * 60, CLOSE_S = (15 * 60 + 30) * 60;
const inSession = t => { const s = (t + 19_800) % 86_400; return s >= OPEN_S && s < CLOSE_S; };
const dayOf = s => new Date(s * 1000 + 19_800_000).toISOString().slice(0, 10);
const hm = s => new Date(s * 1000 + 19_800_000).toISOString().slice(11, 16);
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const tick = x => Math.round(x / TICK) * TICK;
const r2 = x => Math.round(x * 100) / 100;

/** First and last day with the index's 1-minute candles and its ATM options in the history store, or null. */
export function gapCoverage(store, underlying = 'NIFTY') {
  const UNDERLYING = indexKey(underlying);
  if (!store.db.prepare('SELECT 1 FROM option_1m WHERE underlying = ? LIMIT 1').get(UNDERLYING)) return null;
  const row = store.db.prepare('SELECT MIN(time) AS first, MAX(time) AS last FROM index_1m WHERE underlying = ?').get(UNDERLYING);
  return row?.first ? { from: dayOf(row.first), to: dayOf(row.last) } : null;
}

/** The same in a worker thread, so a long run never holds up the server (live Algo Trading shares its event loop). */
export function gapBacktestInWorker(params) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./gap-worker.js', import.meta.url), { workerData: params });
    w.once('message', m => (m.error ? reject(Object.assign(new Error(m.error), { code: m.code })) : resolve(m.result)));
    w.once('error', reject);
    w.once('exit', c => c && reject(new Error(`Backtest worker stopped (code ${c})`)));
  });
}

/** Run the backtest from startDate to endDate (IST days). `store` defaults to data/history.db. */
export function gapBacktest({ startDate, endDate, ...options }, store) {
  const own = !store; store ||= openHistory();
  try { return run(store, startDate, endDate, { ...GAP_DEFAULTS, ...options }); }
  finally { if (own) store.close(); }
}

function run(store, startDate, endDate, s) {
  const UNDERLYING = indexKey(s.underlying), label = UNDERLYING === 'BANKNIFTY' ? 'BANK NIFTY' : UNDERLYING;
  const idx = store.index(UNDERLYING, sec(addDays(startDate, -10)), sec(addDays(endDate, 1))).filter(c => inSession(c.time)), byDay = new Map();
  for (const c of idx) { const d = dayOf(c.time); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(c); }
  const days = [...byDay.keys()].sort();
  // Only the rows the rule needs (the ATM at 09:15, that strike's day, its previous close), not every strike.
  const q = {
    atm: store.db.prepare('SELECT side, strike, open, close FROM option_1m WHERE underlying = ? AND expiry_code = 1 AND side = ? AND offset = 0 AND time = ?'),
    lastAtm: store.db.prepare('SELECT close FROM option_1m WHERE underlying = ? AND expiry_code = 1 AND side = ? AND offset = 0 AND time >= ? AND time < ? ORDER BY time DESC LIMIT 1'),
    prev: store.db.prepare('SELECT close FROM option_1m WHERE underlying = ? AND expiry_code = ? AND side = ? AND strike = ? AND time >= ? AND time < ? ORDER BY time DESC LIMIT 1'),
    day: store.db.prepare('SELECT time, open, high, low, close FROM option_1m WHERE underlying = ? AND expiry_code = 1 AND side = ? AND strike = ? AND time >= ? AND time < ? ORDER BY time'),
    at: store.db.prepare('SELECT strike FROM option_1m WHERE underlying = ? AND expiry_code = 1 AND side = ? AND offset = ? AND time = ?'),
    // The stored strike of that contract nearest to `strike` in the session's last stored minute.
    near: store.db.prepare(`SELECT strike, close FROM option_1m WHERE underlying = ? AND expiry_code = ? AND side = ? AND time =
      (SELECT MAX(time) FROM option_1m WHERE underlying = ? AND expiry_code = ? AND side = ? AND time >= ? AND time < ?) ORDER BY ABS(strike - ?) LIMIT 1`),
  };
  // Dhan's history has ATM ±10 strikes (±3 for the next expiry), so after a big gap, or the day after an expiry, today's
  // ATM strike may not be stored for yesterday. Its close is then estimated from the nearest stored strike of the same
  // contract, on the high side: an option is worth at most the nearer strike's premium plus the strike difference when it
  // is deeper in the money, and at most the nearer strike's premium when it is further out of the money. A high previous
  // close makes "opened above the previous close" stricter, so the estimate can only drop a signal, never invent one.
  const prevClose = (code, side, strike, y) => {
    const from = sec(y) + OPEN_S, to = sec(y) + CLOSE_S;
    const p = q.prev.get(UNDERLYING, code, side, strike, from, to)?.close ?? null;
    if (p >= MIN_PREV) return { prev: p, estimated: false };
    const n = q.near.get(UNDERLYING, code, side, UNDERLYING, code, side, from, to, strike);
    if (!(n?.close >= MIN_PREV)) return { prev: null, estimated: false };
    const deeper = side === 'CE' ? n.strike - strike : strike - n.strike;   // > 0: today's strike is deeper in the money
    // The true close lies between the nearer strike's premium and that ± the strike difference (never under a tick).
    return { prev: r2(n.close + Math.max(0, deeper)), low: r2(Math.max(TICK, n.close + Math.min(0, deeper))), estimated: true, from: n.strike };
  };
  // The previous close must be today's own contract's. Slot 1 is the nearest weekly expiry on each day (NSE calendar:
  // Thursday, Tuesday from 1 Sep 2025, earlier for a holiday), so after an expiry today's slot-1 contract was
  // yesterday's slot 2. Matched by expiry date; no match → no previous close (that day is not traded). A guess from
  // the premiums (ATM CE + PE nearly worthless at the close) missed some expiries and read the expired contract's ₹0.05.
  const tradingDays = new Set(days);
  const expiryOf = (day, n) => indexExpiry(UNDERLYING, day, n, tradingDays).date;
  const prevSlot = (d, y) => { const e = expiryOf(d, 1); return e === expiryOf(y, 1) ? 1 : e === expiryOf(y, 2) ? 2 : null; };
  const MIN_PREV = 1;   // an ATM premium's close below ₹1 is a wrong contract, not a real close
  const book = Object.fromEntries(Object.keys(GAP_MODES).map(m => [m, { capital: s.capital, peak: s.capital, maxDrawdownPct: 0, trades: [], skipped: [], equity: [] }]));
  const decisions = [];
  for (let i = 1; i < days.length; i++) {
    const d = days[i]; if (d < startDate || d > endDate) continue;
    const D = byDay.get(d), t0 = D[0].time, y = days[i - 1], prevCode = prevSlot(d, y);
    // 5-minute candles of the day from its 1-minute ones (for EXIT_CANDLE '5m'): start of bucket -> { open, close, last }.
    const five = new Map(), bucketOf = time => time - ((time - t0) % 300);
    for (const c of D) { const k5 = bucketOf(c.time), b5 = five.get(k5); if (b5) { b5.close = c.close; b5.last = c.time; } else five.set(k5, { open: c.open, close: c.close, last: c.time }); }
    const sides = {};
    for (const side of ['CE', 'PE']) {
      const a = q.atm.get(UNDERLYING, side, t0); if (!a) continue;
      const pc = prevCode ? prevClose(prevCode, side, a.strike, y) : { prev: null, estimated: false }, prev = pc.prev;
      sides[side] = { strike: a.strike, prev, ...(pc.estimated ? { prevEstimated: true, prevLow: pc.low, prevFrom: pc.from } : {}), open: a.open, close: a.close, ok: prev > 0 && a.open > prev && a.close > a.open };
      // Estimated close: a gap up only against the low end of its range is uncertain (not traded, reported as such).
      sides[side].uncertain = !!pc.estimated && !sides[side].ok && a.open > pc.low && a.close > a.open;
    }
    // The index gap: today's 09:15 open against the previous session's last close, in points.
    const yd = byDay.get(y), indexGap = yd?.length ? r2(D[0].open - yd[yd.length - 1].close) : null;
    const small = s.minGapPts > 0 && !(Math.abs(indexGap) >= s.minGapPts);
    const ok = small ? [] : Object.keys(sides).filter(x => sides[x].ok);
    const decision = { day: d, ce: sides.CE || null, pe: sides.PE || null, indexGap, side: ok.length === 1 ? ok[0] : null,
      reason: small ? (indexGap == null ? `${label} previous close not found` : `${label} gap ${Math.abs(indexGap)} pts, below the ${s.minGapPts}-point threshold`)
        : !Object.keys(sides).length ? 'no option data'
        : Object.values(sides).some(x => x.prev == null) && !ok.length ? (prevCode ? 'previous close not in the stored history' : 'previous close not found (expiry rollover)') : ok.length > 1 ? 'both premiums gapped up green' : ok.length ? '' : Object.values(sides).some(x => x.uncertain) ? `gap uncertain: ${Object.keys(sides).filter(x => sides[x].uncertain).join(' and ')} previous close estimated (strike beyond the stored history)` : 'no premium gapped up and stayed green' };
    decisions.push(decision);
    if (!decision.side) continue;
    const side = decision.side, S = sides[side];
    // The traded strike: s.strike steps into the money (ITM: CE lower, PE higher) or out of it, at 09:15.
    const offset = (side === 'CE' ? -1 : 1) * (Number(s.strike) || 0);
    const strike = offset ? q.at.get(UNDERLYING, side, offset, t0)?.strike : S.strike;
    if (!strike) { for (const b of Object.values(book)) b.skipped.push({ day: d, reason: 'strike not in the stored history' }); continue; }
    const rows = new Map(q.day.all(UNDERLYING, side, strike, sec(d) + OPEN_S, sec(d) + CLOSE_S).map(r => [r.time, r]));
    // ENTRY_MODE 'retest': after the 09:15 spike, a limit buy at the option's 09:15 open, filled by the first minute
    // (09:16 on, within RETEST_MIN) whose low reaches it; no retest in time → no trade that day.
    const retest = s.entryMode === 'retest';
    let rk = -1, rFill = null;
    if (retest) {
      const level = rows.get(D[0].time)?.open;
      for (let j = 1; level > 0 && j < D.length && j <= s.retestMin; j++) {
        const r = rows.get(D[j].time);
        if (r && r.low <= level) { rk = j; rFill = Math.min(level, r.open); break; }
      }
      if (rk < 0) { for (const b of Object.values(book)) b.skipped.push({ day: d, reason: level > 0 ? `no retest of the 09:15 open ${level} within ${s.retestMin} min` : 'option price missing' }); continue; }
    }
    for (const [mode, b] of Object.entries(book)) {
      const k = retest ? rk : mode === 'best' ? 0 : 1, e = D[k] && rows.get(D[k].time);
      if (!e) { b.skipped.push({ day: d, reason: 'option price missing' }); continue; }
      const lotSize = lotSizeOn(UNDERLYING, d), entry = r2(tick((retest ? rFill : e.open * (k ? 1 : 1 + (Number(s.lateEntryPct) || 0) / 100)) + s.slippage)), basis = s.compound ? b.capital : s.capital;
      // Fixed sizing with a rupee amount: that much a trade, never more than the account holds that day.
      const spend = !s.compound && s.tradeAmount > 0 ? Math.min(s.tradeAmount, b.capital) : basis * s.fundsUse / 100;
      const lots = Math.min(Math.floor(spend / (entry * lotSize)), s.lotCap > 0 ? s.lotCap : Infinity);
      if (!(lots >= 1)) { b.skipped.push({ day: d, reason: 'capital too small for 1 lot' }); continue; }
      const qty = lots * lotSize, room = basis * s.dailySlPct / 100 / qty;
      if (room < entry * s.minStopPct / 100) { b.skipped.push({ day: d, reason: 'stop too tight' }); continue; }
      // Retest: the stop RETEST_SL_PCT below the entry, or closer when the day's stop-loss allows less.
      const stop = r2(Math.max(TICK, Math.ceil((retest ? Math.max(entry - room, entry * (1 - s.retestSlPct / 100)) : entry - room) / TICK - 1e-9) * TICK));
      let exit = null, stopNow = stop, atCost = false;
      const costAt = s.costToCostR > 0 ? entry + s.costToCostR * (entry - stop) : Infinity;
      for (let j = k; j < D.length; j++) {
        const c = D[j], r = rows.get(c.time);
        if (hm(c.time) >= s.squareOff) { exit = { price: r?.open ?? r?.close, at: c.time, reason: `Square-off ${s.squareOff}` }; break; }
        if (s.exitCandle === '0916' && j === k + 1) { exit = { price: r?.open ?? r?.close, at: c.time, reason: `Fixed exit ${hm(c.time)} (1 minute, any colour)` }; break; }
        // The retest's own minute: the fill came inside it, so 1-minute candles cannot tell whether its low came before or
        // after. Best case: stopped only when it closed below the stop; worst case: when its low reached it.
        const fillMinute = retest && j === k;
        if (fillMinute ? r && (mode === 'best' ? r.close : r.low) <= stopNow : r && r.low <= stopNow) {
          exit = { price: fillMinute ? stopNow : Math.min(stopNow, r.open), at: c.time, reason: atCost ? 'Stop at cost' : 'Stop-loss' }; break;
        }
        const b5 = s.exitCandle === '5m' ? five.get(bucketOf(c.time)) : null, bar = s.exitCandle === '0916' || fillMinute ? null : b5 ? (b5.last === c.time ? b5 : null) : c;
        if (bar && (side === 'CE' ? bar.close < bar.open : bar.close > bar.open)) {
          const n = D[j + 1], r1 = n && rows.get(n.time);
          exit = { price: r1?.open ?? r?.close, at: n?.time ?? c.time, reason: `First ${side === 'CE' ? 'red' : 'green'} ${b5 ? '5-min' : '1-min'} candle ${hm(b5 ? bucketOf(c.time) : c.time)}` }; break;
        }
        if (!atCost && r && r.high >= costAt) { atCost = true; stopNow = entry; }
      }
      if (!(exit?.price > 0)) { b.skipped.push({ day: d, reason: 'exit price missing' }); continue; }
      const gross = (exit.price - entry) * qty, charges = optionCharges(d, entry * qty, exit.price * qty).total, net = r2(gross - charges), before = b.capital;
      b.capital = r2(b.capital + net); b.peak = Math.max(b.peak, b.capital);
      b.maxDrawdownPct = Math.max(b.maxDrawdownPct, (b.peak - b.capital) / b.peak * 100);
      b.trades.push({ day: d, side, strike, prev: S.prev, ...(S.prevEstimated ? { prevEstimated: true } : {}), open: S.open, entryAt: D[k].time, entry, stop, exitAt: exit.at, exit: r2(exit.price), exitReason: exit.reason,
        lots, lotSize, qty, gross: r2(gross), charges: r2(charges), net, capitalBefore: before, capitalAfter: b.capital });
      b.equity.push({ time: exit.at, value: b.capital });
    }
  }
  const results = Object.fromEntries(Object.entries(book).map(([mode, b]) => {
    const t = b.trades, wins = t.filter(x => x.net > 0), losses = t.filter(x => x.net <= 0), months = {};
    for (const x of t) {
      const m = (months[x.day.slice(0, 7)] ??= { month: x.day.slice(0, 7), trades: 0, wins: 0, stops: 0, net: 0, start: x.capitalBefore, end: x.capitalAfter });
      m.trades++; if (x.net > 0) m.wins++; if (x.exitReason === 'Stop-loss') m.stops++; m.net = r2(m.net + x.net); m.end = x.capitalAfter;
    }
    const sum = a => r2(a.reduce((acc, x) => acc + x.net, 0));
    return [mode, { label: s.entryMode === 'retest' ? (mode === 'best' ? 'Retest: stopped in the fill minute only on a close below' : 'Retest: stopped in the fill minute on any touch') : mode === 'best' ? (s.lateEntryPct ? `Late entry: fill ${s.lateEntryPct}% above the 09:15 open` : 'Best case: fill at the 09:15 open') : GAP_MODES[mode], summary: { trades: t.length, wins: wins.length, winRate: t.length ? wins.length / t.length * 100 : 0,
      stops: t.filter(x => x.exitReason === 'Stop-loss').length, atCost: t.filter(x => x.exitReason === 'Stop at cost').length, startCapital: s.capital, endCapital: b.capital, net: sum(t),
      returnPct: (b.capital / s.capital - 1) * 100, maxDrawdownPct: b.maxDrawdownPct, charges: r2(t.reduce((a, x) => a + x.charges, 0)),
      averageWin: wins.length ? sum(wins) / wins.length : 0, averageLoss: losses.length ? sum(losses) / losses.length : 0, skipped: b.skipped.length },
      months: Object.values(months), trades: t, skipped: b.skipped, equityCurve: b.equity }];
  }));
  const bars = idx.filter(c => { const d = dayOf(c.time); return d >= startDate && d <= endDate; }).length;
  return { settings: s, sessions: decisions.length, signals: decisions.filter(x => x.side).length, oneMinuteBars: bars, days: decisions, ...results };
}
