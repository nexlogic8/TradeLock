// The built-in strategies, described exactly as TradeLock runs them (server: scalper/autotrade.js and
// scalper-chart-signals.js). Shared by the AI Algo Trading and Strategy pages so they never disagree.
export const BUILT_IN = [
  { key: 'orb', flag: 'orbOn', name: 'ORB 5m', tag: 'Opening-range breakout', timeframe: '5-minute', auto: true, rules: [
    ['Opening range', 'High and low of the 09:15–09:20 index 5-minute candle.'],
    ['Breakout candle', 'A 5-minute candle closes above the OR High (CE) or below the OR Low (PE).'],
    ['Confirmation', 'The next 5-minute candle trades beyond the breakout candle’s high (CE) / low (PE), closes green (CE) / red (PE) with a body of at least 30% of its range.'],
    ['Filter', 'At that close, RSI 14 must be between 25 and 75 (not overbought / oversold), and EMA 9 must be above EMA 21 for CE / below for PE by at least 0.02% of NIFTY (≈ 4.6 points). Otherwise the signal is skipped.'],
    ['Entry', 'Right after the confirming candle closes (within 45 seconds), market buy.'],
    ['More trades', 'Several a day. The opposite side can trigger any time; the same side again only after a close back inside the range.'],
    ['Stop-loss', '1 tick below the low of the option’s own 5-minute breakout candle, placed at Dhan.'],
  ] },
  { key: 'emaCross', flag: 'emaCrossOn', name: 'EMA 5/9 crossover 1m', tag: 'Fast trend change', timeframe: '1-minute', auto: true, rules: [
    ['Signal', 'A completed 1-minute index candle where EMA 5 crosses above EMA 9 (CE) or below it (PE). The averages are seeded from the previous session, as on the chart.'],
    ['Entry', 'Right after that candle closes (within 45 seconds), market buy of the ATM option of the next expiry.'],
    ['Stop-loss', '1 tick below the low of the option’s own 1-minute crossover candle, placed at Dhan.'],
    ['Exit', 'At market when a completed 1-minute candle shows the opposite crossover (EMA 5 back below EMA 9 for CE, above for PE), or the stop-loss, or the cutoff. No reversal into the other side.'],
    ['Together with ORB', 'One trade at a time, sharing the day’s stop-loss. Replaced the 5-minute EMA 9/21 crossover on 28 Oct 2026.'],
  ] },
  { key: 'ema915', flag: 'ema915On', name: 'EMA 9/15 5m · 30° angle', tag: 'Steep trend change', timeframe: '5-minute', auto: true, rules: [
    ['Signal', 'EMA 9 crosses above EMA 15 (CE) or below it (PE) on completed 5-minute index candles. The averages are seeded from the previous sessions, as on the chart.'],
    ['30° angle', 'EMA 9 must be rising (CE) / falling (PE) at 30° or steeper: angle = atan(EMA 9’s change over the candle ÷ ATR 14). So 30° means EMA 9 moved at least 0.58 × a typical 5-minute candle’s range, on any chart zoom.'],
    ['Entry', 'On the first completed candle of the new trend, the crossover candle or up to 3 candles after it, that reaches 30°: market buy of the ATM option of the next expiry, right after that candle closes (within 45 seconds). One trade per crossover.'],
    ['Stop-loss', '1 tick below the low of the option’s own 5-minute signal candle, placed at Dhan.'],
    ['Exit', 'At market after the first opposite-colour 5-minute index candle since the entry (red for CE, green for PE), or the stop-loss, or the cutoff.'],
    ['Backtest', '1 lot, after charges. Without the angle it loses heavily (5 years: −₹4.9 L). At 30°: last year about 7 trades a month, 44% winners, +₹23,000; over 5 years 6 a month, 36% winners, about break-even (+₹12,600 in all, worst drawdown ₹19,800). Run it yourself: Backtest → Strategy → EMA 9/15 5m.'],
  ] },
  { key: 'gap', flag: 'gapOn', name: 'Gap open 09:15', tag: 'Opening gap · full capital', timeframe: '1-minute', auto: true, rules: [
    ['Signal', 'Once, on the FIRST TICK after 09:15:00 (milliseconds after the open), from the ATM option PREMIUMS (strike nearest NIFTY): the CE or PE whose premium opened above its previous close (gap up) is bought. Both CE and PE gapped up, or neither → no trade that day. The expiry and option chain are fetched at 09:13:50; if no first trades arrive by 09:15:02, a price check then decides instead.'],
    ['Entry', 'As many lots of the ITM2 option (two strikes in the money: CE two below the ATM, PE two above) of the NEAREST expiry as 80% of your available funds buys at the premium at that instant, MARKET buy (always fills; the 20% left covers the broker blocking a market order above the last price in a fast open, and a refusal for funds is retried at once with the lots that fit). On StoxKart, which takes no API market orders, it goes as a limit 15% above that price. No lot cap (above the freeze quantity the order and the stop-loss are split). Part not filled within 15 seconds → cancelled.'],
    ['Exit', 'At market at 09:16:00, whatever the colour of the 09:15 candle (about one minute after the entry), or the stop-loss before then. The stop order is cancelled first.'],
    ['Prices', 'Live Dhan ticks (WebSocket), checked every few milliseconds from 09:15:00 for the decision, and for the 1-minute exit candles the moment each minute closes; Dhan’s REST prices take over whenever the live feed is down or late.'],
    ['Stop-loss', 'From your Risk rules: the day’s stop-loss left (daily loss limit − today’s loss) ÷ the quantity, below the fill, placed at Dhan. A stop hit loses about your daily limit. If that is under 1% of the premium, no trade.'],
    ['Note', 'Size ignores the day’s stop-loss: a fall to the stop loses your daily stop-loss. Backtest: needs 10-second data we don’t have, so results are unproven.'],
  ] },
  { key: 'hammer', name: 'Hammer 1m', tag: 'EMA45 wick rejection', timeframe: '1-minute', auto: false, rules: [
    ['CE setup', 'Hammer: body fully above EMA 45, lower wick touches EMA 45 and is at least as long as the body.'],
    ['PE setup', 'Inverted hammer: body fully below EMA 45, upper wick touches EMA 45 and is at least as long as the body.'],
    ['Filter', 'The candle before the hammer has its body clear of the EMA 45 / EMA 105 zone.'],
    ['Confirmation', 'The next completed 1-minute candle breaks the hammer’s high (CE) / low (PE).'],
    ['Use', 'Chart signal and backtest only (Power Scalper 1-minute chart). Not traded automatically.'],
  ] },
  { key: 'ema35', name: 'EMA 3/5 1m', tag: 'Fast EMA crossover scalp', timeframe: '1-minute', auto: false, rules: [
    ['Entry', 'A completed 1-minute index candle where EMA 3 crosses above EMA 5: buy the ATM CE. Crosses below: buy the ATM PE.'],
    ['Exit', 'The opposite crossover closes the trade and enters the other side (always in the market), or the 15:15 square-off.'],
    ['Stop / target', 'None: the opposite crossover is the exit.'],
    ['Use', 'Chart signal (Power Scalper: the EMA 3/5 1m switch) and backtest (Backtest → Strategy → EMA 3/5 crossover 1m). Not traded automatically.'],
  ] },
];

// What every automatic trade does, whichever strategy fired.
export const SHARED_RULES = [
  ['Contract', 'ATM option of the next expiry (the one after the nearest) on the index you trade: CE for up signals, PE for down signals.'],
  ['Size', 'Whole lots so the stop-loss risks all of the day’s stop-loss still left (daily loss limit − today’s loss), within your funds and the exchange freeze limit. If 1 lot risks more, the signal is skipped.'],
  ['Exit', 'Whichever comes first: the stop-loss fills; the strategy’s own exit (ORB: 2 five-minute index closes on the wrong side of EMA 9; EMA 5/9: the opposite crossover on a 1-minute close; EMA 9/15: the first opposite-colour 5-minute candle; Gap: 09:16:00); your manual exit; or the cutoff square-off.'],
  ['Cost to cost', 'Once the option trades at entry + 1 × the risk (entry − stop-loss), the stop-loss order at Dhan moves up to the entry price: from then on the trade can lose only charges and a little slippage. Every strategy, once per trade.'],
  ['Live ticks', 'Signals and exits are decided on live Dhan ticks (WebSocket): each 1- and 5-minute index candle is built from the feed and acted on the moment it closes. Dhan’s REST candles take over whenever the feed is down or joined mid-candle.'],
  ['Risk rules', 'Every entry passes your Risk rules: daily loss limit, cutoff, trade cap (if on), kill switch, one trade at a time.'],
  ['Phone alarm', 'Each entry rings the TradeLock Android app like an alarm, even closed, on silent or in DND.'],
];
