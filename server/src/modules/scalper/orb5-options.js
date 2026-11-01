// Actual-options mode for the Nifty 5-Minute ORB backtest. Every trade is a BUY: CE for a CE signal,
// PE for a PE signal. Entries, stops, targets and exits are decided on NIFTY (orb5.js); this module only
// prices them with the selected contract's own historical premiums. Never estimates premiums from points.
//   Contract: chosen with what was known at the signal candle: Dhan's rolling ATM in that minute, moved
//     `moneyness` strikes in the money (positive) or out of the money (negative). Held to the exit.
//   Entry: that contract's open in the execution minute, plus slippage.
//   Exit: the open of the exit minute for exits that happen at an open (gap, back-inside, square-off),
//     otherwise that minute's close (NIFTY touched the stop/target inside it), minus slippage.
//   Costs: brokerage per order, STT on the sell side, exchange transaction charges, SEBI fees, stamp duty
//     on the buy side and GST, at the rates in force on the trade date. Lot size follows NSE's revisions.
import { niftyLotSize, monthlyExpiry, weeklyExpiry } from './option-backtest.js';
import { istDay, istTime, tradeStats } from './orb5.js';

export const ORB5_OPTION_DEFAULTS = { expiry:'W1', moneyness:0, lots:1, brokeragePerOrder:20, slippagePerUnit:0.5, statutoryCharges:true };
export const ORB5_EXPIRIES = { W1:{ flag:'WEEK', code:1, label:'Weekly (nearest)' }, W2:{ flag:'WEEK', code:2, label:'Weekly (next)' },
  M1:{ flag:'MONTH', code:1, label:'Monthly (current)' } };
const STEP = 50, MAX_OFFSET = 10, CONTEXT = 15 * 60;
const round2 = v => Math.round(v * 100) / 100;

/** Charges for one round trip (buy then sell) on the given IST trade date. */
export function optionCharges(day, buyValue, sellValue, { brokeragePerOrder = 20, statutoryCharges = true } = {}) {
  const brokerage = 2 * brokeragePerOrder;
  if (!statutoryCharges) return { brokerage, stt:0, exchange:0, sebi:0, stamp:0, gst:0, total:brokerage };
  const revised = day >= '2024-10-01';                       // STT and NSE charge revision, 1 Oct 2024
  const stt = sellValue * (revised ? 0.001 : 0.000625);
  const exchange = (buyValue + sellValue) * (revised ? 0.0003503 : 0.000503);
  const sebi = (buyValue + sellValue) * 10 / 1e7;            // ₹10 per crore
  const stamp = buyValue * 0.00003;
  const gst = 0.18 * (brokerage + exchange + sebi);
  const parts = { brokerage, stt, exchange, sebi, stamp, gst };
  return Object.fromEntries([...Object.entries(parts).map(([k, v]) => [k, round2(v)]), ['total', round2(Object.values(parts).reduce((a, b) => a + b, 0))]]);
}

export function expiryFor(day, key, tradingDays) {
  return key === 'M1' ? monthlyExpiry(day, tradingDays) : weeklyExpiry(day, ORB5_EXPIRIES[key].code, tradingDays);
}

/**
 * @param trades   filled directional trades from orb5Backtest (no point slippage), in time order
 * @param loadDay  async (day, option, offset) => that day's rolling rows [{time, open, high, low, close, strike}]
 *                 for the configured expiry, `offset` strikes from Dhan's ATM (0 = ATM)
 */
export async function orb5OptionTrades(trades, { loadDay, tradingDays = null, ...settings } = {}) {
  const s = { ...ORB5_OPTION_DEFAULTS, ...settings };
  const out = [], candles = {};
  let unavailable = 0;
  for (const trade of trades) {
    const day = istDay(trade.time), option = trade.direction;
    const expiry = expiryFor(day, s.expiry, tradingDays);
    const atm = await loadDay(day, option, 0);
    const atSignal = atm.find(row => row.time === trade.signalAt);
    const missing = reason => { unavailable++; out.push({ ...trade, option:{ type:option, expiry, skipped:reason } }); };
    if (!atSignal) { missing('No option data at the signal candle'); continue; }
    // ITM is below ATM for a call and above it for a put.
    const strike = atSignal.strike + (option === 'CE' ? -1 : 1) * s.moneyness * STEP;
    // Load this contract only around the trade (15 min either side, for the chart): following one strike
    // through a whole session can take ~20 offset series as the ATM moves away from it.
    const from = trade.signalAt - CONTEXT, to = trade.exitAt + CONTEXT;
    const offsets = new Set(atm.filter(row => row.time >= from && row.time <= to).map(row => Math.round((strike - row.strike) / STEP)));
    const fixed = new Map();
    for (const offset of [...offsets].sort((a, b) => Math.abs(a) - Math.abs(b))) {
      if (Math.abs(offset) > MAX_OFFSET) continue;
      for (const row of offset === 0 ? atm : await loadDay(day, option, offset))
        if (row.strike === strike && row.time >= from && row.time <= to && !fixed.has(row.time)) fixed.set(row.time, row);
    }
    const rows = [...fixed.values()].filter(row => { const t = istTime(row.time); return t >= '09:15' && t < '15:30'; }).sort((a, b) => a.time - b.time);
    candles[trade.time] = rows.map(({ time, open, high, low, close }) => ({ time, open, high, low, close }));
    const entryBar = fixed.get(trade.entryAt);
    if (!entryBar) { missing('No option price in the execution minute'); continue; }
    // Exit minute bar, or the last bar before it if that minute did not trade.
    const exitBar = fixed.get(trade.exitAt) || rows.filter(row => row.time <= trade.exitAt).at(-1);
    if (!exitBar || exitBar.time < trade.entryAt) { missing('No option price at the exit'); continue; }
    const exactExit = exitBar.time === trade.exitAt;
    const entry = round2(Number(entryBar.open) + s.slippagePerUnit);
    const exitRaw = trade.exitAtOpen && exactExit ? Number(exitBar.open) : Number(exitBar.close);
    const exit = round2(Math.max(0.05, exitRaw - s.slippagePerUnit));
    const lotSize = niftyLotSize(day), quantity = s.lots * lotSize;
    const charges = optionCharges(day, entry * quantity, exit * quantity, s);
    const gross = round2((exit - entry) * quantity), net = round2(gross - charges.total);
    out.push({ ...trade, option:{ type:option, strike, expiry, expiryKey:s.expiry, moneyness:s.moneyness, lots:s.lots, lotSize, quantity,
      entry, exit, exitAt:trade.exitAt, exitReason:trade.exitReason, exitPriceFrom:exactExit ? (trade.exitAtOpen ? 'open' : 'close') : 'previous bar close',
      sl:null, premiumPoints:round2(exit - entry), gross, charges, pnl:net, capitalUsed:round2(entry * quantity),
      returnPct:round2((exit - entry) / entry * 100), result:net > 0 ? 'WIN' : net < 0 ? 'LOSS' : 'FLAT' } });
  }
  const priced = out.filter(t => !t.option.skipped);
  let equity = 0;
  const equityCurve = priced.map(t => ({ time:t.exitAt, value:round2(equity += t.option.pnl) }));
  const days = new Map();
  for (const t of priced) days.set(t.day, round2((days.get(t.day) || 0) + t.option.pnl));
  return { trades:out, candles, equityCurve, dailyPnl:Object.fromEntries(days),
    summary:{ ...tradeStats(priced.map(t => t.option.pnl)), mode:'options', unit:'rupees', unavailable, settings:s,
      grossPnl:round2(priced.reduce((sum, t) => sum + t.option.gross, 0)), charges:round2(priced.reduce((sum, t) => sum + t.option.charges.total, 0)) } };
}
