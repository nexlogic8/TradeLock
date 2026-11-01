// Option backtest: the index supplies the entry signal; the trade itself is a buy of the ATM NIFTY option
// (CE for a CE signal, PE for a PE signal) in the 2nd weekly expiry, held on the strike it entered, and
// both the stop and the exit are read from that option's own premium candles.
//   Entry: the option's close in the index entry minute. Strike = Dhan's ATM in that minute.
//   SL (stopLogic 'breakoutCandle'): the option candle in the index breakout minute; the position is long
//     premium, so the stop is that candle's low.
//   Exit: the chosen exit rule run on the option candles as a long position (level rejection from the
//     premium's high, previous swing low, or a fixed number of minutes); otherwise the session close.
//   Size: whole lots. lots = floor(capital / (entry × lot size)); trades that cannot afford a lot are
//     skipped. sizing 'compound' (default) uses 100% of the running capital; 'fixed' the same each trade.
// Rupee figures exclude brokerage, taxes and slippage.
import { backtestSignals } from '../../../../web/js/pages/scalper-chart-signals.js';

export const OPTION_BACKTEST = { expiryCode:2, strikeStep:50, maxOffset:10, defaultCapital:10_000, maxDays:92,
  sizings:['compound', 'fixed'], exitRules:['horizon', 'swingSL', 'levelReject'] };

// NSE NIFTY lot size by trade date (effective dates of the published revisions).
const NIFTY_LOT_SIZES = [
  ['2025-12-30', 65],
  ['2024-11-20', 75],
  ['2024-04-26', 25],
  ['2021-07-30', 50],
  ['0000-00-00', 75],
];
export const niftyLotSize = day => NIFTY_LOT_SIZES.find(([from]) => day >= from)[1];

const istDay = seconds => new Date(seconds * 1000 + 19_800_000).toISOString().slice(0, 10);
const inSession = seconds => { const hhmm = new Date(seconds * 1000 + 19_800_000).toISOString().slice(11, 16); return hhmm >= '09:15' && hhmm < '15:30'; };
const addDays = (day, n) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const weekday = day => new Date(`${day}T00:00:00Z`).getUTCDay();

// NIFTY weekly expiry: Thursday until August 2025, Tuesday from September 2025. When `tradingDays`
// covers the date and the market was shut, the expiry moves to the previous trading day.
function weeklyExpiryOnOrAfter(day, tradingDays, lastKnownDay) {
  for (let d = day; ; d = addDays(d, 1)) {
    if (weekday(d) !== (d >= '2025-09-01' ? 2 : 4)) continue;
    let expiry = d;
    if (tradingDays && d <= lastKnownDay) while (!tradingDays.has(expiry) && expiry > day) expiry = addDays(expiry, -1);
    if (expiry >= day) return { date:expiry, estimated:!tradingDays || d > lastKnownDay };
  }
}
/** Dhan expiryCode 1 = the nearest weekly expiry (today's on expiry day), 2 = the one after it. */
export function secondWeeklyExpiry(day, tradingDays = null) { return weeklyExpiry(day, 2, tradingDays); }
export function weeklyExpiry(day, n, tradingDays = null) {
  const lastKnownDay = tradingDays ? [...tradingDays].sort().at(-1) : null;
  let expiry = weeklyExpiryOnOrAfter(day, tradingDays, lastKnownDay);
  for (let k = 1; k < n; k++) expiry = weeklyExpiryOnOrAfter(addDays(expiry.date, 1), tradingDays, lastKnownDay);
  return expiry;
}
/** Current monthly expiry: the last weekly-expiry weekday of the month (moved back for holidays). */
export function monthlyExpiry(day, tradingDays = null) {
  const lastKnownDay = tradingDays ? [...tradingDays].sort().at(-1) : null;
  for (let month = day.slice(0, 7); ; month = addDays(`${month}-28`, 7).slice(0, 7)) {
    let last = addDays(`${addDays(`${month}-28`, 7).slice(0, 7)}-01`, -1);
    while (weekday(last) !== (last >= '2025-09-01' ? 2 : 4)) last = addDays(last, -1);
    let expiry = last;
    if (tradingDays && last <= lastKnownDay) while (!tradingDays.has(expiry) && expiry > `${month}-01`) expiry = addDays(expiry, -1);
    if (expiry >= day) return { date:expiry, estimated:!tradingDays || last > lastKnownDay };
  }
}

/**
 * @param signals  index entry signals (epoch-second time, direction, breakoutAt for opening range)
 * @param loadDay  async (day, option, offset) => that day's 1m rows [{time, open, high, low, close, strike}]
 *                 for the contract `offset` strikes from Dhan's rolling ATM (0 = ATM)
 * @param indexAt  time => NIFTY close in that minute (for the index move over the option trade)
 * @returns trades (signal + option result), summary, and candles: { [signal.time]: option rows for the chart }
 */
export async function optionTrades(signals, { loadDay, indexAt = () => null, tradingDays = null, capital = OPTION_BACKTEST.defaultCapital,
  stopLogic = 'none', sizing = 'compound', exitLogic = 'levelReject', horizonBars = 10 } = {}) {
  const out = [], candles = {};
  let unaffordable = 0, unavailable = 0, equity = capital;
  const skip = (signal, option) => out.push({ ...signal, option:{ ...option, capitalBefore:equity, capitalAfter:equity } });
  for (const signal of [...signals].sort((a, b) => a.time - b.time)) {
    const day = istDay(signal.time), option = signal.direction;
    const expiry = secondWeeklyExpiry(day, tradingDays);
    const atm = await loadDay(day, option, 0);
    const entryRow = atm.find(row => row.time === signal.time);
    if (!entryRow) { unavailable++; skip(signal, { expiry, skipped:'No option price at entry' }); continue; }
    const strike = entryRow.strike;
    // Follow this one contract through the whole session as the ATM rolls around it.
    const offsets = new Set(atm.map(row => Math.round((strike - row.strike) / OPTION_BACKTEST.strikeStep)));
    const fixed = new Map();
    for (const offset of [...offsets].sort((a, b) => Math.abs(a) - Math.abs(b))) {
      if (Math.abs(offset) > OPTION_BACKTEST.maxOffset) continue;
      for (const row of offset === 0 ? atm : await loadDay(day, option, offset)) if (row.strike === strike && !fixed.has(row.time)) fixed.set(row.time, row);
    }
    // Dhan's option series runs past the close (to about 15:40); trade only the 09:15-15:29 session bars.
    const rows = [...fixed.values()].filter(row => inSession(row.time)).sort((a, b) => a.time - b.time)
      .map(({ time, open, high, low, close }) => ({ time, open, high, low, close }));
    candles[signal.time] = rows;
    const entry = entryRow.close;
    const lotSize = niftyLotSize(day), sizingCapital = sizing === 'compound' ? equity : capital;
    const lots = Math.max(0, Math.floor(sizingCapital / (entry * lotSize)));
    const base = { strike, type:option, expiry, expirySlot:OPTION_BACKTEST.expiryCode, entry, lotSize, lots, quantity:lots * lotSize };
    if (lots < 1) { unaffordable++; skip(signal, { ...base, skipped:`One lot costs ₹${Math.round(entry * lotSize).toLocaleString('en-IN')}; capital ₹${Math.round(sizingCapital).toLocaleString('en-IN')}` }); continue; }
    // Run the exit rule on the premium as a long position. A stop at or above the entry would be
    // breached the moment the trade opens, so it is ignored.
    const breakoutRow = Number.isFinite(signal.breakoutAt) ? fixed.get(signal.breakoutAt) : null;
    const useStop = stopLogic === 'breakoutCandle' && breakoutRow && breakoutRow.low < entry;
    const premiumSignal = { time:signal.time, direction:'CE', entry, breakoutAt:signal.breakoutAt, breakoutLow:breakoutRow?.low, breakoutHigh:breakoutRow?.high };
    const [exitTrade] = backtestSignals([premiumSignal], rows, { exitLogic, horizonBars, stopLogic:useStop ? 'breakoutCandle' : 'none' }).trades;
    if (!exitTrade) {
      unavailable++;
      skip(signal, { ...base, skipped:exitLogic === 'swingSL' ? 'No confirmed option swing low before entry' : 'No option price after entry' });
      continue;
    }
    const exit = exitTrade.exit, exitAt = exitTrade.exitAt;
    const exitReason = exitTrade.exitReason === 'Stop loss (breakout candle)' ? 'Option SL (breakout candle)' : exitTrade.exitReason;
    const pnl = Math.round((exit - entry) * base.quantity * 100) / 100, capitalBefore = equity;
    equity = Math.round((equity + pnl) * 100) / 100;
    const indexExit = indexAt(exitAt);
    const points = Number.isFinite(indexExit) ? Math.round((option === 'CE' ? indexExit - signal.entry : signal.entry - indexExit) * 100) / 100 : null;
    const result = pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : 'FLAT';
    out.push({ ...signal, exitAt, exit:indexExit, exitReason, points, result,
      option:{ ...base, sl:useStop ? breakoutRow.low : null, stopLevel:exitTrade.stopLevel ?? null, rejectLevel:exitTrade.rejectLevel ?? null,
        breakoutLow:breakoutRow?.low ?? null, exit, exitAt, exitReason, premiumPoints:Math.round((exit - entry) * 100) / 100, pnl,
        returnPct:Math.round((exit - entry) / entry * 10_000) / 100, capitalBefore, capitalAfter:equity,
        capitalUsed:Math.round(entry * base.quantity * 100) / 100, result } });
  }
  const traded = out.filter(t => t.option && !t.option.skipped);
  const wins = traded.filter(t => t.option.pnl > 0).length;
  const totalPnl = Math.round(traded.reduce((sum, t) => sum + t.option.pnl, 0) * 100) / 100;
  // Drawdown on the running capital: largest fall from a previous high, in rupees and percent.
  let peak = capital, maxDrawdown = 0, maxDrawdownPct = 0;
  for (const t of traded) {
    peak = Math.max(peak, t.option.capitalAfter);
    maxDrawdown = Math.max(maxDrawdown, peak - t.option.capitalAfter);
    maxDrawdownPct = Math.max(maxDrawdownPct, (peak - t.option.capitalAfter) / peak * 100);
  }
  return { trades:out, candles, summary:{ capital, sizing, exitLogic, endCapital:equity, returnPct:Math.round((equity - capital) / capital * 10_000) / 100,
    maxDrawdownPct:Math.round(maxDrawdownPct * 100) / 100, expirySlot:OPTION_BACKTEST.expiryCode, stopLogic, traded:traded.length, unaffordable, unavailable,
    wins, losses:traded.filter(t => t.option.pnl < 0).length, winRate:traded.length ? wins / traded.length * 100 : 0,
    totalPnl, averagePnl:traded.length ? Math.round(totalPnl / traded.length * 100) / 100 : 0, maxDrawdown:Math.round(maxDrawdown * 100) / 100 } };
}
