import { chartPalette } from './chart-palette.js';
const EMA_PERIOD = 45, EMA_SLOW_PERIOD = 105;
const IST_TIME_FORMAT = new Intl.DateTimeFormat('en-GB', { timeZone:'Asia/Kolkata', hour:'2-digit', minute:'2-digit', hourCycle:'h23' });

function emaValues(rows, period) {
  const factor = 2 / (period + 1);
  let value;
  return rows.map(candle => {
    value = value == null ? candle.close : candle.close * factor + value * (1 - factor);
    return value;
  });
}

export function emaIndicatorRows(rows) {
  const normalized=normalizeBacktestCandles(rows),fast=emaValues(normalized,EMA_PERIOD),slow=emaValues(normalized,EMA_SLOW_PERIOD);
  return normalized.map((candle,index)=>({time:candle.time,ema45:fast[index],ema105:slow[index]}));
}

function bodyTouchesEmaZone(candle, fast, slow) {
  const zoneLow = Math.min(fast, slow), zoneHigh = Math.max(fast, slow);
  const bodyLow = Math.min(candle.open, candle.close), bodyHigh = Math.max(candle.open, candle.close);
  return bodyHigh >= zoneLow && bodyLow <= zoneHigh;
}

// IST has no DST, so a fixed +05:30 shift is exact and far cheaper than Intl on every live tick.
const istDay = time => new Date(time * 1000 + 19_800_000).toISOString().slice(0, 10);

// Dhan's normalized API rows carry epoch milliseconds; chart rows carry epoch seconds.
export function normalizeBacktestCandles(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map(row => ({ ...row, time:Math.floor(Number(row.time) > 1e11 ? Number(row.time) / 1000 : Number(row.time)) }))
    .filter(row => Number.isFinite(row.time) && [row.open,row.high,row.low,row.close].every(Number.isFinite))
    .sort((a,b)=>a.time-b.time);
}

// The same confirmed EMA45 wick-touch + immediate breakout rule powers chart markers and backtests.
export function ema45HammerSignals(rows, { intervalMs = 60_000, now = Date.now() } = {}) {
  if (!Array.isArray(rows) || rows.length < EMA_PERIOD + 1) return [];
  const ema45 = emaValues(rows, EMA_PERIOD), ema105 = emaValues(rows, EMA_SLOW_PERIOD), signals = [];
  const sessionDays = rows.map(candle=>istDay(candle.time));
  for (let i = EMA_PERIOD - 1; i < rows.length - 1; i++) {
    const candle = rows[i], previous = rows[i - 1], confirmation = rows[i + 1];
    if (candle.time * 1000 + intervalMs > now || confirmation.time * 1000 + intervalMs > now) continue;
    if (sessionDays[i] !== sessionDays[i + 1]) continue;
    const body = Math.abs(candle.close - candle.open);
    if (!(body > 0)) continue;
    const bodyLow = Math.min(candle.open, candle.close), bodyHigh = Math.max(candle.open, candle.close);
    const lowerWick = bodyLow - candle.low, upperWick = candle.high - bodyHigh;
    const previousBodyClear = !bodyTouchesEmaZone(previous, ema45[i - 1], ema105[i - 1]);
    const common = { time:confirmation.time, hammerTime:candle.time, entryAt:confirmation.time, confirmationAt:confirmation.time };

    const bullishHammer = bodyLow > ema45[i] && candle.low <= ema45[i] && lowerWick >= body;
    if (bullishHammer && previousBodyClear && confirmation.high > candle.high) {
      signals.push({ ...common, direction:'CE', entry:candle.high, stop:candle.low, hammerHigh:candle.high, hammerLow:candle.low });
      continue;
    }
    const bearishHammer = bodyHigh < ema45[i] && candle.high >= ema45[i] && upperWick >= body;
    if (bearishHammer && previousBodyClear && confirmation.low < candle.low)
      signals.push({ ...common, direction:'PE', entry:candle.low, stop:candle.high, hammerHigh:candle.high, hammerLow:candle.low });
  }
  return signals;
}

// Opening-range breakout with next-candle confirmation, shared by the live AI scan and backtests.
// `minutes` are one session's 1-minute candles (epoch-second times), `range` is {high, low, end}.
//  1. Breakout candle: a candle that closes beyond the range. The rule stays armed: after a failed
//     confirmation, any later candle still closing beyond the range is a new breakout candle
//     (price does not have to return inside the range first).
//  2. Confirmation: the very next candle trades beyond the breakout candle's high (CE) / low (PE) and
//     closes in the trade's colour with a real body: green (close > open) for CE, red (close < open) for PE,
//     and |close - open| at least CONFIRM_MIN_BODY of its high-low range (a near-doji does not confirm).
//     The colour is only known when that candle closes, so entry is the confirming candle's close.
//  3. A breakout the next candle does not confirm is discarded and the scan continues; that next
//     candle can itself be the new breakout candle if it closed beyond the range.
//  4. Multiple trades per session: after a confirmed trade the scan continues. The same direction
//     re-arms only once a completed candle closes back inside the range (so a trend that stays above
//     the high does not fire on every candle); the opposite direction is armed straight away.
// Returns { signals } (every confirmed trade of the session, in order) plus { pending } while a
// confirming candle after the last signal is still forming. Only bars started by `now` are used.
//  confirm: 'close' (above, for backtests) or 'break' (live ORB 5m on the chart and in Algo Trading): the
//  next candle only has to trade beyond the breakout candle's high (CE) / low (PE): the entry is at that
//  moment, in the live candle, at that price (`entry`, with `live: true` while the candle is still forming).
export const CONFIRM_MIN_BODY = 0.3;
export function confirmedRangeBreakouts(minutes, range, { now = Date.now(), barSeconds = 60, confirm = 'close' } = {}) {
  const startedBy = now / 1000, signals = [], armed = { CE:true, PE:true };
  const bars = minutes.filter(c => c.time >= range.end && c.time <= startedBy);
  for (let i = 0; i < bars.length; i++) {
    const breakout = bars[i];
    if (breakout.time + barSeconds > startedBy) continue;   // breakout candle must have closed
    const close = Number(breakout.close);
    const direction = close > range.high ? 'CE' : close < range.low ? 'PE' : null;
    if (!direction) { armed.CE = armed.PE = true; continue; }
    if (!armed[direction]) continue;
    const confirming = bars[i + 1];
    const base = { direction, breakoutAt:breakout.time, breakoutHigh:Number(breakout.high), breakoutLow:Number(breakout.low),
      breakoutClose:close, rangeHigh:range.high, rangeLow:range.low };
    const level = direction === 'CE' ? base.breakoutHigh : base.breakoutLow;
    if (confirm === 'break') {
      const forming = !confirming || confirming.time + barSeconds > startedBy;
      const broke = confirming && (direction === 'CE' ? Number(confirming.high) > level : Number(confirming.low) < level);
      if (broke) {
        signals.push({ ...base, time:confirming.time, entryAt:confirming.time, entry:level, live:forming, stop:direction === 'CE' ? range.low : range.high });
        armed[direction] = false; armed[direction === 'CE' ? 'PE' : 'CE'] = true;
        continue;
      }
      if (forming) return { signals, pending:{ ...base, level, confirmAt:breakout.time + barSeconds } };
      continue;   // the next candle never traded past it: discard; that candle is checked as a breakout itself
    }
    if (!confirming || confirming.time + barSeconds > startedBy) return { signals, pending:{ ...base, level } };   // colour not final yet
    const open = Number(confirming.open), last = Number(confirming.close);
    const broke = direction === 'CE' ? Number(confirming.high) > level : Number(confirming.low) < level;
    const sameColour = direction === 'CE' ? last > open : last < open;
    const span = Number(confirming.high) - Number(confirming.low);
    const realBody = span > 0 && Math.abs(last - open) >= CONFIRM_MIN_BODY * span;
    if (broke && sameColour && realBody) {
      signals.push({ ...base, time:confirming.time, entryAt:confirming.time, entry:last,
        stop:direction === 'CE' ? range.low : range.high });
      armed[direction] = false; armed[direction === 'CE' ? 'PE' : 'CE'] = true;
    }
    // Not confirmed: discard this breakout. The next bar is checked as a breakout candle in its own right.
  }
  return { signals };
}

// EMA 5 / EMA 9 scalp (Power Scalper, 1-minute chart only; chart signal, not traded automatically):
// a completed 1-minute candle closing with EMA 5 crossing above EMA 9 is a CE signal, crossing below a
// PE signal; the opposite crossover is the exit. With rsiOn, RSI 14 must also agree (CE 50–75, PE 25–50).
// Rows: epoch seconds, earlier sessions seed the averages.
export const EMA_SCALP = Object.freeze({ fast:5, slow:9, rsiOn:false, rsiLength:14, ceMin:50, ceMax:75, peMin:25, peMax:50 });
// The faster EMA 3 / EMA 5 scalp: same rules (cross up: CE, cross down: PE, the opposite cross exits).
export const EMA_SCALP_35 = Object.freeze({ ...EMA_SCALP, fast:3, slow:5 });
function rsiValues(closes, n) {
  let gain = 0, loss = 0;
  return closes.map((x, i) => {
    if (!i) return null;
    const ch = x - closes[i - 1], g = Math.max(0, ch), l = Math.max(0, -ch);
    if (i <= n) { gain += g; loss += l; if (i < n) return null; gain /= n; loss /= n; }
    else { gain = (gain * (n - 1) + g) / n; loss = (loss * (n - 1) + l) / n; }
    return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  });
}
export function emaScalpSignals(rows, { intervalMs = 60_000, now = Date.now(), f = EMA_SCALP } = {}) {
  if (intervalMs !== 60_000) return [];
  const done = normalizeBacktestCandles(rows).filter(c => (c.time + 60) * 1000 <= now);
  const closes = done.map(c => c.close), fast = emaValues(done, f.fast), slow = emaValues(done, f.slow), rsi = rsiValues(closes, f.rsiLength), out = [];
  for (let i = 1; i < done.length; i++) {
    const was = Math.sign(fast[i - 1] - slow[i - 1]), is = Math.sign(fast[i] - slow[i]);
    if (!was || !is || was === is) continue;
    const direction = is > 0 ? 'CE' : 'PE', r = rsi[i];
    const ok = !f.rsiOn || (r != null && (direction === 'CE' ? r > f.ceMin && r < f.ceMax : r > f.peMin && r < f.peMax));
    out.push({ time:done[i].time, direction, rsi:r == null ? null : Math.round(r * 10) / 10, ok });
  }
  return out;
}
// Arrows for the signals that pass the RSI filter (all of them while it is off); a filtered crossover is
// only an exit (small dot).
export function emaScalpMarkers(signals, chart = 'spot', f = EMA_SCALP) {
  const pal = chartPalette(), out = [], label = `EMA ${f.fast}/${f.slow}`;
  for (const s of signals) {
    const ce = s.direction === 'CE';
    if (!s.ok) { if (chart === 'spot') out.push({ time:s.time, position:ce ? 'belowBar' : 'aboveBar', color:'#8b95a7', shape:'circle', text:'', size:0.5 }); continue; }
    if (chart === 'spot') out.push({ time:s.time, position:ce ? 'belowBar' : 'aboveBar', color:ce ? pal.up : pal.down, shape:ce ? 'arrowUp' : 'arrowDown', text:`${s.direction} · ${label}`, size:1 });
    else if (chart === (ce ? 'ce' : 'pe')) out.push({ time:s.time, position:'belowBar', color:ce ? pal.up : pal.down, shape:'arrowUp', text:`BUY ${s.direction} · ${label}`, size:1 });
  }
  return out;
}

// ORB entry filter, the same for the chart and Algo Trading. At the confirming candle's close:
//  - RSI 14 must be inside 25–75 (not overbought / oversold; rsiOn switches the check), and
//  - EMA 9 must be on the trade's side of EMA 21 (above for CE, below for PE) by at least 0.02% of the price.
// `rows` are all candles up to then (earlier sessions seed the averages), times in seconds.
export const ORB_FILTER = Object.freeze({ rsiOn: true, rsiLength: 14, rsiMin: 25, rsiMax: 75, emaGapPct: 0.02 });
export function orbEntryFilter(rows, signal, f = ORB_FILTER) {
  const done = (rows || []).filter(c => c.time <= signal.time);
  if (done.length < 2) return { ok:true, reason:'not enough candles to check' };
  const closes = done.map(c => Number(c.close)), close = closes.at(-1);
  // RSI with Wilder smoothing (as the chart's RSI indicator)
  let gain = 0, loss = 0, rsi = null;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1], g = Math.max(0, ch), l = Math.max(0, -ch);
    if (i <= f.rsiLength) { gain += g; loss += l; if (i === f.rsiLength) { gain /= f.rsiLength; loss /= f.rsiLength; } }
    else { gain = (gain * (f.rsiLength - 1) + g) / f.rsiLength; loss = (loss * (f.rsiLength - 1) + l) / f.rsiLength; }
    if (i >= f.rsiLength) rsi = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  const e9 = emaValues(done, 9).at(-1), e21 = emaValues(done, 21).at(-1);
  const ce = signal.direction === 'CE', gap = ce ? e9 - e21 : e21 - e9, need = close * f.emaGapPct / 100;
  const r2 = n => Math.round(n * 100) / 100;
  const out = { rsi:rsi == null ? null : r2(rsi), ema9:r2(e9), ema21:r2(e21), gap:r2(gap), need:r2(need) };
  if (f.rsiOn && rsi != null && rsi >= f.rsiMax) return { ...out, ok:false, reason:`RSI ${out.rsi} is overbought (needs ${f.rsiMin}–${f.rsiMax})` };
  if (f.rsiOn && rsi != null && rsi <= f.rsiMin) return { ...out, ok:false, reason:`RSI ${out.rsi} is oversold (needs ${f.rsiMin}–${f.rsiMax})` };
  if (gap < need) return { ...out, ok:false, reason:gap <= 0
    ? `EMA 9 (${out.ema9}) is ${ce ? 'below' : 'above'} EMA 21 (${out.ema21}): the trend is not ${ce ? 'up' : 'down'} yet`
    : `EMA 9 and EMA 21 are only ${out.gap} apart (needs ${out.need}, 0.02% of the price)` };
  return { ...out, ok:true };
}

// The session's first confirmed trade only (first-trade backtests): { signal }, { pending } or {}.
export function confirmedRangeBreakout(minutes, range, options = {}) {
  const { signals, pending } = confirmedRangeBreakouts(minutes, range, options);
  return signals.length ? { signal:signals[0] } : pending ? { pending } : {};
}

// First-trade opening range for backtests: the 09:15 5-minute candle sets the range, then the
// same confirmed breakout rule as the live Power Scalper scan.
export function openingRangeFirstTradeSignals(oneMinuteRows, fiveMinuteRows, { now = Date.now() } = {}) {
  if (!Array.isArray(oneMinuteRows) || !Array.isArray(fiveMinuteRows)) return [];
  const groups = new Map(), minuteGroups = new Map();
  for (const candle of oneMinuteRows) {
    const day=istDay(candle.time);
    if (!minuteGroups.has(day)) minuteGroups.set(day,[]);
    minuteGroups.get(day).push(candle);
  }
  for (const candle of fiveMinuteRows) {
    const day = istDay(candle.time), local = IST_TIME_FORMAT.format(new Date(candle.time * 1000));
    if (local === '09:15' && candle.time * 1000 + 300_000 <= now && candle.high > candle.low) groups.set(day, { high:candle.high, low:candle.low, end:candle.time + 300 });
  }
  for (const [day, range] of groups) {
    // Backtests only use completed bars, so a confirming candle must have closed too.
    const today = (minuteGroups.get(day) || []).filter(c => c.time * 1000 + 60_000 <= now);
    const { signal } = confirmedRangeBreakout(today, range, { now });
    if (signal) groups.set(day, { ...range, signal });
  }
  return [...groups.values()].map(x=>x.signal).filter(Boolean).sort((a,b)=>a.time-b.time);
}

export function countOpeningRangeSessions(fiveMinuteRows, { now = Date.now() } = {}) {
  const days=new Set();
  for (const candle of fiveMinuteRows || []) {
    if (candle.time*1000+300_000>now || !(candle.high>candle.low)) continue;
    if (IST_TIME_FORMAT.format(new Date(candle.time*1000))==='09:15') days.add(istDay(candle.time));
  }
  return days.size;
}

// Use only earlier regular trading sessions; never include today's extrema in its levels.
// A gap beyond a level qualifies on the first completed close that stays beyond it.
export function previousDayBreakoutSignals(rows, { now = Date.now() } = {}) {
  const sessions = new Map(), signals = [];
  for (const candle of normalizeBacktestCandles(rows)) {
    const local = IST_TIME_FORMAT.format(new Date(candle.time * 1000));
    if (local < '09:15' || local >= '15:30' || candle.time * 1000 + 60_000 > now) continue;
    const day = istDay(candle.time);
    if (!sessions.has(day)) sessions.set(day, []);
    sessions.get(day).push(candle);
  }
  let previous;
  for (const [day, candles] of sessions) {
    if (previous && previous.high > previous.low) {
      const candle = candles.find(row => row.close > previous.high || row.close < previous.low);
      if (candle) {
        const direction = candle.close > previous.high ? 'CE' : 'PE';
        signals.push({ time:candle.time, entryAt:candle.time, entry:candle.close, direction,
          stop:direction === 'CE' ? previous.low : previous.high,
          previousDay:previous.day, rangeHigh:previous.high, rangeLow:previous.low });
      }
    }
    previous = { day, high:Math.max(...candles.map(row => row.high)), low:Math.min(...candles.map(row => row.low)) };
  }
  return signals;
}

function previousConfirmedSwing(ordered, entryIndex, day, direction) {
  const isLow = direction === 'CE';
  for (let pivot=entryIndex-2; pivot>=2; pivot--) {
    if (istDay(ordered[pivot].time)!==day || istDay(ordered[pivot+2].time)!==day) break;
    const value=isLow?ordered[pivot].low:ordered[pivot].high;
    const leftOne=isLow?ordered[pivot-1].low:ordered[pivot-1].high;
    const leftTwo=isLow?ordered[pivot-2].low:ordered[pivot-2].high;
    const rightOne=isLow?ordered[pivot+1].low:ordered[pivot+1].high;
    const rightTwo=isLow?ordered[pivot+2].low:ordered[pivot+2].high;
    if(isLow?value<leftOne&&value<leftTwo&&value<rightOne&&value<rightTwo
      :value>leftOne&&value>leftTwo&&value>rightOne&&value>rightTwo) return value;
  }
  return null;
}

// Level-rejection exit: price bounces off the floor (PE) or ceiling (CE) of the move several times.
// The floor is the lowest low since entry (CE: the highest high). A touch is a 1-minute swing low
// (a low below the previous candle's and not above the next one's; CE: swing high) within `band`
// points of the floor. Bounces in the middle of a range, above a lower low, do not count, and a new
// low moves the floor so earlier bounces drop out. When the candle after a swing confirms it and
// `touches` swings sit at the floor, exit at that confirming candle's close.
export const LEVEL_REJECT = { touches:3, band:5 };
export function levelRejectionExit(ordered, entryIndex, direction, { touches = LEVEL_REJECT.touches, band = LEVEL_REJECT.band } = {}) {
  const day = istDay(ordered[entryIndex].time), pe = direction === 'PE';
  const value = c => pe ? Number(c.low) : Number(c.high);
  const swings = [];
  let floor = null;
  for (let i = entryIndex + 1; i < ordered.length && istDay(ordered[i].time) === day; i++) {
    const v = value(ordered[i]);
    if (floor == null || (pe ? v < floor : v > floor)) floor = v;
    if (i < entryIndex + 2) continue;
    const pivot = i - 1, before = value(ordered[pivot - 1]), at = value(ordered[pivot]), after = v;
    if (!(pe ? at < before && at <= after : at > before && at >= after)) continue;
    swings.push(at);
    if (Math.abs(at - floor) > band) continue;               // this bounce is not at the floor
    const atFloor = swings.filter(s => Math.abs(s - floor) <= band);
    if (atFloor.length >= touches) return { index:i, level:floor, touches:atFloor.length };
  }
  return null;
}

// Stop-loss rules, checked alongside any exit rule; the stop wins when both fall on the same candle.
//  breakoutCandle: opening-range trades only. CE stop = the 1-minute breakout candle's low, PE = its high:
//  price back through it means the breakout was rejected. A wick touch exits at the stop; a gap through it
//  fills at that candle's open. Checked from the candle after entry.
export const STOP_RULES = ['none', 'breakoutCandle'];
export function stopLossLevel(signal, stopLogic) {
  if (stopLogic !== 'breakoutCandle') return null;
  const level = signal.direction === 'CE' ? Number(signal.breakoutLow) : Number(signal.breakoutHigh);
  return Number.isFinite(level) ? level : null;
}

export function backtestSignals(signals, rows, { horizonBars = 10, exitLogic = 'horizon', stopLogic = 'none' } = {}) {
  const ordered = [...rows].sort((a,b)=>a.time-b.time), byTime = new Map(ordered.map((c,i)=>[c.time,i]));
  const ema45 = exitLogic === 'emaZone' ? emaValues(ordered, EMA_PERIOD) : null;
  const ema105 = exitLogic === 'emaZone' ? emaValues(ordered, EMA_SLOW_PERIOD) : null;
  const trades=[]; let unavailable=0,noSwingStop=0;
  for (const signal of signals) {
    const index=byTime.get(signal.time);
    let exit, exitReason;
    if (index == null) { unavailable++; continue; }
    let stopLevel, rejectLevel;
    if (exitLogic === 'swingSL') {
      const day=istDay(signal.time), stop=previousConfirmedSwing(ordered,index,day,signal.direction);
      if (!Number.isFinite(stop)) { unavailable++;noSwingStop++;continue; }
      stopLevel=stop;
      let finalIndex=-1;
      for (let i=index+1; i<ordered.length && istDay(ordered[i].time)===day; i++) {
        finalIndex=i;
        const candle=ordered[i], breached=signal.direction==='CE'?candle.low<=stop:candle.high>=stop;
        if (breached) {
          exit={...candle,close:signal.direction==='CE'&&candle.open<=stop||signal.direction==='PE'&&candle.open>=stop?candle.open:stop};
          exitReason='Previous swing stop';break;
        }
      }
      if (!exit&&finalIndex>index) { exit=ordered[finalIndex];exitReason='Session close'; }
    } else if (exitLogic === 'levelReject') {
      const day=istDay(signal.time), hit=levelRejectionExit(ordered,index,signal.direction);
      if (hit) { exit=ordered[hit.index]; exitReason='Level rejection'; rejectLevel=hit.level; }
      else {
        let finalIndex=-1;
        for (let i=index+1; i<ordered.length && istDay(ordered[i].time)===day; i++) finalIndex=i;
        if (finalIndex>index) { exit=ordered[finalIndex]; exitReason='Session close'; }
      }
    } else if (exitLogic === 'emaZone') {
      const day=istDay(signal.time); let finalIndex=-1;
      for (let i=index+1; i<ordered.length && istDay(ordered[i].time)===day; i++) {
        finalIndex=i;
        // Keep the EMA seed from influencing exits until three slow-EMA periods have loaded.
        if (i < EMA_SLOW_PERIOD*3) continue;
        const zoneLow=Math.min(ema45[i],ema105[i]),zoneHigh=Math.max(ema45[i],ema105[i]);
        if (ordered[i].close>=zoneLow && ordered[i].close<=zoneHigh) {
          exit=ordered[i];exitReason='EMA45/EMA105 zone';break;
        }
      }
      if (!exit && finalIndex>index) { exit=ordered[finalIndex];exitReason='Session close'; }
    } else {
      exit=ordered[index+horizonBars];
      if (exit && istDay(exit.time)===istDay(signal.time)) exitReason=`${horizonBars}m close`;
    }
    const slLevel = stopLossLevel(signal, stopLogic);
    if (slLevel != null) {
      const day=istDay(signal.time), ce=signal.direction==='CE';
      const exitIndex=exit && istDay(exit.time)===day ? byTime.get(exit.time) : null;
      for (let i=index+1; i<ordered.length && istDay(ordered[i].time)===day && (exitIndex==null || i<=exitIndex); i++) {
        const candle=ordered[i];
        if (ce ? candle.low<=slLevel : candle.high>=slLevel) {
          exit={...candle,close:ce ? Math.min(candle.open,slLevel) : Math.max(candle.open,slLevel)};
          exitReason='Stop loss (breakout candle)';break;
        }
      }
    }
    if (!exit || istDay(exit.time) !== istDay(signal.time)) { unavailable++; continue; }
    const points=signal.direction==='CE' ? exit.close-signal.entry : signal.entry-exit.close;
    trades.push({ ...signal, ...(stopLevel==null?{}:{stopLevel}), ...(rejectLevel==null?{}:{rejectLevel}), ...(slLevel==null?{}:{slLevel}), exitAt:exit.time, exit:exit.close, exitReason, points, result:points > 0 ? 'WIN' : points < 0 ? 'LOSS' : 'FLAT' });
  }
  const wins=trades.filter(t=>t.result==='WIN').length;
  return { trades, unavailable, noSwingStop, wins, losses:trades.filter(t=>t.result==='LOSS').length, flats:trades.filter(t=>t.result==='FLAT').length,
    winRate:trades.length ? wins/trades.length*100 : 0, totalPoints:trades.reduce((sum,t)=>sum+t.points,0), averagePoints:trades.length ? trades.reduce((sum,t)=>sum+t.points,0)/trades.length : 0 };
}

// Opening-range breakout on the chart's own candles (1- or 5-minute): each session's 09:15-09:20 range,
// then the same confirmed-breakout rule as the AI scan, run on those bars. Every confirmed trade is marked.
export function openingRangeChartSignals(rows, { intervalMs = 60_000, now = Date.now() } = {}) {
  const barSeconds = intervalMs / 1000;
  if (![60, 300].includes(barSeconds)) return [];
  const days = new Map();
  for (const candle of normalizeBacktestCandles(rows)) {
    const day = istDay(candle.time);
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(candle);
  }
  const signals = [], every = normalizeBacktestCandles(rows);
  for (const [day, bars] of days) {
    const start = Date.parse(`${day}T09:15:00+05:30`) / 1000, end = start + 300;
    const inRange = bars.filter(c => c.time >= start && c.time < end);
    if (!inRange.length || end * 1000 > now || inRange[0].time !== start) continue;
    const range = { high:Math.max(...inRange.map(c => c.high)), low:Math.min(...inRange.map(c => c.low)), end };
    if (!(range.high > range.low)) continue;
    // The RSI / EMA filter is judged on the 5-minute chart (as Algo Trading); 1-minute signals are drawn unfiltered.
    signals.push(...confirmedRangeBreakouts(bars, range, { now, barSeconds }).signals
      .map(s => barSeconds === 300 ? { ...s, filter:orbEntryFilter(every, s) } : s));
  }
  return signals;
}
// EMA 9 / EMA 21 crossovers on the 5-minute chart (epoch-second rows): the completed candle that closes
// with EMA 9 on the other side of EMA 21 than the candle before. Same rule as the Algo Trading entry.
export function emaCrossSignals(rows, { intervalMs = 300_000, now = Date.now() } = {}) {
  if (intervalMs !== 300_000) return [];
  const done = normalizeBacktestCandles(rows).filter(c => (c.time + 300) * 1000 <= now);
  const fast = emaValues(done, 9), slow = emaValues(done, 21), out = [];
  for (let i = 1; i < done.length; i++) {
    const was = Math.sign(fast[i - 1] - slow[i - 1]), is = Math.sign(fast[i] - slow[i]);
    if (was && is && was !== is) out.push({ time:done[i].time, direction:is > 0 ? 'CE' : 'PE' });
  }
  return out;
}
export function emaCrossMarkers(signals, chart = 'spot') {
  return signals.filter(s => chart === 'spot' || chart === (s.direction === 'CE' ? 'ce' : 'pe')).map(s => {
    const ce = s.direction === 'CE';
    return chart === 'spot'
      ? { time:s.time, position:ce ? 'belowBar' : 'aboveBar', color:chartPalette().cross, shape:ce ? 'arrowUp' : 'arrowDown', text:`${s.direction} BUY · EMA 9/21`, size:1 }
      : { time:s.time, position:'belowBar', color:chartPalette().cross, shape:'arrowUp', text:`BUY ${s.direction} · EMA 9/21`, size:1 };
  });
}

// Chart markers for those signals. Index chart: breakout candle + confirmed entry arrow.
// CE / PE charts (premium): the same breakout dot and the BUY arrow, for their own direction only.
export function openingRangeMarkers(signals, chart = 'spot') {
  const out = [];
  for (const s of signals) {
    const pal = chartPalette(), ce = s.direction === 'CE', color = ce ? pal.up : pal.down;
    const skipped = s.filter && !s.filter.ok, why = skipped ? (/RSI/.test(s.filter.reason) ? `RSI ${s.filter.rsi}` : 'EMA 9/21') : '';
    if (chart === 'spot') {
      out.push({ time:s.breakoutAt, position:ce ? 'aboveBar' : 'belowBar', color:pal.orb, shape:'circle', text:`ORB ${ce ? 'HIGH' : 'LOW'} BREAK`, size:1 });
      out.push(skipped ? { time:s.time, position:ce ? 'belowBar' : 'aboveBar', color:'#8b95a7', shape:'square', text:`${s.direction} SKIPPED · ${why}`, size:1 }
        : { time:s.time, position:ce ? 'belowBar' : 'aboveBar', color, shape:ce ? 'arrowUp' : 'arrowDown', text:`${s.direction} BUY · 5M ORB`, size:2 });
    } else if (chart === (ce ? 'ce' : 'pe')) {
      out.push({ time:s.breakoutAt, position:'aboveBar', color:pal.orb, shape:'circle', text:`INDEX ORB ${ce ? 'HIGH' : 'LOW'} BREAK`, size:1 });
      out.push(skipped ? { time:s.time, position:'belowBar', color:'#8b95a7', shape:'square', text:`SKIPPED ${s.direction} · ${why}`, size:1 }
        : { time:s.time, position:'belowBar', color, shape:'arrowUp', text:`BUY ${s.direction} · 5M ORB`, size:2 });
    }
  }
  return out;
}

// Option candles skip minutes with no trades. Move each marker onto the option's first candle at or
// after the index time, within the same session; a marker with no such candle is dropped.
export function alignMarkersToBars(markers, rows) {
  const times = (rows || []).map(r => Number(r.time)).sort((a, b) => a - b);
  const out = [];
  for (const marker of markers) {
    let lo = 0, hi = times.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] < marker.time) lo = mid + 1; else hi = mid; }
    const time = times[lo];
    if (time != null && istDay(time) === istDay(marker.time)) out.push({ ...marker, time });
  }
  return out;
}

export function emaRejectionMarkers(rows, options = {}) {
  return ema45HammerSignals(rows, options).map(signal => ({ time:signal.time,
    position:signal.direction==='CE'?'belowBar':'aboveBar', color:signal.direction==='CE'?chartPalette().up:chartPalette().down,
    shape:signal.direction==='CE'?'arrowUp':'arrowDown', text:`${signal.direction} BUY · EMA45 BREAKOUT`, size:2 }));
}
