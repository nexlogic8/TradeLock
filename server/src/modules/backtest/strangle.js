// "CE + PE at a target price" backtest: every day buy the call AND the put whose premium is closest to a target
// (₹3 on NIFTY, ₹100 on SENSEX, …) at the entry time, hold both until the exit time, with an optional stop on each
// option or on the two together. Replayed on the local 1-minute history (history.db), so it never calls Dhan.
//   Strike: the stored strikes of the chosen expiry (slot 1 = nearest weekly keeps ATM ±10; slot 2 only ±3), the one
//     whose last price in the 10 minutes up to the minute is closest to the target and within ±TOLERANCE %, and that
//     traded in those 10 minutes. Not found at the entry time → looked for again every minute for WAIT minutes.
//   Entry: that last price + SLIPPAGE. Equal lots on both sides.
//   Stops (checked from the minute after the entry): 'leg' = each option on its own at entry × (1 − STOP %), filled at
//     the stop or the minute's open when it opened below it, the other one keeps running; 'whole' = both sold at the
//     close of the first minute their combined price is STOP % below the combined entry.
//   Exit: the open of the exit minute (else the last price before it).
//   Sizing: FUNDS_USE % of the running capital (compound) or of the starting capital (fixed), whole lots; at most
//     MAX_VOL % of the option's own volume in the 10 minutes before the entry (0 = no limit), the thinner side decides.
//   Charges: as on each date, per option, plus the extra orders of quantity above the exchange's per-order limit.
import { Worker } from 'node:worker_threads';
import { openHistory } from './history-store.js';
import { optionCharges } from '../scalper/orb5-options.js';
import { lotSizeOn, indexExpiry } from '../scalper/option-backtest.js';
import { BACKTEST_INDICES } from './gap.js';

// source: 'all' = every strike of the contracts saved while they traded (option_far_1m, NIFTY from Sep 2026: needed for
// far ₹3 options), 'near' = the near-ATM history (1 year+, strikes ATM ±10 / ±3 only).
export const STRANGLE_DEFAULTS = Object.freeze({ source: 'all', target: 3, tolerancePct: 30, entryTime: '09:20', waitMin: 25, exitTime: '15:25',
  stopMode: 'leg', stopPct: 20, expiryCode: 1, skipExpiryDay: true, capital: 600000, fundsUse: 100, sizing: 'compound', maxVolPct: 0, slippage: 0, stopCheck: 'close' });
// The usual target per index (the page fills it in when the index changes).
export const STRANGLE_TARGETS = Object.freeze({ NIFTY: 3, BANKNIFTY: 20, SENSEX: 100 });
// Most units one order may carry (exchange freeze quantity); more is sent as several orders, each with brokerage.
const FREEZE = { NIFTY: 1800, BANKNIFTY: 600, SENSEX: 1000 };
const BROKERAGE = 20, LOOKBACK = 600;

const sec = day => Date.parse(`${day}T00:00:00+05:30`) / 1000;
const at = (day, hhmm) => Date.parse(`${day}T${hhmm}:00+05:30`) / 1000;
const dayOf = s => new Date(s * 1000 + 19_800_000).toISOString().slice(0, 10);
const hm = s => new Date(s * 1000 + 19_800_000).toISOString().slice(11, 16);
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const r2 = x => Math.round(x * 100) / 100;

export function strangleBacktestInWorker(params) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./strangle-worker.js', import.meta.url), { workerData: params });
    w.once('message', m => (m.error ? reject(Object.assign(new Error(m.error), { code: m.code })) : resolve(m.result)));
    w.once('error', reject);
    w.once('exit', c => c && reject(new Error(`Backtest worker stopped (code ${c})`)));
  });
}

export function strangleBacktest({ startDate, endDate, ...options }, store) {
  const own = !store; store ||= openHistory();
  try { return run(store, startDate, endDate, { ...STRANGLE_DEFAULTS, ...options }); }
  finally { if (own) store.close(); }
}

/** Each strike's candles of one side, oldest first: Map(strike → [{ time, open, high, low, close, volume }]). */
function bySide(rows, side) {
  const m = new Map();
  for (const r of rows) if (r.side === side) { if (!m.has(r.strike)) m.set(r.strike, []); m.get(r.strike).push(r); }
  return m;
}
/** The option nearest the target at minute `t` (its last price in the 10 minutes up to t, and traded in them). */
function pick(strikes, t, lo, hi, target) {
  let best = null;
  for (const [strike, c] of strikes) {
    let last = null, vol = 0;
    for (const x of c) { if (x.time > t) break; if (x.time > t - LOOKBACK) { last = x; vol += Number(x.volume) || 0; } }
    if (!last || !(vol > 0) || last.close < lo || last.close > hi) continue;
    if (!best || Math.abs(last.close - target) < Math.abs(best.price - target)) best = { strike, price: last.close, vol, candles: c };
  }
  return best;
}

// Where the option prices come from. Each source: expiry(day) → the contract's expiry date (or null), window(expiry,
// from, to) → every strike's candles [{ side, strike, time, …, volume }], strike(expiry, side, strike, from, to) → one's.
/** 'near': the near-ATM history (option_1m: Dhan's expired-options data by slot and offset; nearest ±10, next ±3). */
function nearAtm(store, U, s, tradingDays) {
  // The strike's offset from the ATM changes as the index moves, so every stored offset is read through the primary
  // key (underlying, expiry_code, side, offset, time): one short range per offset.
  const OFFSETS = Array.from({ length: 21 }, (_, i) => i - 10).join(',');
  const sideRows = store.db.prepare(`SELECT time, strike, open, high, low, close, volume FROM option_1m
    WHERE underlying = ? AND expiry_code = ? AND side = ? AND offset IN (${OFFSETS}) AND time >= ? AND time < ?`);
  return {
    expiry: day => indexExpiry(U, day, s.expiryCode, tradingDays).date,
    window: (_, from, to) => store.options(U, s.expiryCode, from, to),
    strike: (_, side, strike, from, to) => sideRows.all(U, s.expiryCode, side, from, to).filter(r => r.strike === strike).sort((a, b) => a.time - b.time),
  };
}
/** 'all': every strike of the contracts saved while they traded (option_far_1m), so far cheap options are there too. */
function allStrikes(store, U, s) {
  const expiries = store.db.prepare('SELECT DISTINCT expiry FROM option_far_1m WHERE underlying = ? ORDER BY expiry').all(U).map(r => r.expiry);
  const win = store.db.prepare(`SELECT side, strike, time, open, high, low, close, volume FROM option_far_1m INDEXED BY option_far_1m_time
    WHERE underlying = ? AND time >= ? AND time < ? AND expiry = ? ORDER BY time`);
  const one = store.db.prepare(`SELECT time, open, high, low, close, volume FROM option_far_1m
    WHERE underlying = ? AND expiry = ? AND side = ? AND strike = ? AND time >= ? AND time < ? ORDER BY time`);
  return {
    // The n-th saved contract expiring on or after the day (1 = nearest).
    expiry: day => expiries.filter(e => e >= day)[s.expiryCode - 1] ?? null,
    window: (expiry, from, to) => win.all(U, from, to, expiry),
    strike: (expiry, side, strike, from, to) => one.all(U, expiry, side, strike, from, to),
  };
}

function run(store, startDate, endDate, s) {
  const U = BACKTEST_INDICES.includes(s.underlying) ? s.underlying : 'NIFTY';
  const idx = store.index(U, sec(startDate), sec(addDays(endDate, 1)));
  const sessions = new Map();
  for (const c of idx) { const d = dayOf(c.time), h = hm(c.time); if (h < '09:15' || h >= '15:30') continue; if (!sessions.has(d)) sessions.set(d, []); sessions.get(d).push(c); }
  const tradingDays = new Set(sessions.keys());
  const lo = s.target * (1 - s.tolerancePct / 100), hi = s.target * (1 + s.tolerancePct / 100);
  const src = s.source === 'all' ? allStrikes(store, U, s) : nearAtm(store, U, s, tradingDays);
  const trades = [], skipped = [];
  let equity = s.capital, peak = equity, maxDrawdownPct = 0, oneMinuteBars = 0;
  for (const [day, bars] of sessions) {
    oneMinuteBars += bars.length;
    const expiry = src.expiry(day);
    if (!expiry) { skipped.push({ day, reason: 'no stored contract for that day (all-strike prices start Sep 2026)' }); continue; }
    if (s.skipExpiryDay && expiry === day) { skipped.push({ day, reason: 'expiry day (the option expires today)' }); continue; }
    const t0 = at(day, s.entryTime), tEnd = at(day, s.exitTime);
    // Every stored strike only for the entry window; the two chosen strikes then for the rest of the day.
    const lastPick = t0 + s.waitMin * 60, early = src.window(expiry, t0 - LOOKBACK - 60, lastPick + 1);
    if (!early.length) { skipped.push({ day, reason: 'no stored option prices that day' }); continue; }
    const legs = {};
    for (const side of ['CE', 'PE']) {
      const strikes = bySide(early, side);
      for (let t = t0; t <= lastPick && !legs[side]; t += 60) { const p = pick(strikes, t, lo, hi, s.target); if (p) legs[side] = { ...p, entryAt: t }; }
      if (legs[side]) legs[side].candles = src.strike(expiry, side, legs[side].strike, t0 - LOOKBACK - 60, tEnd + 60);
    }
    if (!legs.CE || !legs.PE) {
      const which = !legs.CE && !legs.PE ? 'no call or put' : !legs.CE ? 'no call' : 'no put';
      skipped.push({ day, reason: `${which} traded at ₹${r2(lo)}–${r2(hi)} between ${s.entryTime} and ${hm(t0 + s.waitMin * 60)} in the stored strikes` });
      continue;
    }
    const lotSize = lotSizeOn(U, day), legList = [legs.CE, legs.PE];
    // stopCheck 'close': out at the close of the first minute that closes at or under the stop; 'touch': a stop-loss order,
    // out when any price in the minute reaches it (at the stop, or the open when it opened under it).
    const stopHit = (x, stop) => (s.stopCheck === 'touch' ? x.low <= stop : x.close <= stop), stopFill = (x, stop) => (s.stopCheck === 'touch' ? Math.min(stop, x.open) : x.close);
    for (const L of legList) { L.entry = r2(L.price + s.slippage); L.stop = s.stopMode === 'leg' ? r2(L.entry * (1 - s.stopPct / 100)) : null; L.last = L.price; L.exit = null; }
    // Minute by minute from the minute after the later entry … the exit minute.
    const start = Math.max(legs.CE.entryAt, legs.PE.entryAt);
    for (const L of legList) { L.i = L.candles.findIndex(x => x.time > L.entryAt); if (L.i < 0) L.i = L.candles.length; L.lastAt = L.entryAt; }
    const sumEntry = legs.CE.entry + legs.PE.entry;
    for (let t = start + 60; t <= tEnd; t += 60) {
      for (const L of legList) {
        if (L.exit) continue;
        // Catch up on the minutes before `t` (only the later leg's start can lag).
        while (L.i < L.candles.length && L.candles[L.i].time < t) { const x = L.candles[L.i++]; L.last = x.close; L.lastAt = x.time; if (L.stop != null && x.time > L.entryAt && stopHit(x, L.stop)) { L.exit = { price: stopFill(x, L.stop), at: x.time, reason: `Stop −${s.stopPct}%` }; break; } }
        if (L.exit) continue;
        const x = L.candles[L.i]?.time === t ? L.candles[L.i] : null;
        if (t === tEnd) { L.exit = { price: x ? x.open : L.last, at: t, reason: `Exit ${s.exitTime}` }; if (!x && t - L.lastAt > 15 * 60) L.exit.dataEnded = L.lastAt; continue; }
        if (x) { L.i++; if (L.stop != null && stopHit(x, L.stop)) { L.exit = { price: stopFill(x, L.stop), at: t, reason: `Stop −${s.stopPct}%` }; continue; } L.last = x.close; L.lastAt = t; }
      }
      if (s.stopMode === 'whole' && !legs.CE.exit && !legs.PE.exit && t < tEnd && legs.CE.last + legs.PE.last <= sumEntry * (1 - s.stopPct / 100)) {
        for (const L of legList) L.exit = { price: L.last, at: t, reason: `Both sold: together −${s.stopPct}%` };
      }
      if (legs.CE.exit && legs.PE.exit) break;
    }
    for (const L of legList) if (!L.exit) L.exit = { price: L.last, at: tEnd, reason: `Exit ${s.exitTime}` };
    // Size: whole lots of both, from the capital and the thinner side's recent volume.
    const base = s.sizing === 'fixed' ? s.capital : equity, perLot = sumEntry * lotSize;
    let lots = Math.floor(base * s.fundsUse / 100 / perLot), volCapped = false;
    if (s.maxVolPct > 0) { const cap = Math.floor(Math.min(legs.CE.vol, legs.PE.vol) * s.maxVolPct / 100 / lotSize); if (cap < lots) { lots = cap; volCapped = true; } }
    if (lots < 1) { skipped.push({ day, reason: volCapped ? `too little volume: ${s.maxVolPct}% of the last 10 minutes is under one lot` : 'capital below one lot of both' }); continue; }
    const qty = lots * lotSize, orders = Math.ceil(qty / (FREEZE[U] || 1800));
    let gross = 0, charges = 0;
    const leg = L => {
      const buy = L.entry * qty, sell = L.exit.price * qty;
      gross += sell - buy;
      charges += optionCharges(day, buy, sell).total + (orders - 1) * 2 * BROKERAGE * 1.18;
      return { strike: L.strike, entryAt: L.entryAt, entry: L.entry, stop: L.stop, exitAt: L.exit.at, exit: r2(L.exit.price), exitReason: L.exit.reason,
        dataEnded: L.exit.dataEnded || null, volume10m: L.vol, pct: r2((L.exit.price / L.entry - 1) * 100) };
    };
    const ce = leg(legs.CE), pe = leg(legs.PE), net = r2(gross - charges), before = equity;
    equity = r2(equity + net); peak = Math.max(peak, equity); maxDrawdownPct = Math.max(maxDrawdownPct, (peak - equity) / peak * 100);
    trades.push({ day, expiry, index: [bars.find(b => b.time >= t0)?.open ?? bars[0].open, bars.filter(b => b.time < tEnd).at(-1)?.close ?? bars.at(-1).close],
      ce, pe, lots, lotSize, qty, orders, volCapped, invested: r2(perLot * lots), gross: r2(gross), charges: r2(charges), net,
      dayPct: r2(net / before * 100), capitalAfter: equity });
  }
  const wins = trades.filter(x => x.net > 0), sum = a => r2(a.reduce((acc, x) => acc + x.net, 0)), months = {};
  for (const x of trades) {
    const m = (months[x.day.slice(0, 7)] ??= { month: x.day.slice(0, 7), days: 0, wins: 0, net: 0, startCapital: r2(x.capitalAfter - x.net) });
    m.days++; if (x.net > 0) m.wins++; m.net = r2(m.net + x.net); m.endCapital = x.capitalAfter;
  }
  // Longest run of losing days.
  let run = 0, worstRun = 0; for (const x of trades) { run = x.net <= 0 ? run + 1 : 0; worstRun = Math.max(worstRun, run); }
  const summary = { sessions: sessions.size, traded: trades.length, wins: wins.length, winRate: trades.length ? wins.length / trades.length * 100 : 0,
    net: sum(trades), charges: r2(trades.reduce((a, x) => a + x.charges, 0)), startCapital: s.capital, endCapital: equity,
    returnPct: r2((equity / s.capital - 1) * 100), bestDayPct: trades.length ? Math.max(...trades.map(x => x.dayPct)) : 0,
    worstDayPct: trades.length ? Math.min(...trades.map(x => x.dayPct)) : 0, maxDrawdownPct: r2(maxDrawdownPct), longestLosingRun: worstRun,
    volCapped: trades.filter(x => x.volCapped).length, dataEnded: trades.filter(x => x.ce.dataEnded || x.pe.dataEnded).length, skipped: skipped.length };
  return { settings: { ...s, underlying: U }, sessions: sessions.size, signals: trades.length, oneMinuteBars, summary, months: Object.values(months), trades, skipped,
    equityCurve: trades.map(x => ({ time: Math.max(x.ce.exitAt, x.pe.exitAt), value: x.capitalAfter })) };
}
