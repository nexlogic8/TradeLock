import { limitAmount, capitalLimit } from '../rules/limits.js';
import { ist } from '../../lib/time.js';
import { confirmedRangeBreakouts } from '../../../../web/js/pages/scalper-chart-signals.js';

export function openingRangeBreakout(candles, now = Date.now()) {
  const day = ist(now).day;
  const today = candles.filter(c => ist(c.time).day === day).sort((a,b) => a.time-b.time);
  const opening = today.find(c => ist(c.time).hhmm === '09:15');
  if (!opening) return { ready:false, direction:null, reason:'Waiting for today’s first NIFTY 5-minute candle (09:15–09:20 IST).' };
  const high=Number(opening.high), low=Number(opening.low);
  const setup={rangeStart:opening.time,rangeEnd:opening.time+300_000,high,low,interval:'5m'};
  if (!(Number.isFinite(high)&&Number.isFinite(low)&&high>low)) return { ...setup,ready:false,direction:null,reason:'The first 5-minute NIFTY candle has invalid prices.' };
  if (opening.time+300_000>now) return { ...setup,ready:false,direction:null,reason:'Opening range is still forming; scan after 09:20 IST.' };
  const last=today.filter(c=>c.time>opening.time&&c.time+300_000<=now).at(-1);
  if (!last || now-last.time>7*60_000) return { ...setup,ready:false,direction:null,reason:'Waiting for a fresh completed 5-minute NIFTY candle.' };
  const close=Number(last.close);
  if (close>high) return { ...setup,ready:true,direction:'BUY_CE',breakoutAt:last.time,breakoutClose:close,reason:'Completed 5-minute close above opening-range high.' };
  if (close<low) return { ...setup,ready:true,direction:'BUY_PE',breakoutAt:last.time,breakoutClose:close,reason:'Completed 5-minute close below opening-range low.' };
  return { ...setup,ready:true,direction:null,lastClose:close,reason:`Waiting for a completed 5-minute close above ${high} or below ${low}.` };
}

export function openingRangeBreakout1m(candles, now = Date.now(), rangeSource = null) {
  const day = ist(now).day;
  const today = candles.filter(c => ist(c.time).day === day).sort((a,b) => a.time-b.time);
  // Use the same confirmed 09:15–09:20 index range that is drawn on the chart.
  // Rebuilding it from five separate 1m rows made scans fail when Dhan omitted a
  // quiet minute or returned a slightly different timestamp for one of those rows.
  const rangeStart = Number(rangeSource?.rangeStart), rangeEnd = Number(rangeSource?.rangeEnd);
  const high = Number(rangeSource?.high), low = Number(rangeSource?.low);
  if (!Number.isFinite(rangeStart) || ist(rangeStart).day !== day || !Number.isFinite(rangeEnd)
    || now < rangeEnd || !(Number.isFinite(high) && Number.isFinite(low) && high > low))
    return { ready:false, direction:null, reason:rangeSource?.reason || 'Today’s first five-minute NIFTY opening range is not available yet.' };
  const setup = { ready:true, direction:null, rangeStart, rangeEnd, high, low, interval:'5m', rangeCandles:5 };
  if (!(Number.isFinite(high)&&Number.isFinite(low)&&high>low))
    return { ...setup, ready:false, reason:'The opening-range candles have invalid prices.' };
  // Same rule as the backtest: breakout candle closes beyond the range, then the next candle must
  // trade beyond that candle's high (CE) / low (PE). Unconfirmed breakouts are skipped.
  const seconds = today.map(c => ({ ...c, time:Math.floor(c.time / 1000) }));
  // Several trades a day: act on the latest confirmed breakout, or on a pending one formed after it.
  const { signals, pending } = confirmedRangeBreakouts(seconds, { high, low, end:Math.floor(rangeEnd / 1000) }, { now });
  const signal = signals.at(-1), tradeNumber = signals.length;
  if (pending) {
    const side = pending.direction === 'CE' ? 'high' : 'low';
    return { ...setup, breakoutAt:pending.breakoutAt * 1000, breakoutClose:pending.breakoutClose,
      reason:`1-minute breakout candle at ${ist(pending.breakoutAt * 1000).hhmm} closed ${pending.direction === 'CE' ? 'above' : 'below'} the opening range. Waiting for the next candle to break its ${side} ${pending.level} and close ${pending.direction === 'CE' ? 'green' : 'red'} with a real body (at least 30% of its range).` };
  }
  if (!signal) return { ...setup, reason:`No confirmed opening-range breakout yet today (range ${low}–${high}; a 1-minute close beyond it must be followed by a candle breaking that candle's high/low).` };
  const direction = `BUY_${signal.direction}`, breakoutAt = signal.breakoutAt * 1000, confirmedAt = signal.entryAt * 1000;
  const detail = { breakoutAt, breakoutClose:signal.breakoutClose, confirmedAt, triggerLevel:signal.entry, tradeNumber };
  if (now-(confirmedAt+60_000)>3*60_000)
    return { ...setup, ...detail, direction, stale:true,
      reason:`Latest confirmed breakout (trade ${tradeNumber} today) is stale; showing analysis for review only. Waiting for the next breakout.` };
  return { ...setup, ...detail, direction,
    reason:`Breakout candle closed ${direction==='BUY_CE'?'above':'below'} the opening range and the next candle broke its ${direction==='BUY_CE'?'high and closed green':'low and closed red'}.` };
}

// The per-trade budget splits the daily stop-loss over the trades-per-day number. With the trade cap
// switched off that number still sets the size of each trade; it just no longer limits the count.
export function signalBudget(rules, capital, pnl = 0) {
  if (!rules?.maxLoss?.on || !(capital > 0)
    || !Number.isInteger(rules.maxTrades.value) || rules.maxTrades.value < 1) return null;
  const daily = limitAmount(rules.maxLoss, capital);
  if (!Number.isFinite(daily) || daily <= 0 || !Number.isFinite(pnl)) return null;
  const perTrade = Math.floor(daily / rules.maxTrades.value * 100) / 100;
  return { capital, daily, trades: rules.maxTrades.value, dailyPct: daily / capital * 100,
    percent: daily / rules.maxTrades.value / capital * 100, perTrade,
    available: Math.max(0, Math.min(perTrade, daily + Math.min(0, pnl))), capitalLimit: capitalLimit(rules, capital) };
}

export function sizeSwingTrade(candles, { entry, tickSize, lotSize, budget, funds, now = Date.now(), beforeTime, intervalMs = 300_000 }) {
  if (![budget,funds].every(n => Number.isFinite(n) && n > 0)) return null;
  const swing = swingStopFor(candles, { entry,tickSize,lotSize,now,beforeTime,intervalMs });
  if (!swing) return null;
  const perUnit = entry - swing.stop;
  const lots = Math.floor(Math.min(budget / (perUnit * lotSize), funds / (entry * lotSize)));
  if (lots < 1) return null;
  const quantity = lots * lotSize;
  return { entry, ...swing, tickSize, lotSize, lots, quantity,
    risk: Math.ceil(perUnit * quantity * 100 - 1e-8) / 100, premium: Math.ceil(entry * quantity * 100) / 100 };
}

export function swingStopFor(candles, { entry, tickSize, lotSize, now = Date.now(), beforeTime, intervalMs = 300_000 }) {
  if (![entry, tickSize, lotSize].every(n => Number.isFinite(n) && n > 0) || !Number.isInteger(lotSize)) return null;
  const cutoff = Number.isFinite(beforeTime) ? Math.min(now,beforeTime) : now;
  const bars = candles.filter(c => c.time + intervalMs <= cutoff && [c.low,c.high,c.open,c.close].every(n => Number.isFinite(n) && n > 0))
    .sort((a,b) => a.time - b.time).slice(-60);
  if (bars.length < 5 || now - bars.at(-1).time > 900_000) return null;
  // Two completed candles on each side confirm the previous option swing low.
  for (let i = bars.length - 3; i >= 2; i--) {
    const swing = bars[i];
    if (![bars[i-2],bars[i-1],bars[i+1],bars[i+2]].every(c => c.low > swing.low)) continue;
    const stop = Math.round((Math.ceil(swing.low / tickSize - 1e-8) - 1) * tickSize * 10000) / 10000;
    if (!(stop > 0 && entry > swing.low) || bars.slice(i+1).some(c => c.low <= stop)) return null;
    const perUnit = entry - stop;
    return { stop, swingLow:swing.low, swingAt:swing.time,
      oneLotRisk:Math.ceil(perUnit * lotSize * 100 - 1e-8) / 100 };
  }
  return null;
}
