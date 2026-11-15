package com.nexlogic.tradelock.ui.screens

/**
 * The built-in strategies, described exactly as TradeLock runs them.
 * COPY of web/js/pages/strategy-library.js (BUILT_IN, PUBLIC_GAP, PUBLIC_RETEST, SHARED_RULES, PUBLIC_SHARED_RULES):
 * when a strategy's rules change there, change them here too.
 */
data class BuiltIn(val key: String, val name: String, val tag: String, val timeframe: String, val auto: Boolean, val paper: Boolean = false, val rules: List<Pair<String, String>>)

val BUILT_IN = listOf(
    BuiltIn("orb", "ORB 5m", "Opening-range breakout", "5-minute", true, rules = listOf(
        "Opening range" to "High and low of the 09:15–09:20 index 5-minute candle.",
        "Breakout candle" to "A 5-minute candle closes above the OR High (CE) or below the OR Low (PE).",
        "Confirmation" to "The next 5-minute candle trades beyond the breakout candle’s high (CE) / low (PE), closes green (CE) / red (PE) with a body of at least 30% of its range.",
        "Filter" to "At that close, RSI 14 must be between 25 and 75 (not overbought / oversold), and EMA 9 must be above EMA 21 for CE / below for PE by at least 0.02% of NIFTY (≈ 4.6 points). Otherwise the signal is skipped.",
        "Entry" to "Right after the confirming candle closes (within 45 seconds), market buy.",
        "More trades" to "Several a day. The opposite side can trigger any time; the same side again only after a close back inside the range.",
        "Stop-loss" to "1 tick below the low of the option’s own 5-minute breakout candle, placed at Dhan.",
    )),
    BuiltIn("emaCross", "EMA 5/9 crossover 1m", "Fast trend change", "1-minute", true, rules = listOf(
        "Signal" to "A completed 1-minute index candle where EMA 5 crosses above EMA 9 (CE) or below it (PE). The averages are seeded from the previous session, as on the chart.",
        "Entry" to "Right after that candle closes (within 45 seconds), market buy of the ATM option of the next expiry.",
        "Stop-loss" to "1 tick below the low of the option’s own 1-minute crossover candle, placed at Dhan.",
        "Exit" to "At market when a completed 1-minute candle shows the opposite crossover (EMA 5 back below EMA 9 for CE, above for PE), or the stop-loss, or the cutoff. No reversal into the other side.",
        "Together with ORB" to "One trade at a time, sharing the day’s stop-loss. Replaced the 5-minute EMA 9/21 crossover on 28 Oct 2026.",
    )),
    BuiltIn("ema915", "EMA 9/15 5m · 30° angle", "Steep trend change", "5-minute", true, rules = listOf(
        "Signal" to "EMA 9 crosses above EMA 15 (CE) or below it (PE) on completed 5-minute index candles. The averages are seeded from the previous sessions, as on the chart.",
        "30° angle" to "EMA 9 must be rising (CE) / falling (PE) at 30° or steeper: angle = atan(EMA 9’s change over the candle ÷ ATR 14). So 30° means EMA 9 moved at least 0.58 × a typical 5-minute candle’s range, on any chart zoom.",
        "Entry" to "On the first completed candle of the new trend, the crossover candle or up to 3 candles after it, that reaches 30°: market buy of the ATM option of the next expiry, right after that candle closes (within 45 seconds). One trade per crossover.",
        "Stop-loss" to "1 tick below the low of the option’s own 5-minute signal candle, placed at Dhan.",
        "Exit" to "At market after the first opposite-colour 5-minute index candle since the entry (red for CE, green for PE), or the stop-loss, or the cutoff.",
        "Backtest" to "1 lot, after charges. Without the angle it loses heavily (5 years: −₹4.9 L). At 30°: last year about 7 trades a month, 44% winners, +₹23,000; over 5 years 6 a month, 36% winners, about break-even (+₹12,600 in all, worst drawdown ₹19,800). Run it yourself: Backtest → Strategy → EMA 9/15 5m.",
    )),
    BuiltIn("strangle", "CE + PE at a target price", "Both sides daily · cheap far options", "1-minute", true, rules = listOf(
        "Entry" to "Every trading day from the entry time (09:20): buy BOTH the NIFTY call and the put whose last price is nearest the target (₹4) within the price band (±90%), out of the money and traded today, of the nearest expiry (the next expiry on an expiry day). If one is not there yet, it looks again every 20 seconds until the entry time + the wait (25 minutes). Market buys, call first.",
        "Size" to "Equal lots of both: the funds share (100%) of your available funds, within your Capital per trade (Risk rules), at most the max % (10%) of the quantity the thinner option has traded so far today.",
        "Stop" to "Each option on its own: sold at market once a completed 1-minute candle closes 20% below its entry. No stop order sits at Dhan (a dip inside a minute would hit it). The other option keeps running.",
        "Exit" to "Whatever is still open is sold at market at the exit time (15:25), or at your Risk rules cutoff when that is earlier. Your daily loss limit still closes everything when it is hit.",
        "Risk gate" to "The call and the put count as one trade: the trade cap and the capital per trade apply to the pair. Switched on per index, each index holds its own pair.",
        "Backtest" to "Backtest → CE + PE at a target price (all strikes): the strikes far from the money are saved daily from Sep 2026, so the history is short; it made most of its money on a few big trend days.",
    )),
    BuiltIn("gap", "Gap open 09:15", "Opening gap · full capital", "1-minute", true, rules = listOf(
        "Signal" to "Once, on the first tick after 09:15:00, from the ATM option premiums (strike nearest NIFTY): the CE or PE whose premium opened above its previous close (gap up) is bought. Both CE and PE gapped up, or neither → no trade that day.",
        "Entry" to "As many lots of the ITM2 option (two strikes in the money) of the nearest expiry as your Capital per trade (Risk rules) buys at the premium at that instant, never more than your available funds; with that rule off, 80% of the available funds. Market buy.",
        "Exit" to "At market at 09:16:00, whatever the colour of the 09:15 candle (about one minute after the entry), or the stop-loss before then. The stop order is cancelled first.",
        "Prices" to "Live Dhan ticks (WebSocket), checked every few milliseconds from 09:15:00 for the decision, and for the 1-minute exit candles the moment each minute closes; Dhan’s REST prices take over whenever the live feed is down or late.",
        "Stop-loss" to "From your Risk rules: the day’s stop-loss left (daily loss limit − today’s loss) ÷ the quantity, below the fill, placed at Dhan. A stop hit loses about your daily limit. If that is under 1% of the premium, no trade.",
        "Note" to "Size ignores the day’s stop-loss: a fall to the stop loses your daily stop-loss. Backtest: needs 10-second data we don’t have, so results are unproven.",
    )),
    BuiltIn("gapRetest", "Gap wick 09:15", "Paper trading · entry after the opening wick", "live ticks", true, paper = true, rules = listOf(
        "Paper only" to "Runs on live prices with simulated fills: no order ever goes to your broker. Its trades are listed under Paper trades on the AI Algo Trading page, apart from your real trades. Runs while Algo Trading is started.",
        "Signal" to "The same 09:15 decision as Gap open 09:15: the ATM CE or PE whose premium opened above its previous session’s last trade (one side only), and the same ITM2 contract.",
        "Entry" to "Not blindly on the first tick: inside the 09:15 minute it waits for NIFTY to wick against the trade and turn. CE: NIFTY trades below its 09:15 open, then the moment it is back above the open, buy. PE: above the open, then back below it. No wick and turn by 09:15:59 → no trade.",
        "Stop-loss" to "One tick below the option’s lowest price so far in the 09:15 minute (the low of its wick). Lots are cut if that stop would risk more than the day’s stop-loss left.",
        "Exit" to "At 09:16:00, as Gap open 09:15, or the stop-loss before then. P&L after charges.",
        "Size" to "As Gap open 09:15: your Capital per trade (Risk rules), within what a market order could use.",
        "Backtest" to "Not available: the wick and the turn happen within seconds, and the stored history has 1-minute candles only. Paper trading is how to test it.",
    )),
    BuiltIn("hammer", "Hammer 1m", "EMA45 wick rejection", "1-minute", false, rules = listOf(
        "CE setup" to "Hammer: body fully above EMA 45, lower wick touches EMA 45 and is at least as long as the body.",
        "PE setup" to "Inverted hammer: body fully below EMA 45, upper wick touches EMA 45 and is at least as long as the body.",
        "Filter" to "The candle before the hammer has its body clear of the EMA 45 / EMA 105 zone.",
        "Confirmation" to "The next completed 1-minute candle breaks the hammer’s high (CE) / low (PE).",
        "Use" to "Chart signal and backtest only (Power Scalper 1-minute chart). Not traded automatically.",
    )),
    BuiltIn("ema35", "EMA 3/5 1m", "Fast EMA crossover scalp", "1-minute", false, rules = listOf(
        "Entry" to "A completed 1-minute index candle where EMA 3 crosses above EMA 5: buy the ATM CE. Crosses below: buy the ATM PE.",
        "Exit" to "The opposite crossover closes the trade and enters the other side (always in the market), or the 15:15 square-off.",
        "Stop / target" to "None: the opposite crossover is the exit.",
        "Use" to "Chart signal (Power Scalper: the EMA 3/5 1m switch) and backtest (Backtest → Strategy → EMA 3/5 crossover 1m). Not traded automatically.",
    )),
)

/** What users (not administrators) see: the default strategy and the paper one, without their exact rules. */
val PUBLIC_BUILT_IN = listOf(
    BuiltIn("gap", "Gap open 09:15", "Opening strategy", "fully automatic", true, rules = listOf(
        "What it does" to "Trades the market open, at most once a day, fully automatically on your Dhan account.",
        "Stop-loss" to "Set from your Risk rules and placed at your broker with every entry.",
        "Exit" to "Closed automatically by the strategy, by the stop-loss, or at your cutoff.",
    )),
    BuiltIn("gapRetest", "Gap wick 09:15", "Paper trading", "fully automatic", true, paper = true, rules = listOf(
        "Paper only" to "Runs on live prices with simulated fills: no order ever goes to your broker. Its trades are listed under Paper trades on the AI Algo Trading page. Runs while Algo Trading is started.",
        "What it does" to "Trades the market open like Gap open 09:15, but waits within the first minute for a pullback against the trade before buying, with a stop-loss just below that pullback.",
        "Exit" to "Closed automatically at the end of the first minute, or by the stop-loss.",
    )),
)

val SHARED_RULES = listOf(
    "Contract" to "ATM option of the next expiry (the one after the nearest) on the index you trade: CE for up signals, PE for down signals.",
    "Size" to "Whole lots so the stop-loss risks all of the day’s stop-loss still left (daily loss limit − today’s loss), within your funds and the exchange freeze limit. If 1 lot risks more, the signal is skipped.",
    "Exit" to "Whichever comes first: the stop-loss fills; the strategy’s own exit; your manual exit; or the cutoff square-off.",
    "Cost to cost" to "Once the option trades at entry + 1 × the risk (entry − stop-loss), the stop-loss order at Dhan moves up to the entry price: from then on the trade can lose only charges and a little slippage.",
    "Live ticks" to "Signals and exits are decided on live Dhan ticks (WebSocket): each 1- and 5-minute index candle is built from the feed and acted on the moment it closes.",
    "Phone alarm" to "Each entry rings the TradeLock Android app like an alarm, even closed, on silent or in DND.",
)
val PUBLIC_SHARED_RULES = listOf(
    "Size" to "Sized from your available funds and your Risk rules.",
    "Stop-loss" to "Every entry gets its stop-loss order at your broker straight away.",
    "Risk rules" to "Every entry passes your Risk rules: daily loss limit, cutoff, trade cap (if on), kill switch. Each strategy holds one trade at a time per index; different strategies and indices run side by side.",
    "Phone alarm" to "Each entry rings the TradeLock Android app like an alarm, even closed, on silent or in DND.",
)
