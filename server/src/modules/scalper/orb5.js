// Nifty 5-Minute Opening Range Breakout (backtest only; never places orders).
// Pure, chronological simulation over NIFTY spot 1-minute candles (epoch-second times, IST sessions).
//
// Range: highest high / lowest low (wicks included) of the 09:15-09:19 candles, frozen at 09:20 and
//   rebuilt every day. A day missing any of those five candles is skipped and reported.
// Signal: a completed candle at or after 09:20 closes above the range high with the previous close at or
//   below it (CE), or closes below the range low with the previous close at or above it (PE). Wick-only
//   breaks do not count; while the close stays inside the range nothing happens.
// Entry: the next candle's open (no lookahead), only when flat, below the daily entry limit and before
//   the square-off time. CE stop = signal candle low, PE stop = signal candle high, frozen at entry; an
//   entry whose execution price is already at or beyond the stop is skipped. Target = entry ± R:R × risk.
// Exit, in candle order: square-off at the open of the first candle at/after the square-off time; a gap
//   through stop/target fills at the open; otherwise stop/target inside the candle (both touched: stop
//   first, flagged ambiguous); a completed close back inside the range exits at the next candle's open.
//   OPPOSITE_EXIT '1m' / '5m' (optional): so does the first completed opposite-colour candle (red for CE, green for
//   PE): the 1-minute candle, or the 5-minute one (09:15-09:19, 09:20-09:24, …); the one the entry is in counts.
//   A position still open when the data ends exits at the last close.
// Directional mode books CE as long NIFTY and PE as short NIFTY, in points (optional slippage per side).

export const ORB5_DEFAULTS = { riskReward:2, maxEntriesPerDay:2, squareOff:'15:15', slippagePoints:0, oppositeExit:'off' };
const RANGE_MINUTES = ['09:15', '09:16', '09:17', '09:18', '09:19'];

const ist = seconds => new Date(seconds * 1000 + 19_800_000).toISOString();
export const istDay = seconds => ist(seconds).slice(0, 10);
export const istTime = seconds => ist(seconds).slice(11, 16);

/** Group session candles (09:15-15:29) by IST day, in time order. */
export function sessions(rows) {
  const days = new Map();
  for (const row of [...rows].sort((a, b) => a.time - b.time)) {
    const hhmm = istTime(row.time);
    if (hhmm < '09:15' || hhmm >= '15:30') continue;
    const day = istDay(row.time);
    if (!days.has(day)) days.set(day, []);
    const bars = days.get(day);
    if (bars.at(-1)?.time !== row.time) bars.push(row);
  }
  return days;
}

/** Opening range for one session, or { skipped } with the reason when it cannot be built. */
export function openingRange(bars) {
  const byMinute = new Map(bars.map(bar => [istTime(bar.time), bar]));
  const missing = RANGE_MINUTES.filter(m => !byMinute.has(m));
  if (missing.length) return { skipped:`Missing opening-range candle${missing.length > 1 ? 's' : ''} ${missing.join(', ')}` };
  const first = RANGE_MINUTES.map(m => byMinute.get(m));
  const high = Math.max(...first.map(bar => Number(bar.high))), low = Math.min(...first.map(bar => Number(bar.low)));
  if (!(high > low)) return { skipped:'Opening range has no width' };
  return { high, low, frozenAt:first[4].time + 60 };
}

/** One day of the strategy. `bars` must be that day's completed session candles in time order. */
export function simulateDay(bars, range, { riskReward = 2, maxEntriesPerDay = 2, squareOff = '15:15', slippagePoints = 0, oppositeExit = 'off' } = {}) {
  const trades = [];
  let position = null, pendingEntry = null, pendingExit = null, entries = 0;
  // 5-minute candles from 09:15 for OPPOSITE_EXIT '5m': bucket start -> { open, last } (close = the last minute's close).
  const t0 = bars[0]?.time, bucketOf = t => t - ((t - t0) % 300), buckets = new Map();
  for (const b of bars) { const k = bucketOf(b.time), x = buckets.get(k); if (x) x.last = b.time; else buckets.set(k, { open:Number(b.open), last:b.time }); }
  const close = (trade, price, at, reason, { atOpen = false, ambiguous = false } = {}) => {
    const fill = trade.direction === 'CE' ? price - slippagePoints : price + slippagePoints;
    const points = Math.round((trade.direction === 'CE' ? fill - trade.entry : trade.entry - fill) * 100) / 100;
    trades.push({ ...trade, exitIndex:price, exit:Math.round(fill * 100) / 100, exitAt:at, exitAtOpen:atOpen, exitReason:reason, ambiguous,
      points, r:Math.round(points / trade.risk * 100) / 100, result:points > 0 ? 'WIN' : points < 0 ? 'LOSS' : 'FLAT' });
    position = null; pendingExit = null;
  };
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i], open = Number(bar.open), hhmm = istTime(bar.time);
    // 1. Orders decided on the previous completed candle execute at this candle's open.
    if (position && pendingExit) close(position, open, bar.time, pendingExit, { atOpen:true });
    if (position && hhmm >= squareOff) close(position, open, bar.time, 'Square-off', { atOpen:true });
    if (pendingEntry) {
      const signal = pendingEntry; pendingEntry = null;
      const fill = signal.direction === 'CE' ? open + slippagePoints : open - slippagePoints;
      const risk = signal.direction === 'CE' ? fill - signal.stop : signal.stop - fill;
      if (hhmm >= squareOff) signal.skippedReason = 'Execution at or after square-off';
      else if (!(risk > 0)) signal.skippedReason = 'Execution price is beyond the stop';
      else {
        entries++;
        const target = signal.direction === 'CE' ? fill + riskReward * risk : fill - riskReward * risk;
        position = { ...signal, time:bar.time, entryAt:bar.time, entryIndex:open, entry:Math.round(fill * 100) / 100,
          risk:Math.round(risk * 100) / 100, target:Math.round(target * 100) / 100, rangeHigh:range.high, rangeLow:range.low };
      }
      if (signal.skippedReason) trades.push({ ...signal, skipped:signal.skippedReason, time:bar.time });
    }
    // 2. Stop and target: a gap through either fills at the open, otherwise inside the candle.
    if (position) {
      const ce = position.direction === 'CE', high = Number(bar.high), low = Number(bar.low);
      const stopGap = ce ? open <= position.stop : open >= position.stop;
      const targetGap = ce ? open >= position.target : open <= position.target;
      const stopHit = ce ? low <= position.stop : high >= position.stop;
      const targetHit = ce ? high >= position.target : low <= position.target;
      if (stopGap) close(position, open, bar.time, 'Stop (gap)', { atOpen:true });
      else if (targetGap) close(position, open, bar.time, 'Target (gap)', { atOpen:true });
      else if (stopHit) close(position, position.stop, bar.time, 'Stop', { ambiguous:targetHit });
      else if (targetHit) close(position, position.target, bar.time, 'Target');
    }
    // 3. This candle has completed: a close back inside the range exits at the next open.
    const c = Number(bar.close);
    if (position && c <= range.high && c >= range.low) pendingExit = 'Closed back inside range';
    // 3b. Optional: the first completed opposite-colour 1- or 5-minute candle exits at the next open too.
    if (position && !pendingExit && oppositeExit !== 'off') {
      const ce = position.direction === 'CE', five = oppositeExit === '5m' ? buckets.get(bucketOf(bar.time)) : null;
      const o = five ? (five.last === bar.time ? five.open : null) : Number(bar.open);
      if (o != null && (ce ? c < o : c > o)) pendingExit = `Opposite ${five ? '5' : '1'}-min candle ${istTime(five ? bucketOf(bar.time) : bar.time)}`;
    }
    // 4. Flat after this candle: a fresh close-through is a signal for the next candle.
    const previous = bars[i - 1];
    if (!position && !pendingEntry && previous && bar.time >= range.frozenAt && entries < maxEntriesPerDay && hhmm < squareOff) {
      const priorClose = Number(previous.close);
      const direction = c > range.high && priorClose <= range.high ? 'CE' : c < range.low && priorClose >= range.low ? 'PE' : null;
      if (direction) pendingEntry = { direction, signalAt:bar.time, signalClose:c, stop:direction === 'CE' ? Number(bar.low) : Number(bar.high) };
    }
  }
  if (position) { const last = bars.at(-1); close(position, Number(last.close), last.time, 'Session end (data)'); }
  return trades;
}

/** Summary statistics for a list of numeric trade results (points or rupees), in time order. */
export function tradeStats(values) {
  const wins = values.filter(v => v > 0), losses = values.filter(v => v < 0);
  const sum = list => list.reduce((a, b) => a + b, 0), round = v => Math.round(v * 100) / 100;
  let equity = 0, peak = 0, maxDrawdown = 0;
  for (const v of values) { equity += v; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak - equity); }
  return { trades:values.length, wins:wins.length, losses:losses.length, winRate:values.length ? round(wins.length / values.length * 100) : 0,
    averageWin:wins.length ? round(sum(wins) / wins.length) : 0, averageLoss:losses.length ? round(sum(losses) / losses.length) : 0,
    expectancy:values.length ? round(sum(values) / values.length) : 0,
    profitFactor:losses.length ? round(sum(wins) / Math.abs(sum(losses))) : wins.length ? null : 0,
    net:round(sum(values)), maxDrawdown:round(maxDrawdown) };
}

/**
 * Run the directional backtest over [startDay, endDay]. `rows` may include earlier days (ignored).
 * Only candles completed by `now` are used.
 */
export function orb5Backtest(rows, { startDay, endDay, now = Date.now(), ...settings } = {}) {
  const options = { ...ORB5_DEFAULTS, ...settings };
  const completed = rows.filter(row => (Number(row.time) + 60) * 1000 <= now);
  const days = [], trades = [], skippedSignals = [];
  for (const [day, bars] of sessions(completed)) {
    if (day < startDay || day > endDay) continue;
    const range = openingRange(bars);
    if (range.skipped) { days.push({ day, skipped:range.skipped, trades:0, net:0 }); continue; }
    const dayTrades = simulateDay(bars, range, options);
    const filled = dayTrades.filter(t => !t.skipped);
    skippedSignals.push(...dayTrades.filter(t => t.skipped).map(t => ({ ...t, day })));
    trades.push(...filled.map(t => ({ ...t, day })));
    days.push({ day, rangeHigh:range.high, rangeLow:range.low, trades:filled.length,
      net:Math.round(filled.reduce((sum, t) => sum + t.points, 0) * 100) / 100 });
  }
  const stats = tradeStats(trades.map(t => t.points));
  const rs = trades.map(t => t.r);
  let equity = 0;
  const equityCurve = trades.map(t => ({ time:t.exitAt, value:Math.round((equity += t.points) * 100) / 100 }));
  return { trades, days, skippedSignals, equityCurve, settings:options,
    summary:{ ...stats, mode:'directional', unit:'points', skippedDays:days.filter(d => d.skipped).length, tradedDays:days.filter(d => d.trades).length,
      sessions:days.length, ambiguous:trades.filter(t => t.ambiguous).length, skippedSignals:skippedSignals.length,
      averageR:rs.length ? Math.round(rs.reduce((a, b) => a + b, 0) / rs.length * 100) / 100 : 0, netR:Math.round(rs.reduce((a, b) => a + b, 0) * 100) / 100 } };
}
