// Live auto-trading (the "Algo Trading" switch): ORB 5m, EMA 5/9 1-minute crossover and Gap 09:15 entries on index options.
// Indices are ticked on the AI Algo Trading page (NIFTY 50 by default; BANK NIFTY and SENSEX supported, any
// combination). Each ticked index is scanned on its own; its candles, chain, contracts and order segment
// follow that index. Risk rules still allow one trade at a time, and the day's stop-loss is shared.
// "NIFTY" below means the index being scanned.
// Runs on the server, so it trades with no screen open.
//
// Third entry (own switch, off by default): Gap open 09:15 — once a day on the FIRST TICK after 09:15:00 (own timer
//   polling the live feed every few ms; the expiry, chain and the options' previous closes are fetched at 09:13:50),
//   the ATM CE or PE whose PREMIUM gapped up (first trade above its previous close) is bought (both or neither → no
//   trade); no wait for the premium to stay green (gap.requireGreen). The feed silent → Dhan's quotes, polled about once a
//   second from 09:15:00.8, decide instead. A rejected entry is placed again (up to MAX_ATTEMPTS; fewer lots for funds).
//   MARKET buy (always fills), sized at the Risk rules' Capital per trade (at most the funds), or with that rule off at
//   80% of the available funds, at the premium now: a broker blocks a market order
//   well above the last price in a fast open (27 Oct: about ₹101 a unit at ₹88.10, so 90% was refused), and a refusal
//   for funds is retried at once with the lots that fit. StoxKart takes no API market orders: there it goes as a limit
//   MARKET_BAND above the first-tick price (no extra price request). No lot cap (sliced above the freeze).
//   The contract bought: GAP_LIVE.strike steps into the money from the ATM (2 = ITM2: CE two strikes below the ATM, PE
//   two above; the Gap backtest's best strike); the signal itself still comes from the ATM premiums.
//   Stop-loss = the day's stop-loss left (Risk rules) spread over the quantity, below the fill,
//   exit at market at 09:16:00 whatever the colour (gap.exitAt; null → the first opposite-colour index 1-minute
//   candle), or the stop before it (gapPick / enterGap / gapExitDue below).
//
// Second entry (the cross_on switch): EMA 5 crossing EMA 9 on a completed 1-minute NIFTY candle (above → CE, below → PE),
//   entered right after that candle closes, SL one tick below the option's own 1-minute crossover candle. Same sizing
//   as ORB. Exit: the opposite crossover on a completed 1-minute candle (no reversal into the other side), the stop,
//   or the cutoff. (Until 28 Oct 2026 this switch traded EMA 9 / EMA 21 on 5-minute candles: crossSetup below.)
// Fourth entry (own switch ema915_on, off by default): EMA 9 / EMA 15 on completed 5-minute candles with EMA 9 at 30° or
//   steeper (EMA_TREND / emaTrendSetup). Same contract, stop and sizing as ORB; exit after the first opposite-colour
//   5-minute candle, the stop, or the cutoff.
//   All strategies share the day's SL and one trade at a time; the first fresh signal wins.
//
// Entry: the confirmed opening-range breakout exactly as the 5-minute Power Scalper chart marks it
//   (scalper-chart-signals.js on 5-minute NIFTY candles, several trades a day). Within ENTRY_WINDOW_MS
//   of the confirming 5-minute candle closing, buy the ATM option of the NEXT expiry (the one after the
//   nearest): CE for an upside break, PE for a downside break, at market.
// Stop-loss: one tick below the LOW of that option's own 5-minute candle for the breakout candle,
//   placed at Dhan straight after the fill as a stop-loss LIMIT sell (exchanges refuse stop-loss
//   market orders on index options); the limit sits SL_LIMIT_BUFFER below the trigger so it fills.
// Size: every signal may use ALL of the day's stop-loss that is left: whole lots so the stop loses at
//   most (daily loss limit + today's P&L when negative), within available funds and the freeze quantity.
//   ₹15,000 limit, first trade closed at −₹5,000 → the next signal risks up to ₹10,000.
// Exit, whichever comes first: the stop-loss; two consecutive completed 5-minute NIFTY candles closing on
//   the wrong side of EMA 9 (above it for a PE, below it for a CE); a manual exit (its stop order is then
//   cancelled); or a square-off at the Risk rules cutoff (15:15 when the cutoff is off). No target.
//   After any exit the next confirmed signal can trade again. Every entry passes the same risk gate as a manual order (trade cap, cutoff, daily loss,
//   kill switch, one trade at a time); a trade already open is managed to its exit even if the switch
//   is turned off.
// Each signal is acted on at most once: its row in auto_trades is written before any order is sent.
import { stmt } from '../../db/index.js';
import { ist, regularMarketOpen as marketOpen, regularTradingDay as isTradingDay, previousTradingDays } from '../../lib/time.js';   // algo: regular sessions only (no Muhurat)
import { accountFor, adapterFor, probeAdapter } from '../broker/registry.js';
import { brokerBusy, switchTradeVia } from '../broker/switch.js';
import { tradingBroker } from '../broker/per-broker.js';
import { getBook, getKillStatus } from '../broker/book.js';
import { getRules } from '../rules/service.js';
import { getSubscription } from '../billing/service.js';
import { checkOrder } from '../risk/gate.js';
import { dayState, capitalFor } from '../risk/service.js';
import { syncAccount } from '../risk/monitor.js';
import { audit } from '../audit/service.js';
import { notify } from '../notifications/service.js';
import { entriesInFlight } from '../orders/routes.js';
import { scalperSignalRisk } from './signals.js';
import { openingRangeBreakout } from './signal-risk.js';
import { confirmedRangeBreakouts, orbEntryFilter } from '../../../../web/js/pages/scalper-chart-signals.js';
import { indexOptionInstruments } from './instruments.js';
import { underlyingFor } from './underlyings.js';
import { normalizeScalperCandles } from './routes.js';
import { algoUnwatch, algoWatch, liveBar, liveMinute, liveTick, onMinuteClose } from './live.js';
import { isAdminUser, withAllowedStrategies } from '../../lib/access.js';
import { tryKillSwitch } from '../emergency/service.js';
import { optionCharges } from './orb5-options.js';
import { NSE_HOLIDAYS } from '../../lib/market-calendar.js';
import { indexView, slotCfg, strategyIndices, STRANGLE_INDEX_TARGETS } from './algo-grid.js';

export const AUTO = Object.freeze({
  tickMs: 5_000,
  entryWindowMs: 45_000,     // a signal older than this (after its confirming 5-minute candle closed) is skipped
  dataGraceMs: 3_000,        // wait this long after a 5-minute candle closes before asking Dhan for it
  dataWaitMs: 40_000,        // ...and keep retrying this long if the closed minute is not in yet
  fillWaitMs: 15_000,
  slLimitBuffer: 0.10,       // stop-loss limit price = trigger − 10%
  maxQty: 1755,              // NIFTY quantity per order at Dhan: above it Dhan splits the order (4 Nov 2026: 2,535 → 1,755 + 780)
  freezeQty: { NIFTY: 1755, BANKNIFTY: 1440, SENSEX: 1000 },   // quantity per order, per index: above it the order goes through Dhan's slicing API (NIFTY: Dhan split at 1,755 on 4 Nov 2026)
  defaultSquareOff: '15:15',
  placingTimeoutMs: 120_000,
  // ORB 5m entry: 'close' = right after the confirming candle closes (it broke the breakout candle's high/low,
  // closed in the trade's colour, body ≥ 30%); 'live' = the moment the next candle trades past that level.
  orbEntry: 'close',
  // Cost to cost, per strategy (R multiple, 0 = off): once the option trades at entry + R × (entry − stop), the
  // stop-loss order at Dhan moves to the entry price. 1R: the Gap backtest (5 years) improved the good case and did
  // not hurt the bad one; 0.5R stopped out at cost too often in the 09:15 noise.
  costToCostR: Object.freeze({ 'ORB 5m': 1, 'EMA 9/21 cross': 1, 'EMA 5/9 1m': 1, 'EMA 9/15 5m': 1, 'Gap 09:15': 1, default: 1 }),
  optionTick: 0.05,          // NIFTY / BANK NIFTY / SENSEX option tick
  // Gap open 09:15 (own switch, gap_on): FIRST_TICK — decided on the ATM options' first trades after 09:15:00, the feed
  // polled every POLL_MS from LEAD_MS before the open until WINDOW_MS after it; from REST_AFTER_MS on, Dhan's quotes are
  // asked too, every REST_EVERY_MS, in case the feed is silent. CHECK_AFTER_MS: a scanner pass (e.g. after a restart) checks
  // with a REST quote from then on when no watcher is running. Expiry, chain and previous close fetched PREFETCH_MS before
  // the open. REQUIRE_GREEN: also need the premium above its open (the old 2-second check). The entry's fill is polled every
  // FILL_POLL_MS; a rejected entry is placed again after RETRY_MS, up to MAX_ATTEMPTS orders in all.
  // MARKET: market buy sized at FUNDS_USE of the available funds at the last price (the rest covers the broker blocking a
  // market order above it; MARKET_BAND: StoxKart's limit above that price instead of a market order); otherwise a limit
  // at the last price + PAD_PCT (at least MIN_PAD), sized at that limit;
  // LOT_CAP false: no cap at the freeze quantity, a bigger order is sliced by Dhan into several (the stop too);
  // stop-loss: the day's stop-loss left (Risk rules daily loss limit − today's loss) ÷ the quantity, below the fill, so the
  // stop loses at most what the rules allow (skipped if that is under MIN_STOP_PCT of the premium); exit on the first
  // opposite-colour index 1-minute candle.
  entryFundsUse: 0.95,   // ORB / EMA entries size on this share of the available funds
  gap: Object.freeze({ firstTick: true, leadMs: 300, pollMs: 5, restAfterMs: 800, restEveryMs: 1_000, requireGreen: false, checkAfterMs: 2_000, windowMs: 20_000, prefetchMs: 70_000,
    fillPollMs: 200, maxAttempts: 3, retryMs: 150, exitAt: '09:16',   // EXIT_AT: market exit at this IST time, any candle colour (null: opposite candle)
    // BLOCK_PAD: a broker blocks a market buy this far above the last price (27 Oct: ₹101 a unit at ₹88.10).
    blockPad: 0.15,
    fundsUse: 0.80, lotCap: false, market: true, marketBand: 0.15, padPct: 0, minPad: 0, minStopPct: 0.01 }),
  // Pre-open (accounts with Gap 09:15 on): at CHECK_AT a notification says what 09:15 will do, or what will stop it; at
  // ROUTE_AT a trading broker that does not answer is replaced by the other one (Dhan <-> linked StoxKart) when that one
  // answers, so the gap trade is still placed. PROBE_MS: how long a broker gets to answer; RETRY_MS: before a second try.
  preopen: Object.freeze({ checkAt: '08:55:00', routeAt: '09:13:00', probeMs: 8_000, retryMs: 5_000 }),
});

const BAR_MS = 5 * 60_000;     // ORB 5m: signals come from 5-minute candles, as on the 5-minute chart

// Live ticks: the Dhan feed (live.js) is the first source for prices and for the gap exit's 1-minute candles;
// Dhan's REST APIs stay the fallback whenever the feed has no fresh tick or cannot vouch for a candle.
// (A mutable object so tests can stand in for the feed.)
export const FEED = { tick: liveTick, minute: liveMinute, bar: liveBar, watch: algoWatch, unwatch: algoUnwatch };
// Gap entry strike, in steps from the ATM (+ = ITM, − = OTM, 0 = ATM). A mutable object so tests can choose.
// 6 Nov 2026: the SENSEX ITM2 had not traded yet, so its only price was yesterday's (₹867.25); Dhan turned the market buy
// into a limit at that + 10% (₹953.95), sellers were at ₹1,085+, and it was cancelled unfilled. Hence:
// LIQUID: a contract counts as priced only by its live market: the best offer in its market depth (the near-ATM contracts
// are on the feed in Full mode; else one REST depth quote), or a trade today (feed volume, or a quote with today's
// open). The offer comes first: it is what a buyer pays now, and it exists before the contract's first trade. ITM2 with
// neither → ITM1 → ATM (the decision itself priced the ATM).
// CHASE: our own LIMIT at that fresh price + BUFFER; while not filled it is raised every EVERY_MS to the latest price +
// BUFFER (at least STEP of the first price more each time, for a contract that is not trading), never above the first
// price + CAP; cancelled at UNTIL (IST), or MIN_MS after it was placed if later. null: the old market order.
// MARKET (user's choice, 6 Nov): the entry is a MARKET order of the lots sized at that live price, not our own limit; if
// Dhan has not filled it after EVERY_MS it is cancelled and a new market order sent for the rest, until UNTIL. false:
// our own LIMIT at the price + BUFFER / ASK_BUFFER, raised (CHASE) instead.
export const GAP_LIVE = { strike: 2, strikeTickWaitMs: 400, liquid: true, market: true,
  // ASK_BUFFER: when the price is the best offer in the market depth (what sellers ask now), the limit is that + 5%.
  chase: { buffer: 0.15, askBuffer: 0.05, cap: 0.25, step: 0.02, everyMs: 1_000, pollMs: 250, until: '09:15:30', minMs: 15_000 } };
const FEED_FROM = 9 * 60 + 13, FEED_TO = 15 * 60 + 31;   // IST minutes: subscribed from just before the open to the close
const TICK_FRESH_MS = 3_000;
/** A 5-minute index candle from the feed's five 1-minute candles (each complete), or null. */
function tickFive(uid, key, start, now) {
  const bars = [];
  for (let m = start; m < start + BAR_MS; m += 60_000) { const b = FEED.minute(uid, key, m, now); if (!b) return null; bars.push(b); }
  return { time: start, open: bars[0].open, high: Math.max(...bars.map(b => b.high)), low: Math.min(...bars.map(b => b.low)), close: bars.at(-1).close, fromTicks: true };
}
/** Dhan's REST 5-minute candles, with the one that just closed built from live ticks while Dhan has not published it. */
function withTickCandle(five, uid, key, lastClosed, now) {
  if (five.some(c => c.time === lastClosed)) return five;
  const t = tickFive(uid, key, lastClosed, now);
  return t ? [...five.filter(c => c.time < lastClosed), t] : five;
}

/** Latest price from the feed if it is at most TICK_FRESH_MS old, else Dhan's REST LTP. */
async function livePrice(uid, adapter, segment, securityId, now = Date.now()) {
  const t = FEED.tick(uid, `${segment}:${securityId}`, { since: now - TICK_FRESH_MS });
  if (t?.ltp > 0) return t.ltp;
  return adapter.ltp?.(segment, securityId).catch(() => null) ?? null;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const round2 = n => Math.round(n * 100) / 100;
// A Gap entry whose order status shows no fill: Dhan's positions are asked HELD_TRIES times, HELD_WAIT_MS apart.
const HELD_TRIES = 4, HELD_WAIT_MS = 1_000;
// Accounts Algo Trading runs: Dhan with a token, or a Paper account (no broker: paper fills, shared market data).
const TRADES = `(broker = 'paper' OR (broker = 'dhan' AND token_enc IS NOT NULL))`;
const roundTick = (n, tick) => Math.round(Math.round(n / tick) * tick * 10_000) / 10_000;

/** The expiry after the nearest upcoming one (today counts as upcoming on expiry day). */
export function nextExpiry(list, today) {
  const up = [...new Set(list || [])].filter(e => /^\d{4}-\d{2}-\d{2}$/.test(e) && e >= today).sort();
  return up[1] || up[0] || null;
}

/**
 * The contract `steps` strikes from the ATM contract `atm` on the same side: + into the money (CE: lower strikes,
 * PE: higher), − out of it. null when the chain does not reach that far.
 */
export function strikeFrom(chain, atm, option, steps) {
  if (!atm || !steps) return atm;
  const strikes = Object.entries(chain?.oc || {}).filter(([, s]) => s?.[option.toLowerCase()]?.security_id).map(([k]) => Number(k)).filter(Number.isFinite).sort((a, b) => a - b);
  const i = strikes.indexOf(atm.strike), j = option === 'CE' ? i - steps : i + steps;
  if (i < 0 || j < 0 || j >= strikes.length) return null;
  const c = atmContract({ ...chain, last_price: strikes[j] }, option);
  return c ? { ...c, spot: atm.spot } : null;
}

/** The strike nearest spot, with that side's contract and quote. */
export function atmContract(chain, option) {
  const spot = Number(chain?.last_price);
  if (!(spot > 0) || !chain?.oc) return null;
  let best = null;
  for (const [strikeText, sides] of Object.entries(chain.oc)) {
    const strike = Number(strikeText), raw = sides?.[option.toLowerCase()];
    if (!Number.isFinite(strike) || !raw?.security_id) continue;
    if (!best || Math.abs(strike - spot) < Math.abs(best.strike - spot)) best = { strike, raw };
  }
  if (!best) return null;
  const { raw } = best;
  return { strike: best.strike, spot, securityId: String(raw.security_id), ask: Number(raw.top_ask_price) || 0,
    bid: Number(raw.top_bid_price) || 0, ltp: Number(raw.last_price) || 0 };
}

/** One tick below the candle's low (low itself rounded up to the tick grid first). */
export function premiumStop(candle, tickSize) {
  const low = Number(candle?.low);
  if (!(low > 0) || !(tickSize > 0)) return null;
  const stop = roundTick((Math.ceil(low / tickSize - 1e-8) - 1) * tickSize, tickSize);
  return stop > 0 ? stop : null;
}

/** Stop-loss limit price: below the trigger by the buffer, on the tick grid, never below one tick. */
export function stopLimitPrice(trigger, tickSize, buffer = AUTO.slLimitBuffer) {
  return Math.max(tickSize, roundTick(Math.floor(trigger * (1 - buffer) / tickSize + 1e-8) * tickSize, tickSize));
}

/**
 * After Dhan refuses an entry for funds ("You have insufficient funds. Please add Rs.2512.04 to trade."): the whole
 * lots that fit, from what Dhan actually blocked per lot (a market order is charged above the last price in a fast
 * move), with 2% spare. 0 when the reason is something else or not even one lot fits.
 */
export function lotsAfterFundsReject(reason, lots, funds) {
  const text = String(reason || '');
  if (!/insufficient\s+funds|insufficient\s+balance|margin\s+shortfall/i.test(text) || !(lots > 1) || !(funds > 0)) return 0;
  const m = /add\s*(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)/i.exec(text);
  const short = m ? Number(m[1].replace(/,/g, '')) : 0;
  const perLot = short > 0 ? (funds + short) / lots : funds / (lots - 1) * 1.02;
  const fit = Math.floor(funds * 0.98 / perLot + 1e-9);
  return fit >= 1 && fit < lots ? fit : 0;
}

/** Whole lots whose stop loss stays within the budget, the funds and the freeze quantity. */
export function sizeOrbTrade({ entry, stop, lotSize, budget, funds, maxQty = AUTO.maxQty }) {
  const perUnit = entry - stop;
  if (!(perUnit > 0) || !(lotSize > 0) || !(budget > 0) || !(funds > 0)) return null;
  const lots = Math.floor(Math.min(budget / (perUnit * lotSize), funds / (entry * lotSize), maxQty / lotSize) + 1e-9);
  if (lots < 1) return null;
  const qty = lots * lotSize;
  return { lots, qty, risk: round2(perUnit * qty), premium: round2(entry * qty) };
}

export const squareOffTime = rules => (rules?.cutoff?.on ? rules.cutoff.value : AUTO.defaultSquareOff);

/** The day's stop-loss still unused: the daily loss limit, less today's loss so far (profits add nothing). */
export const riskLeft = (daily, pnl = 0) => (daily > 0 && Number.isFinite(pnl) ? Math.max(0, round2(daily + Math.min(0, pnl))) : 0);

/** EMA of closes, seeded with the first close (as the chart draws it). */
export function emaSeries(rows, period) {
  const k = 2 / (period + 1);
  let v;
  return rows.map(r => (v = v == null ? Number(r.close) : Number(r.close) * k + v * (1 - k)));
}

/**
 * EMA 9 exit: the last two completed 5-minute NIFTY candles since entry both closed on the wrong side of
 * EMA 9 (above it for a PE trade, below it for a CE trade). `candles` carry ms times, oldest first.
 */
export function emaNineExit(candles, { direction, since, now }) {
  const ema = emaSeries(candles, 9), done = [];
  candles.forEach((c, i) => { if (c.time >= since && c.time + BAR_MS <= now) done.push({ c, ema: ema[i] }); });
  if (done.length < 2) return null;
  const wrong = ({ c, ema }) => (direction === 'PE' ? Number(c.close) > ema : Number(c.close) < ema);
  const [a, b] = done.slice(-2);
  return wrong(a) && wrong(b) ? `Two 5-minute closes ${direction === 'PE' ? 'above' : 'below'} EMA 9 (${b.c.close} vs ${round2(b.ema)})` : null;
}

// ---------------------------------------------------------------------------------------------------

const row = id => stmt('SELECT * FROM auto_trades WHERE id = ?').get(id);
function update(id, patch) {
  const keys = Object.keys(patch);
  stmt(`UPDATE auto_trades SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(k => patch[k]), id);
}
/** Strategy + index trades run side by side: the open automatic trade (another strategy) that already holds this option, if any. Buying it
 * again would merge the two positions at the broker, and one exit would sell both. */
const heldBy = (uid, securityId, exceptId = 0) => stmt(`SELECT symbol, json_extract(detail, '$.setup.strategy') AS strategy FROM auto_trades
  WHERE user_id = ? AND security_id = ? AND id != ? AND status IN ('placing', 'open', 'closing') LIMIT 1`).get(uid, String(securityId), exceptId);
/** Today's auto trades, newest first (for the dashboard). */
export function autoTradesToday(userId, day = ist().day) {
  return stmt(`SELECT id, paper, direction, status, reason, symbol, strike, expiry, lots, qty, entry_price AS entryPrice, sl_price AS slPrice,
      exit_price AS exitPrice, created_at AS createdAt, closed_at AS closedAt, json_extract(detail, '$.setup.strategy') AS strategy, COALESCE(json_extract(detail, '$.setup.underlying'), 'NIFTY') AS underlying
      FROM auto_trades WHERE user_id = ? AND day = ? ORDER BY id DESC`).all(userId, day);
}

/** Earlier days' automatic trades, newest first, with each one's P&L (before charges) when it has an entry and an exit. */
export function autoTradeHistory(userId, today = ist().day, limit = 300) {
  return stmt(`SELECT id, day, paper, direction, status, reason, symbol, lots, qty, entry_price AS entryPrice, sl_price AS slPrice, exit_price AS exitPrice,
      created_at AS createdAt, closed_at AS closedAt, json_extract(detail, '$.setup.strategy') AS strategy, COALESCE(json_extract(detail, '$.setup.underlying'), 'NIFTY') AS underlying
      FROM auto_trades WHERE user_id = ? AND day < ? ORDER BY day DESC, id DESC LIMIT ?`).all(userId, today, limit)
    .filter(t => !String(t.symbol || '').startsWith('TEST'))
    .map(t => (t.entryPrice > 0 && t.exitPrice > 0 && t.qty > 0
      ? { ...t, pnl: round2((t.exitPrice - t.entryPrice) * t.qty), pnlPct: round2((t.exitPrice / t.entryPrice - 1) * 100) } : { ...t, pnl: null, pnlPct: null }));
}

// Dhan allows one option-chain request per user every 3 seconds; the Power Scalper page shares it.
const chainAt = new Map();
async function chainCall(userId, fn) {
  for (let attempt = 0; ; attempt++) {
    const wait = 3_100 - (Date.now() - (chainAt.get(userId) || 0));
    if (wait > 0) await sleep(wait);
    chainAt.set(userId, Date.now());
    try { return await fn(); }
    catch (e) { if (String(e?.code) !== 'DH-904' || attempt >= 1) throw e; }
  }
}

/** Option lot and tick sizes for one index, keyed by security id (the exchange's instrument master). */
export const optionMeta = async u => new Map([...(await indexOptionInstruments())].filter(([k]) => k.startsWith(`${u.exchange}:`)).map(([k, m]) => [k.slice(u.exchange.length + 1), m]));

function candlesFor(adapter, securityId, { index = false, interval = '1', now = Date.now(), from = ist(now).day, segment = 'NSE_FNO' } = {}) {
  const day = from;
  return adapter.intradayCandles({ securityId, exchangeSegment: index ? 'IDX_I' : segment, instrument: index ? 'INDEX' : 'OPTIDX', interval,
    // Dhan's fromDate is exclusive: 09:15:00 would drop the 09:15 candle.
    fromDate: `${day} 09:00:00`, toDate: new Date(now + 330 * 60_000).toISOString().slice(0, 19).replace('T', ' ') })
    .then(normalizeScalperCandles);
}

/**
 * GAP_LIVE.chase: poll a resting buy limit every POLL_MS; while it is not filled, every EVERY_MS raise it (Modify Order)
 * to the latest price + BUFFER, and at least STEP of the first price above where it is (a contract with no trades has no
 * new price, but sellers above the limit), never above `ceiling`. Until `waitMs` has passed (counted both by the pauses
 * and by the clock). Returns the fill, the failure, or { status: 'pending' } (the caller cancels). `order.price` follows.
 */
export async function chaseFill(adapter, orderId, { order, ceiling, first, tick, waitMs, pause = sleep, latest = () => null, ch = GAP_LIVE.chase, buffer = ch.buffer }) {
  const started = Date.now();
  let waited = 0, sinceMove = 0, s = null;
  for (;;) {
    try { s = await adapter.orderStatus(orderId); } catch { s = null; }
    if (s?.status === 'filled' || s?.status === 'failed') return s;
    if (waited >= waitMs || Date.now() - started >= waitMs) return { status: 'pending', filledQty: s?.filledQty || 0 };
    await pause(ch.pollMs); waited += ch.pollMs; sinceMove += ch.pollMs;
    if (sinceMove < ch.everyMs || !adapter.modifyOrder || !(order.price < ceiling)) continue;
    sinceMove = 0;
    const px = Number(latest()) || 0;
    const next = Math.min(ceiling, roundTick(Math.max(px * (1 + buffer), order.price + first * ch.step), tick));
    if (!(next > order.price)) continue;
    try { await adapter.modifyOrder(orderId, { price: next, qty: order.qty }); order.price = next; }
    catch { /* filled or cancelled meanwhile: the next status says which */ }
  }
}

async function waitForFill(adapter, orderId, { waitMs = AUTO.fillWaitMs, pause = sleep, stepMs = 1000 } = {}) {
  for (let elapsed = 0; elapsed < waitMs; elapsed += stepMs) {
    let s;
    try { s = await adapter.orderStatus(orderId); } catch { s = null; }
    if (s?.status === 'filled' || s?.status === 'failed') return s;
    await pause(stepMs);
  }
  return { status: 'pending' };
}

/**
 * ORB 5m, live: after a 5-minute candle closes beyond the opening range, the trade is entered in the next
 * (live) candle the moment the index trades past that candle's high (CE) / low (PE). `price` is the index's
 * live price, folded into the forming candle. Returns { setup } (enter now), { pending } (watch the level
 * during this candle) or {}. A cross found only after its candle closed still enters within the entry window.
 */
export function orbLive(five, now, day, price = null, { mode = AUTO.orbEntry } = {}) {
  const range = openingRangeBreakout(five, now);
  if (!(range.high > range.low) || !range.rangeEnd || now < range.rangeEnd) return {};
  const bars = five.filter(c => ist(c.time).day === day).map(c => ({ ...c, time: c.time / 1000 }));
  const start = Math.floor(now / BAR_MS) * BAR_MS / 1000;
  if (price > 0) {
    const i = bars.findIndex(c => c.time === start);
    if (i < 0) bars.push({ time: start, open: price, high: price, low: price, close: price });
    else bars[i] = { ...bars[i], high: Math.max(Number(bars[i].high), price), low: Math.min(Number(bars[i].low), price), close: price };
  }
  const { signals, pending } = confirmedRangeBreakouts(bars, { high: range.high, low: range.low, end: range.rangeEnd / 1000 }, { now, barSeconds: BAR_MS / 1000, confirm: mode === 'live' ? 'break' : 'close' });
  const signal = signals.at(-1);
  if (mode !== 'live') {   // the confirming candle closed within the entry window: buy now; nothing is watched live
    if (!signal || now - (signal.time * 1000 + BAR_MS) > AUTO.entryWindowMs) return {};
    // RSI 30–70 and EMA 9 / EMA 21 apart in the trade's direction (earlier sessions in `five` seed the averages)
    const filter = orbEntryFilter(five.map(c => ({ ...c, time: c.time / 1000 })), signal);
    return { setup: { strategy: 'ORB 5m', direction: `BUY_${signal.direction}`, breakoutAt: signal.breakoutAt * 1000, confirmedAt: signal.time * 1000,
      tradeNumber: signals.length, rangeHigh: range.high, rangeLow: range.low, breakoutClose: signal.breakoutClose, confirmClose: signal.entry,
      slCandle: 'ORB breakout candle', filter } };
  }
  const fresh = signal && (signal.time === start || now - (signal.time * 1000 + BAR_MS) <= AUTO.entryWindowMs);
  if (fresh) return { setup: { strategy: 'ORB 5m', direction: `BUY_${signal.direction}`, breakoutAt: signal.breakoutAt * 1000, confirmedAt: signal.time * 1000, enteredAt: now,
    tradeNumber: signals.length, rangeHigh: range.high, rangeLow: range.low, breakoutClose: signal.breakoutClose, trigger: signal.entry, live: true,
    slCandle: 'ORB breakout candle' } };
  return pending ? { pending: { direction: pending.direction, level: pending.level, until: pending.confirmAt * 1000 + BAR_MS } } : {};
}

/**
 * EMA 9 / EMA 21 crossover on completed 5-minute NIFTY candles: the candle that closes with EMA 9 on the
 * other side of EMA 21 than the candle before (above → CE, below → PE). Today's candles only; the
 * EMAs are seeded with the earlier sessions in `five`. The SL comes from the option's candle at that time.
 */
export function crossSetup(five, now, day) {
  const done = five.filter(c => c.time + BAR_MS <= now);
  const fast = emaSeries(done, 9), slow = emaSeries(done, 21), i = done.length - 1;
  if (i < 1 || ist(done[i].time).day !== day || now - (done[i].time + BAR_MS) > AUTO.entryWindowMs) return null;
  const was = Math.sign(fast[i - 1] - slow[i - 1]), is = Math.sign(fast[i] - slow[i]);
  if (!was || !is || was === is) return null;
  const direction = is > 0 ? 'CE' : 'PE';
  return { strategy: 'EMA 9/21 cross', direction: `BUY_${direction}`, breakoutAt: done[i].time, confirmedAt: done[i].time,
    ema9: round2(fast[i]), ema21: round2(slow[i]), crossClose: Number(done[i].close), slCandle: 'crossover candle' };
}

/** IST clock time with milliseconds ("09:15:00.412"), for the gap decision's notices. */
const clockMs = t => new Date(t + 330 * 60_000).toISOString().slice(11, 23);

export const EMA_SCALP = Object.freeze({ name: 'EMA 5/9 1m', fast: 5, slow: 9 });
const MIN_MS = 60_000;
/**
 * EMA 5 / EMA 9 crossover on completed 1-minute index candles (`one`: ms times, oldest first; earlier sessions seed the
 * averages, as the chart): the candle that closes with EMA 5 on the other side of EMA 9 than the candle before (above →
 * CE, below → PE). Today's candles only, within ENTRY_WINDOW_MS of the candle closing.
 */
export function emaScalpSetup(one, now, day) {
  const done = one.filter(c => c.time + MIN_MS <= now);
  const fast = emaSeries(done, EMA_SCALP.fast), slow = emaSeries(done, EMA_SCALP.slow), i = done.length - 1;
  if (i < 1 || ist(done[i].time).day !== day || now - (done[i].time + MIN_MS) > AUTO.entryWindowMs) return null;
  const was = Math.sign(fast[i - 1] - slow[i - 1]), is = Math.sign(fast[i] - slow[i]);
  if (!was || !is || was === is) return null;
  const direction = is > 0 ? 'CE' : 'PE';
  return { strategy: EMA_SCALP.name, direction: `BUY_${direction}`, breakoutAt: done[i].time, confirmedAt: done[i].time, interval: '1',
    ema5: round2(fast[i]), ema9: round2(slow[i]), crossClose: Number(done[i].close), slCandle: 'crossover candle' };
}
/** The opposite crossover since the entry: the last completed 1-minute candle (from `since` on) has EMA 5 on the other side. */
export function emaScalpExit(one, { direction, since, now }) {
  const done = one.filter(c => c.time + MIN_MS <= now);
  if (done.length < 2) return null;
  const fast = emaSeries(done, EMA_SCALP.fast), slow = emaSeries(done, EMA_SCALP.slow), i = done.length - 1;
  if (done[i].time < since) return null;
  const opposite = direction === 'CE' ? fast[i] < slow[i] : fast[i] > slow[i];
  return opposite ? `EMA 5 crossed ${direction === 'CE' ? 'below' : 'above'} EMA 9 on the 1-minute close (${ist(done[i].time).hhmm})` : null;
}

// EMA 9/15 on 5-minute candles (own switch, ema915_on): the leg that starts when EMA 9 crosses EMA 15 is entered on its
// first completed 5-minute candle (the crossover candle or up to AFTER_CROSS after it) where EMA 9 rises (CE) / falls (PE)
// at MIN_ANGLE or steeper. Angle = atan(EMA 9's change over that candle ÷ ATR 14), so 30° is a move of 0.58 × a typical
// candle's range, whatever the chart's zoom. One trade per leg. Exit after the first opposite-colour 5-minute candle.
// Backtest (1 lot, ATM next expiry, after charges): no angle filter lost heavily; 30° traded about 6–7 times a month,
// +₹23k in the last year but about break-even over 5 years.
export const EMA_TREND = Object.freeze({ name: 'EMA 9/15 5m', fast: 9, slow: 15, minAngle: 30, atrPeriod: 14, afterCross: 3 });

/** ATR (Wilder's average of the true range), per row, seeded with the first row's range. */
export function atrSeries(rows, period) {
  let v, prev;
  return rows.map(r => {
    const h = Number(r.high), l = Number(r.low), tr = prev == null ? h - l : Math.max(h - l, Math.abs(h - prev), Math.abs(l - prev));
    prev = Number(r.close);
    return (v = v == null ? tr : (v * (period - 1) + tr) / period);
  });
}

/**
 * EMA 9/15 5m entry on completed 5-minute index candles (`five`: ms times, oldest first; earlier sessions seed the
 * averages): the last candle is the first of today's leg, at most AFTER_CROSS candles after the crossover, whose EMA 9
 * angle is at least MIN_ANGLE in the leg's direction. Within ENTRY_WINDOW_MS of that candle closing.
 */
export function emaTrendSetup(five, now, day) {
  const done = five.filter(c => c.time + BAR_MS <= now), i = done.length - 1;
  if (i < 1 || ist(done[i].time).day !== day || now - (done[i].time + BAR_MS) > AUTO.entryWindowMs) return null;
  const fast = emaSeries(done, EMA_TREND.fast), slow = emaSeries(done, EMA_TREND.slow), atr = atrSeries(done, EMA_TREND.atrPeriod);
  const side = Math.sign(fast[i] - slow[i]);
  if (!side) return null;
  let x = i;   // the crossover candle: the first of this leg
  while (x > 0 && Math.sign(fast[x - 1] - slow[x - 1]) === side) x--;
  if (x === 0 || i - x > EMA_TREND.afterCross || ist(done[x].time).day !== day) return null;
  const angle = k => (atr[k] > 0 ? Math.atan((fast[k] - fast[k - 1]) / atr[k]) * 180 / Math.PI * side : 0);
  if (!(angle(i) >= EMA_TREND.minAngle)) return null;
  for (let k = x; k < i; k++) if (angle(k) >= EMA_TREND.minAngle) return null;   // this leg already signalled
  const direction = side > 0 ? 'CE' : 'PE';
  return { strategy: EMA_TREND.name, direction: `BUY_${direction}`, breakoutAt: done[i].time, confirmedAt: done[i].time, crossAt: done[x].time, interval: '5',
    ema9: round2(fast[i]), ema15: round2(slow[i]), angle: round2(angle(i)), atr: round2(atr[i]), crossClose: Number(done[i].close), slCandle: 'signal candle' };
}
/** EMA 9/15 5m exit: the first completed 5-minute index candle since the entry of the opposite colour (red for CE, green for PE). */
export function emaTrendExit(five, { direction, since, now }) {
  const c = five.find(b => b.time >= since && b.time + BAR_MS <= now && (direction === 'CE' ? b.close < b.open : b.close > b.open));
  return c ? `First ${direction === 'CE' ? 'red' : 'green'} 5-minute candle (${ist(c.time).hhmm}) since the entry` : null;
}

/** The option premium's first seconds: green when the last price is above its own 09:15 open. */
export const premiumGreen = q => q?.open > 0 && q?.ltp > q.open;

/**
 * Gap open 09:15 from the ATM premiums: { CE: { prev, open, ltp }, PE: {...} } (prev = the option's previous close).
 * The side whose premium gapped up (open > prev) — and, with requireGreen, is above that open so far — is the trade;
 * both or neither → { skip }.
 */
export function gapPick(sides, { requireGreen = true } = {}) {
  const ok = ['CE', 'PE'].filter(s => sides[s]?.prev > 0 && sides[s].open > sides[s].prev && (!requireGreen || premiumGreen(sides[s])));
  const say = s => (sides[s] ? `${s} prev ${sides[s].prev ?? '—'} → open ${sides[s].open ?? '—'} → now ${sides[s].ltp ?? '—'}` : `${s} —`);
  const both = requireGreen ? 'both CE and PE premiums gapped up green' : 'both CE and PE premiums gapped up';
  const none = requireGreen ? 'no premium gapped up and stayed green' : 'no premium gapped up';
  if (ok.length !== 1) return { skip: `${ok.length ? both : none} (${say('CE')}; ${say('PE')})` };
  const s = sides[ok[0]];
  return { direction: ok[0], gapPct: round2((s.open - s.prev) / s.prev * 100) };
}

/** First completed index 1-minute candle of the opposite colour from the entry candle on (red for CE, green for PE). */
export function gapExitCandle(oneMinute, { direction, since, now }) {
  const from = Math.floor(since / 60_000) * 60_000;
  return (oneMinute || []).find(c => c.time >= from && c.time + 60_000 <= now
    && (direction === 'CE' ? Number(c.close) < Number(c.open) : Number(c.close) > Number(c.open))) || null;
}

const gapChecked = new Map();  // `${userId}:${index}` -> day the 09:15 gap check ran
const gapWatching = new Set(); // `${userId}:${index}` while the first-tick watcher runs (the scanner's check then waits)
const gapPrep = new Map();     // `${userId}:${index}:${day}` -> Promise<{ prevClose, expiry, chain }>
const gapFeedKeys = new Map(); // `${userId}:${day}` -> feed keys of the contracts near the ATM (subscribed before 09:15)

/** Before the open: yesterday's close, the nearest expiry and its chain, so 09:15:02 needs one quote request. */
export function gapPrefetch(acct, adapter, u, now = Date.now()) {
  const day = ist(now).day, key = `${acct.user_id}:${u.key}:${day}`;
  if (!gapPrep.has(key)) {
    const p = (async () => {
      const five = await candlesFor(adapter, u.securityId, { index: true, interval: '5', now, from: previousTradingDays(day, 1)[0] });
      const prev = five.filter(c => ist(c.time).day < day).at(-1);
      const expiries = await chainCall(acct.user_id, () => adapter.optionExpiries({ underlyingScrip: Number(u.securityId), underlyingSeg: 'IDX_I' }));
      const expiry = [...new Set(expiries || [])].filter(e => /^\d{4}-\d{2}-\d{2}$/.test(e) && e >= day).sort()[0];
      const chain = expiry ? await chainCall(acct.user_id, () => adapter.optionChain({ underlyingScrip: Number(u.securityId), underlyingSeg: 'IDX_I', expiry })) : null;
      // Each near-ATM contract's previous close = its last traded price of the previous session (its last 1-minute
      // candle before 15:30), as the backtest uses. Before the first trade of the day the chain's "last price" is
      // NSE's official closing price instead, which can differ by several percent; it stays the fallback.
      const prevLast = new Map();
      const spot = Number(chain?.last_price) || 0;
      for (const id of spot > 0 ? nearIds(chain, spot) : []) {
        const rows = await candlesFor(adapter, id, { interval: '1', now, from: previousTradingDays(day, 5)[0], segment: u.optionSegment }).catch(() => []);
        const last = rows.filter(c => ist(c.time).day < day && ist(c.time).minutes < 15 * 60 + 30).at(-1);
        if (last?.close > 0) prevLast.set(String(id), Number(last.close));
        await sleep(250);   // Dhan's data APIs allow a few requests a second
      }
      return { prevClose: prev ? Number(prev.close) : null, expiry, chain, prevLast };
    })();
    gapPrep.set(key, p);
    p.then(prep => {
      const spot = Number(prep?.chain?.last_price) || 0, fk = `${acct.user_id}:${day}`;
      if (spot > 0) gapFeedKeys.set(fk, new Set([...(gapFeedKeys.get(fk) || []), ...nearIds(prep.chain, spot).map(id => `${u.optionSegment}:${id}`)]));
    }, () => {});
    p.catch(() => gapPrep.delete(key));   // a failed prefetch is retried by the check itself
  }
  return gapPrep.get(key);
}

/** The chain's strikes nearest a price, CE and PE security ids (the ATM at the open is among them). */
export const nearIds = (chain, spot, n = 8) => Object.entries(chain?.oc || {}).map(([k, s]) => [Number(k), s])
  .filter(([k]) => Number.isFinite(k)).sort((a, b) => Math.abs(a[0] - spot) - Math.abs(b[0] - spot)).slice(0, n)
  .flatMap(([, s]) => [s?.ce?.security_id, s?.pe?.security_id]).filter(Boolean).map(String);

const gapNoticeDay = new Map();   // `${userId}:${index}` -> day the "no trade today" notice went out
function gapNoTrade(acct, adapter, u, day, title, body) {
  const k = `${acct.user_id}:${u.key}`;
  if (gapNoticeDay.get(k) === day) return;
  gapNoticeDay.set(k, day);
  const plain = !isAdminUser(acct.user_id);   // users: no premiums or gap figures
  notify(acct.user_id, { kind: 'risk', level: 'info', title, body: plain ? `${u.label}: no Gap 09:15 trade today.` : body });
  audit(acct.user_id, 'algo.gap_no_trade', { underlying: u.key, day, title, body });
  lockAfterNoGapEntry(acct, adapter);
}

/**
 * Once a day, 2 seconds after the open: one quote request (the index, for the ATM strike, + the options near it);
 * the ATM CE and PE premiums (open and now vs their previous close) decide the gap trade.
 */
async function gapCheck(acct, adapter, now, u, opts) {
  const day = ist(now).day, open = Date.parse(`${day}T09:15:00+05:30`), key = `${acct.user_id}:${u.key}`;
  if (gapChecked.get(key) === day || gapWatching.has(key) || now < open + AUTO.gap.checkAfterMs || now > open + AUTO.gap.checkAfterMs + AUTO.gap.windowMs) return null;
  gapChecked.set(key, day);   // before any await: the timer and a scanner pass never both act
  const prep = await gapPrefetch(acct, adapter, u, now).catch(() => null);
  const spot = Number(prep?.chain?.last_price) || 0, seg = u.optionSegment;
  // Live ticks first: price and day open from feed ticks received since 09:15:00; REST for anything missing.
  const fromTick = k => { const t = FEED.tick(acct.user_id, k, { since: open }); return t?.ltp > 0 && t.dayOpen > 0 ? { ltp: t.ltp, open: t.dayOpen, tick: true } : null; };
  let q = fromTick(`IDX_I:${u.securityId}`), qs = null;
  if (!q) {
    const ids = spot > 0 ? nearIds(prep.chain, spot) : [];
    qs = adapter.quotes ? await adapter.quotes({ IDX_I: [u.securityId], ...(ids.length ? { [seg]: ids } : {}) }).catch(() => null)
      : { IDX_I: { [String(u.securityId)]: await adapter.quote?.('IDX_I', u.securityId).catch(() => null) } };
    q = qs?.IDX_I?.[String(u.securityId)];
  }
  const lastTry = now > open + AUTO.gap.checkAfterMs + AUTO.gap.windowMs - 6_000;
  if (!q?.ltp || !prep?.chain) {   // retried on the next pass; at the end of the window, say so
    gapChecked.delete(key);
    if (lastTry) gapNoTrade(acct, adapter, u, day, `Algo Trading: Gap 09:15 not checked today`, `${u.label}: ${!prep?.chain ? 'the option chain' : 'the index price'} was not available from Dhan by 09:15:${String(Math.round((AUTO.gap.checkAfterMs + AUTO.gap.windowMs) / 1000)).padStart(2, '0')}, so there was no gap check and no trade today.`);
    return { skipped: 'gap check: no index price / option chain yet' };
  }
  // ATM strike at the index price now; each option's previous close = its last price in the chain fetched before the open.
  const atm = Object.fromEntries(['CE', 'PE'].map(s => [s, atmContract({ ...prep.chain, last_price: q.ltp }, s)]));
  let opt = { ...(qs?.[seg] || {}) };
  for (const c of Object.values(atm)) if (c && !opt[c.securityId]) { const t = fromTick(`${seg}:${c.securityId}`); if (t) opt[c.securityId] = t; }
  const missing = Object.values(atm).filter(c => c && !opt[c.securityId]).map(c => c.securityId);
  if (missing.length) {   // the ATM was not among the strikes asked for at 09:15:02: one more request
    const more = adapter.quotes ? (await adapter.quotes({ [seg]: missing }).catch(() => null))?.[seg]
      : Object.fromEntries(await Promise.all(missing.map(async id => [id, await adapter.quote?.(seg, id).catch(() => null)])));
    opt = { ...opt, ...(more || {}) };
  }
  if (!Object.values(atm).some(c => c && opt[c.securityId]?.open > 0)) {
    gapChecked.delete(key);
    if (lastTry) gapNoTrade(acct, adapter, u, day, `Algo Trading: Gap 09:15 not checked today`, `${u.label}: no opening price for the ATM options by 09:15:22, so there was no gap check and no trade today.`);
    return { skipped: 'gap check: no option opening price yet' };
  }
  const ticked = !!q.tick && Object.values(atm).every(c => !c || opt[c.securityId]?.tick);
  const source = ticked ? 'live ticks' : q.tick || Object.values(opt).some(x => x?.tick) ? 'ticks + REST' : 'REST';
  return gapDecide(acct, adapter, u, { day, now, prep, index: q, atm, opt, source, opts });
}

/**
 * The gap decision from the ATM CE / PE prices (`opt`: securityId → { open, ltp }) and, when one side qualifies, the
 * entry. Shared by the first-tick watcher and the 09:15:02 check; the caller has marked the day checked.
 */
function gapDecide(acct, adapter, u, { day, now, prep, index, atm, opt, source, opts }) {
  const sides = Object.fromEntries(Object.entries(atm).filter(([, c]) => c).map(([s, c]) => {
    const last = prep.prevLast?.get(String(c.securityId));
    return [s, { strike: c.strike, prev: last ?? (c.ltp || null), prevFrom: last != null ? 'last trade' : 'NSE close', open: opt[c.securityId]?.open ?? null, ltp: opt[c.securityId]?.ltp ?? null }];
  }));
  const g = gapPick(sides, { requireGreen: AUTO.gap.requireGreen }), at = clockMs(now);
  if (g.skip) {
    const line = x => (x ? `${x.strike} ${x === sides.CE ? 'CE' : 'PE'} ${x.prev ?? '—'} → open ${x.open ?? '—'} → ${x.ltp ?? '—'} at ${at}` : '');
    const green = AUTO.gap.requireGreen ? ' and stayed green' : '';
    const why = /both/.test(g.skip) ? `both premiums gapped up${green} (no clear side)` : `neither premium gapped up above its previous close${green}`;
    gapNoTrade(acct, adapter, u, day, `Algo Trading: no Gap 09:15 trade today`,
      `${u.label} opened ${index.open ?? '—'} (${index.ltp} at ${at}), ATM ${sides.CE?.strike ?? sides.PE?.strike}: ${why}.\n${[line(sides.CE), line(sides.PE)].filter(Boolean).join('\n')}\n(previous close = ${sides.CE?.prevFrom || sides.PE?.prevFrom}).`);
    return { skipped: `gap check: no trade: ${g.skip}` };
  }
  const p = sides[g.direction];
  const setup = { strategy: 'Gap 09:15', direction: `BUY_${g.direction}`, underlying: u.key, prevClose: p.prev, open: p.open, ltp: index.ltp, premiumLtp: p.ltp, gapPct: g.gapPct,
    indexOpen: index.open, indexPrevClose: prep.prevClose, prevFrom: p.prevFrom, checkedAt: now, priceSource: source };
  return claimAndEnter(acct, adapter, setup, { ...opts, now, uid: acct.user_id, u, day, gap: { prep, optionQuotes: opt } });
}

/** A feed tick that is the option's first trade of the day: received after the open, with today's open (and volume). */
const firstTrade = (t, open) => !!t && t.at >= open && t.ltp > 0 && t.dayOpen > 0 && t.volume !== 0;

/**
 * Gap open 09:15 on the first tick: from just before 09:15:00, poll the live feed (in memory, every POLL_MS) until both
 * ATM options have traded, then decide and enter at once (09:15:00.x). From REST_AFTER_MS on, Dhan's quotes are asked as
 * well (every REST_EVERY_MS) in case the feed is silent; whichever has both opening prices first decides. Nothing by
 * WINDOW_MS → no trade today (notified). The ATM is the strike nearest the index's latest price (the pre-open sets it),
 * else the chain's spot from the prefetch.
 */
export async function gapFirstTick(acct, adapter, u, opts = {}, { clock = () => Date.now(), pause = sleep } = {}) {
  const G = AUTO.gap, uid = acct.user_id, day = ist(clock()).day, open = Date.parse(`${day}T09:15:00+05:30`), key = `${uid}:${u.key}`;
  if (!G.firstTick || gapChecked.get(key) === day || gapWatching.has(key)) return null;
  gapWatching.add(key);
  try {
    let prep = await gapPrefetch(acct, adapter, u, clock()).catch(() => null), prepAt = clock(), restAt = open + G.restAfterMs;
    const seg = u.optionSegment, end = open + G.windowMs;
    const atmAt = spot => Object.fromEntries(['CE', 'PE'].map(s => [s, atmContract({ ...prep.chain, last_price: spot }, s)]));
    while (clock() < end) {
      if (gapChecked.get(key) === day) return null;
      const now = clock();
      if (!prep?.chain && now - prepAt >= 3_000) { prep = await gapPrefetch(acct, adapter, u, now).catch(() => null); prepAt = clock(); }   // a failed prefetch: again, not too often
      if (now >= open && prep?.chain) {
        const idx = FEED.tick(uid, `IDX_I:${u.securityId}`, { since: open - 10 * 60_000 });
        const spot = idx?.ltp > 0 ? idx.ltp : Number(prep.chain.last_price) || 0, atm = atmAt(spot);
        const ticks = Object.fromEntries(Object.values(atm).filter(Boolean).map(c => [c.securityId, FEED.tick(uid, `${seg}:${c.securityId}`, { since: open })]));
        if (spot > 0 && Object.keys(ticks).length === 2 && Object.values(ticks).every(t => firstTrade(t, open))) {
          gapChecked.set(key, day);   // before any await: a scanner pass does not act again
          const opt = Object.fromEntries(Object.entries(ticks).map(([id, t]) => [id, { open: t.dayOpen, ltp: t.ltp, tick: true }]));
          return gapDecide(acct, adapter, u, { day, now, prep, index: { ltp: spot, open: idx?.dayOpen ?? null }, atm, opt, source: `first tick (${now - open} ms after 09:15:00)`, opts });
        }
        if (now >= restAt && adapter.quotes) {   // the feed has not shown both first trades: Dhan's quotes too
          restAt = now + G.restEveryMs;
          const ids = spot > 0 ? nearIds(prep.chain, spot) : [];
          const qs = await adapter.quotes({ IDX_I: [u.securityId], ...(ids.length ? { [seg]: ids } : {}) }).catch(() => null);
          const q = qs?.IDX_I?.[String(u.securityId)], at2 = q?.ltp > 0 ? atmAt(q.ltp) : null;
          if (at2 && Object.values(at2).every(c => c && qs?.[seg]?.[c.securityId]?.open > 0) && gapChecked.get(key) !== day) {
            gapChecked.set(key, day);
            return gapDecide(acct, adapter, u, { day, now: clock(), prep, index: q, atm: at2, opt: { ...qs[seg] }, source: `REST quote (${clock() - open} ms after 09:15:00; no first ticks from the feed)`, opts });
          }
        }
      }
      await pause(now < open ? Math.min(G.pollMs * 10, Math.max(1, open - now)) : G.pollMs);
    }
    if (gapChecked.get(key) === day) return null;
    gapChecked.set(key, day);
    gapNoTrade(acct, adapter, u, day, `Algo Trading: Gap 09:15 not checked today`, `${u.label}: ${prep?.chain ? 'no opening price for the ATM options' : 'the option chain was not available from Dhan'} by ${clockMs(end).slice(0, 8)}, so there was no gap check and no trade today.`);
    return { skipped: 'gap check: no opening prices in the window' };
  } finally { gapWatching.delete(key); }
}

/**
 * 1-minute index candles from the previous session on (the EMAs' seed), with the candle that just closed taken from the
 * live feed when Dhan has not published it yet. source: 'REST' | 'live ticks' | null (that candle not available yet).
 */
async function oneMinuteIndex(uid, adapter, u, lastClosed, now) {
  const rest = await candlesFor(adapter, u.securityId, { index: true, interval: '1', now, from: previousTradingDays(ist(now).day, 1)[0] });
  if (rest.some(c => c.time === lastClosed)) return { one: rest, source: 'REST' };
  const t = FEED.minute(uid, `IDX_I:${u.securityId}`, lastClosed, now);
  return t ? { one: [...rest.filter(c => c.time < lastClosed), { time: lastClosed, open: t.open, high: t.high, low: t.low, close: t.close }], source: 'live ticks' }
    : { one: rest, source: null };
}

const emaScalpState = new Map();   // `${userId}:${index}` -> start of the last 1-minute candle scanned for EMA 5/9
/** EMA 5/9 1m: once per 1-minute close, a fresh crossover is traded (claimAndEnter); null when there is none. */
async function emaScalpScan(acct, adapter, now, u, opts) {
  const uid = acct.user_id, key = `${uid}:${u.key}`, lastClosed = Math.floor(now / MIN_MS) * MIN_MS - MIN_MS, since = now - (lastClosed + MIN_MS);
  if (emaScalpState.get(key) === lastClosed) return null;
  if (since > AUTO.entryWindowMs) { emaScalpState.set(key, lastClosed); return null; }   // too late for this candle
  // The feed's candle right at the close; without it, give Dhan's REST candle a few seconds.
  if (!FEED.minute(uid, `IDX_I:${u.securityId}`, lastClosed, now) && since < AUTO.dataGraceMs) return null;
  const { one, source } = await oneMinuteIndex(uid, adapter, u, lastClosed, now);
  if (!source) return null;   // not published yet: the next pass
  emaScalpState.set(key, lastClosed);
  const day = ist(now).day, setup = emaScalpSetup(one, now, day);
  if (!setup) return null;
  setup.underlying = u.key;
  setup.candleSource = source;
  return claimAndEnter(acct, adapter, setup, { ...opts, now, uid, u, day });
}

const scanState = new Map();   // `${userId}:${index}` -> start of the last 5-minute candle scanned
const liveWatch = new Map();   // `${userId}:${index}` -> { five, level, direction, until }: a breakout waiting for its cross

/** Indices Algo Trading watches for an account (stored comma-separated; NIFTY when empty). */
export const algoIndices = acct => {
  const keys = String(acct?.algo_underlying || 'NIFTY').split(',').map(k => k.trim().toUpperCase()).filter(k => ['NIFTY', 'BANKNIFTY', 'SENSEX'].includes(k));
  return keys.length ? [...new Set(keys)] : ['NIFTY'];
};

/**
 * One scanner pass for an account with the switch on. Right after each 5-minute candle closes, look
 * for a fresh confirmed ORB signal on the 5-minute chart and trade it. Returns what happened.
 */
export async function scanForEntry(acct, { now = Date.now(), adapter = adapterFor(acct), pause = sleep, instruments = optionMeta, underlying } = {}) {
  const u = underlyingFor(underlying ?? algoIndices(acct)[0]), stateKey = `${acct.user_id}:${u.key}`;
  // This index's switches (Algo Trading grid); non-admins: only the public strategy (Gap 09:15) runs.
  acct = withAllowedStrategies(indexView(acct, u.key));
  if (acct.gap_on !== 1 && acct.cross_on !== 1 && acct.orb_on !== 1 && acct.ema915_on !== 1) return { skipped: `no strategy on for ${u.label}` };
  const uid = acct.user_id;
  if (!marketOpen(now)) return { skipped: 'market closed' };
  if (acct.gap_on === 1) { const g = await gapCheck(acct, adapter, now, u, { pause, instruments }); if (g && !g.skipped?.startsWith('gap check')) return g; }
  // EMA 5/9 on 1-minute candles (the cross_on switch): checked on every 1-minute close.
  if (acct.cross_on !== 0) { const e = await emaScalpScan(acct, adapter, now, u, { pause, instruments }); if (e) return e; }
  const minute = Math.floor(now / 60_000) * 60_000;
  const lastClosed = Math.floor(now / BAR_MS) * BAR_MS - BAR_MS;
  // Between 5-minute closes: watch a waiting ORB breakout live (every pass) and enter on the cross.
  if (scanState.get(stateKey) === lastClosed || now - Math.floor(now / BAR_MS) * BAR_MS >= 60_000) {
    const w = liveWatch.get(stateKey);
    if (!w || now >= w.until || acct.orb_on === 0) return { skipped: 'no breakout to watch' };
    const price = await livePrice(uid, adapter, 'IDX_I', u.securityId, now);
    if (!(price > 0)) return { skipped: 'no live price' };
    const crossed = w.direction === 'CE' ? price > w.level : price < w.level;
    if (!crossed) return { skipped: `waiting for ${w.direction === 'CE' ? 'a break above' : 'a break below'} ${w.level} (now ${price})` };
    liveWatch.delete(stateKey);
    const { setup: live } = orbLive(w.five, now, ist(now).day, price);
    if (!live) return { skipped: 'breakout no longer valid' };
    return claimAndEnter(acct, adapter, { ...live, underlying: u.key, livePrice: price }, { now, pause, instruments, uid, u });
  }
  // Live ticks: the closed 5-minute candle is built from the feed the moment it closes; without it, give Dhan's
  // REST candle a few seconds to be published.
  const feedKey = `IDX_I:${u.securityId}`, ticked = !!tickFive(uid, feedKey, lastClosed, now);
  if (!ticked && now - minute < AUTO.dataGraceMs) return { skipped: 'waiting for data' };
  // A few sessions of history so EMA 9 / EMA 21 match the chart from the first candle of the day.
  const rest = await candlesFor(adapter, u.securityId, { index: true, interval: '5', now, from: previousTradingDays(ist(now).day, 3)[0] });
  const five = withTickCandle(rest, uid, feedKey, lastClosed, now);
  // Dhan can take a few seconds to publish a closed candle; retry on the next pass until it is in.
  if (!five.some(c => c.time === lastClosed) && now - minute < AUTO.dataWaitMs) return { skipped: 'closed candle not published yet' };
  const candleSource = rest.some(c => c.time === lastClosed) ? 'REST' : 'live ticks';
  scanState.set(stateKey, lastClosed);
  const day = ist(now).day;
  // Both strategies on the same 5-minute candles; the first fresh signal wins (ORB if both fire at once).
  // Each strategy has its own switch (AI Algo Trading page). ORB 5m: a breakout that just closed is watched
  // live for the rest of the next candle (above); a cross already in the data is entered now.
  liveWatch.delete(stateKey);
  const orb = acct.orb_on !== 0 ? orbLive(five, now, day) : {};
  if (orb.pending) liveWatch.set(stateKey, { five, ...orb.pending });
  // EMA 9/15 5m (its own switch) on the same candles, when ORB has nothing to enter now.
  const setup = orb.setup || (acct.ema915_on === 1 ? emaTrendSetup(five, now, day) : null);
  if (!setup) return { skipped: orb.pending ? `ORB ${orb.pending.direction} breakout: watching ${orb.pending.level} live` : 'no fresh ORB signal' };
  setup.underlying = u.key;
  setup.candleSource = candleSource;
  return claimAndEnter(acct, adapter, setup, { now, pause, instruments, uid, u, day });
}

/** Claim a signal (once per signal, even across restarts) and trade it. */
async function claimAndEnter(acct, adapter, setup, { now, pause, instruments, uid, u, day = ist(now).day, gap }) {
  const direction = setup.direction.slice(4);
  // One trade at a time per strategy + index: others (another strategy, another index) run side by side.
  const slot = stmt(`SELECT symbol FROM auto_trades WHERE user_id = ? AND status IN ('placing', 'open', 'closing')
    AND json_extract(detail, '$.setup.strategy') = ? AND COALESCE(json_extract(detail, '$.setup.underlying'), 'NIFTY') = ? LIMIT 1`).get(uid, setup.strategy, u.key);
  if (slot) return { skipped: `${setup.strategy} already has a ${u.label} trade open (${slot.symbol || 'being placed'})` };
  // EMA 9/15 5m: once per leg (its crossover candle), whichever candle of the leg first reached the angle.
  const key = (u.key === 'NIFTY' ? '' : `${u.key}:`) + (setup.strategy === 'Gap 09:15' ? `${day}:gap` : setup.strategy === 'ORB 5m' ? `${day}:${setup.breakoutAt}`
    : setup.strategy === EMA_TREND.name ? `${day}:t:${setup.crossAt}` : `${day}:x:${setup.breakoutAt}`);
  // Claim the signal before any order: a second pass (or a restart) can never trade it again.
  const claim = stmt(`INSERT OR IGNORE INTO auto_trades (user_id, day, signal_key, direction, status, detail, created_at, paper)
    VALUES (?, ?, ?, ?, 'placing', ?, ?, ?)`).run(uid, day, key, direction, JSON.stringify({ setup }), now, acct.paper_mode === 1 ? 1 : 0);
  if (!claim.changes) return { skipped: 'signal already handled' };
  const id = Number(claim.lastInsertRowid);
  try { return await (setup.strategy === 'Gap 09:15' ? enterGap : enter)(acct, adapter, id, setup, direction, { now, pause, instruments, gap }); }
  catch (e) {
    const t = row(id);
    if (t.status === 'placing') {
      update(id, { status: t.entry_order_id ? 'failed' : 'skipped', reason: String(e.message).slice(0, 240), closed_at: Date.now() });
      notify(uid, { kind: 'risk', level: t.entry_order_id ? 'critical' : 'warn', title: `Algo Trading: ${setup.strategy} ${direction} not traded`,
        body: t.entry_order_id ? `${e.message}. An entry order was sent: check Dhan for an open position without a stop-loss.` : e.message });
    }
    return { error: e.message };
  } finally {
    if (setup.strategy === 'Gap 09:15' && ['skipped', 'failed'].includes(row(id)?.status)) lockAfterNoGapEntry(acct, adapter);
  }
}

/**
 * No Gap 09:15 entry today (no gap, not checked, skipped, not filled or rejected): with "Kill switch if no Gap entry"
 * (gap_lock) and the kill switch rule on, and no
 * other strategy left to trade today, the broker's kill switch locks the account for the rest of the day (armed until
 * flat, if anything is open).
 */
export function lockAfterNoGapEntry(acct, adapter) {
  const a = withAllowedStrategies(acct);
  if (acct.gap_lock === 0 || a.orb_on || a.cross_on || a.ema915_on || a.strangle_on || !getRules(acct.user_id).active?.killSwitch?.on || !getSubscription(acct.user_id)?.active) return;
  tryKillSwitch(acct.user_id, acct, 'gap:no-entry', adapter).catch(e => console.error('[autotrade] kill switch', e.message));
}

async function enter(acct, adapter, id, setup, direction, { now, pause, instruments }) {
  const uid = acct.user_id;
  const skip = reason => {
    update(id, { status: 'skipped', reason, closed_at: Date.now() });
    notify(uid, { kind: 'risk', level: 'warn', title: `Algo Trading: ${setup.strategy} ${direction} skipped`, body: reason });
    audit(uid, 'algo.auto_skipped', { id, direction, reason });
    return { skipped: reason, id };
  };
  if (setup.filter && !setup.filter.ok) return skip(`Entry filter: ${setup.filter.reason}.`);
  const risk = scalperSignalRisk(uid, { concurrent: true });
  if (risk.reason) return skip(risk.reason);
  if (entriesInFlight.has(uid)) return skip('Another order is being placed.');

  const u = underlyingFor(setup.underlying);
  const expiries = await chainCall(uid, () => adapter.optionExpiries({ underlyingScrip: Number(u.securityId), underlyingSeg: 'IDX_I' }));
  const expiry = nextExpiry(expiries, ist(now).day);
  if (!expiry) return skip(`Dhan returned no upcoming ${u.label} expiry.`);
  const chain = await chainCall(uid, () => adapter.optionChain({ underlyingScrip: Number(u.securityId), underlyingSeg: 'IDX_I', expiry }));
  const c = atmContract(chain, direction);
  if (!c) return skip(`No ATM ${direction} found in the ${expiry} option chain.`);
  const meta = (await instruments(u)).get(c.securityId);
  if (!meta?.lotSize || !meta?.tickSize) return skip(`Lot and tick size for ${u.label} ${c.strike} ${direction} are unavailable.`);
  const symbol = `${u.symbol} ${expiry} ${c.strike} ${direction}`, seg = u.optionSegment;
  update(id, { security_id: c.securityId, exchange_segment: seg, symbol, expiry, strike: c.strike });
  { const h = heldBy(uid, c.securityId, id); if (h) return skip(`${symbol} is already held by the open ${h.strategy} trade: not bought again.`); }

  // The stop comes from the option's own candle of the signal's timeframe (5-minute ORB, 1-minute EMA 5/9).
  const iv = setup.interval || '5', ivName = iv === '1' ? '1-minute' : '5-minute';
  let premium = await candlesFor(adapter, c.securityId, { interval: iv, now, segment: seg });
  let breakoutBar = premium.find(bar => bar.time === setup.breakoutAt);
  // Decided on live ticks right at the close: the option's candle can take a few seconds more to appear at Dhan.
  for (let i = 0; !breakoutBar && setup.candleSource === 'live ticks' && i < 4; i++) {
    await pause(1500);
    premium = await candlesFor(adapter, c.securityId, { interval: iv, now: Date.now(), segment: seg });
    breakoutBar = premium.find(bar => bar.time === setup.breakoutAt);
  }
  if (!breakoutBar) return skip(`${symbol} has no ${ivName} candle for the ${setup.slCandle || 'breakout candle'}, so there is no premium low for the stop-loss.`);
  const stop = premiumStop(breakoutBar, meta.tickSize);
  const entry = c.ask > 0 ? c.ask : c.ltp;
  if (!stop || !(entry > stop)) return skip(`${symbol} premium ${entry} is already at or below the stop-loss ${stop}.`);
  const today = dayState(uid), budget = riskLeft(risk.budget?.daily, today.realized + today.unrealized);
  const funds = Number(getBook(uid).funds?.available);
  // 95% of the funds (a market buy is charged a little above the last price, and brokerage on top), within the
  // Risk rules' Capital per trade when it is on.
  const sizing = sizeOrbTrade({ entry, stop, lotSize: meta.lotSize, budget, funds: Math.min(funds * AUTO.entryFundsUse, risk.budget?.capitalLimit ?? Infinity), maxQty: AUTO.freezeQty[u.key] || AUTO.maxQty });
  if (!sizing) return skip(`One lot of ${symbol} (risk ₹${round2((entry - stop) * meta.lotSize)}) exceeds the ₹${budget} of today's stop-loss that is left, or the available funds.`);

  const order = { symbol, side: 'BUY', qty: sizing.qty, type: 'MARKET', securityId: c.securityId, exchangeSegment: seg, productType: 'INTRADAY' };
  const t = ist(), s = dayState(uid, t.day), book = getBook(uid), rules = getRules(uid).active;
  const verdict = checkOrder(order, { rules, positions: book.positions, orders: book.orders || [], concurrent: true, entryInFlight: entriesInFlight.has(uid),
    entries: s.entries, pnl: s.realized + s.unrealized, minutes: marketOpen() ? t.minutes : null, capital: capitalFor(uid, s), paused: !!s.paused,
    killSwitchActive: !!s.ks_active_at || getKillStatus(uid)?.active === true, pauseReason: s.pause_reason, subscriptionActive: !!getSubscription(uid)?.active });
  if (!verdict.ok) return skip(verdict.reason);

  entriesInFlight.add(uid);
  let fill;
  try {
    let placed;
    for (let attempt = 0; ; attempt++) {
      placed = await adapter.placeOrder(order);
      update(id, { entry_order_id: String(placed.id), lots: sizing.lots, qty: sizing.qty, sl_price: stop });
      audit(uid, 'order.placed', { order, result: placed, auto: 'orb5' });
      fill = placed.status === 'filled' ? placed : await waitForFill(adapter, placed.id, { pause });
      const fewer = fill.status === 'failed' && attempt === 0 ? lotsAfterFundsReject(fill.reason, sizing.lots, funds) : 0;
      if (!fewer) break;
      notify(uid, { kind: 'risk', level: 'info', title: `Algo Trading: ${symbol} re-sized to ${fewer} lot${fewer > 1 ? 's' : ''}`,
        body: `Dhan needed more funds for ${sizing.lots} lots (${fill.reason}). Placing ${fewer} lot${fewer > 1 ? 's' : ''} instead, now.` });
      sizing.lots = fewer; sizing.qty = fewer * meta.lotSize; order.qty = sizing.qty;
    }
    if (fill.status === 'pending') {
      await adapter.cancelOrder(placed.id).catch(() => {});
      throw new Error(`Dhan did not fill the ${symbol} buy order within ${AUTO.fillWaitMs / 1000} seconds; it was cancelled`);
    }
    if (fill.status === 'failed') {
      update(id, { status: 'failed', reason: fill.reason || 'Entry order rejected', closed_at: Date.now() });
      notify(uid, { kind: 'risk', level: 'critical', title: `Algo Trading: ${symbol} buy rejected`, body: `Dhan rejected the entry${fill.reason ? `: ${fill.reason}` : ''}.` });
      return { failed: fill.reason, id };
    }
  } finally { entriesInFlight.delete(uid); }

  const entryPrice = Number(fill.price) || entry;
  update(id, { entry_price: entryPrice });
  const unprotected = async why => {
    update(id, { status: 'closing', reason: why });
    notify(uid, { kind: 'risk', level: 'critical', title: `Algo Trading: closing ${symbol}`, body: why });
    await adapter.exitPosition({ securityId: c.securityId, exchangeSegment: seg, productType: 'INTRADAY', qty: sizing.qty, symbol })
      .catch(e => notify(uid, { kind: 'risk', level: 'critical', title: `Could not close ${symbol}`, body: `${e.message}. Close it in the Dhan app now.` }));
    return { closing: why, id };
  };
  if (!(entryPrice > stop)) return unprotected(`Filled at ${entryPrice}, already at or below the stop-loss ${stop}; exiting at market.`);
  try {
    const sl = await adapter.placeOrder({ symbol, side: 'SELL', qty: sizing.qty, type: 'STOP_LOSS', triggerPrice: stop,
      price: stopLimitPrice(stop, meta.tickSize), securityId: c.securityId, exchangeSegment: seg, productType: 'INTRADAY' });
    update(id, { status: 'open', sl_order_id: String(sl.id) });
  } catch (e) {
    return unprotected(`Dhan refused the stop-loss order (${e.message}); exiting at market so the trade is never left without a stop.`);
  }
  notify(uid, { kind: 'risk', level: 'ok', title: `Algo Trading: bought ${sizing.lots} lot${sizing.lots > 1 ? 's' : ''} ${symbol}`,
    body: `${setup.strategy} ${direction}${setup.strategy === 'ORB 5m' ? ` (ORB signal ${setup.tradeNumber || 1} today)` : setup.strategy === EMA_SCALP.name ? ` (EMA 5 ${setup.ema5} vs EMA 9 ${setup.ema9})`
      : setup.strategy === EMA_TREND.name ? ` (EMA 9 ${setup.ema9} vs EMA 15 ${setup.ema15}, EMA 9 angle ${setup.angle}°)` : ` (EMA 9 ${setup.ema9} vs EMA 21 ${setup.ema21})`}${setup.candleSource ? `, on the ${setup.candleSource} ${ivName} candle` : ''}. Entry ${entryPrice}, stop-loss ${stop} (premium low of the ${ivName} ${setup.slCandle || 'breakout candle'} − 1 tick), risk ≈ ₹${round2((entryPrice - stop) * sizing.qty)} of ₹${budget} SL left today. Exits on the stop-loss, ${setup.strategy === EMA_SCALP.name ? `the opposite EMA 5/9 crossover on a 1-minute close`
      : setup.strategy === EMA_TREND.name ? `the first ${direction === 'PE' ? 'green' : 'red'} 5-minute candle` : `2 five-minute closes ${direction === 'PE' ? 'above' : 'below'} EMA 9`}, or at ${squareOffTime(getRules(uid).active)} IST.` });
  audit(uid, 'algo.auto_entered', { id, strategy: setup.strategy, symbol, qty: sizing.qty, entryPrice, stop });
  syncAccount(acct, { force: true }).catch(() => {});
  return { entered: true, id, symbol, qty: sizing.qty, entryPrice, stop };
}

/**
 * Gap open 09:15 entry: as many lots of the NEAREST expiry's ATM option (strike nearest the index now) as FUNDS_USE of
 * the available funds buys (no lot cap; above the freeze quantity Dhan slices it, the stop too), market buy (or a limit at the last price + PAD_PCT), cancelled if
 * not filled in time, then a stop-loss at Dhan where it loses the day's stop-loss left. Same risk gate as ORB.
 */
async function enterGap(acct, adapter, id, setup, direction, { now = Date.now(), pause, instruments, gap = {} }) {
  const uid = acct.user_id, G = AUTO.gap;
  const skip = reason => {
    update(id, { status: 'skipped', reason, closed_at: Date.now() });
    notify(uid, { kind: 'risk', level: 'warn', title: `Algo Trading: Gap 09:15 ${direction} skipped`,
      body: isAdminUser(uid) || /fund|margin|balance|lot|Risk rules|stop-loss|rejected|refused/i.test(reason) ? reason : 'The opening conditions were not met, so no trade today.' });
    audit(uid, 'algo.auto_skipped', { id, direction, reason, strategy: 'gap' });
    return { skipped: reason, id };
  };
  const risk = scalperSignalRisk(uid, { concurrent: true });
  if (risk.reason) return skip(risk.reason);
  if (entriesInFlight.has(uid)) return skip('Another order is being placed.');
  const u = underlyingFor(setup.underlying);
  const { expiry, chain } = gap.prep || await gapPrefetch(acct, adapter, u, now);
  if (!expiry) return skip(`Dhan returned no upcoming ${u.label} expiry.`);
  // ATM at the price now (the prefetched chain's own spot is from before the open).
  const atm = atmContract({ ...chain, last_price: setup.ltp || setup.open }, direction);
  if (!atm) return skip(`No ATM ${direction} found in the ${expiry} option chain.`);
  // The contract bought: GAP_LIVE.strike steps from the ATM (ITM2 by default).
  let steps = GAP_LIVE.strike || 0;
  const pickOf = n => (n ? `${n > 0 ? 'ITM' : 'OTM'}${Math.abs(n)}` : 'ATM');
  let c = strikeFrom(chain, atm, direction, steps), pick = pickOf(steps);
  if (!c) return skip(`No ${pick} ${direction} (${steps > 0 ? 'in' : 'out of'} the money from the ATM ${atm.strike}) in the ${expiry} option chain.`);
  const seg = u.optionSegment, open915 = Date.parse(`${ist(now).day}T09:15:00+05:30`);
  // Price now (LIQUID: only the live market, see GAP_LIVE): the contract's best offer in the market depth when the feed has
  // it, else its price from a trade today (the decision's own quote covers the ATM); waited for up to `waitMs` (it is
  // subscribed, in Full mode, with the strikes near the ATM); `rest`: then one REST depth quote. { ltp, ask, open }.
  const fromTick = t => {
    if (!(t?.ltp > 0)) return null;
    const best = t.depth?.[0], traded = Number(t.volume) > 0;
    let ask = best?.ask > 0 && best.askQty > 0 ? best.ask : null;
    if (ask && traded && ask > t.ltp * (1 + (GAP_LIVE.chase?.cap ?? 0.25))) ask = null;   // a lone far offer: go by the trades
    if (GAP_LIVE.liquid && !ask && !traded) return null;
    return { ltp: t.ltp, ask, open: t.dayOpen, tick: true, traded };
  };
  const priced = async (cc, waitMs, rest = false) => {
    const d = gap.optionQuotes?.[cc.securityId];
    for (const until = Date.now() + waitMs; ;) {
      const t = fromTick(FEED.tick(uid, `${seg}:${cc.securityId}`, { since: open915 }));
      if (t?.ask) return t;
      if (d?.ltp > 0 && (!GAP_LIVE.liquid || d.tick || d.open > 0)) return { ...d, ask: d.ask ?? null };
      if (t) return t;
      if (Date.now() >= until) break;
      await sleep(G.pollMs);
    }
    if (!rest || !adapter.depthQuote) return null;
    const r = await adapter.depthQuote(seg, cc.securityId).catch(() => null);
    return r ? fromTick({ ltp: r.ltp || r.ask, volume: r.volume, dayOpen: r.open, depth: r.ask ? [{ ask: r.ask, askQty: r.askQty }] : [] }) : null;
  };
  let q = await priced(c, GAP_LIVE.strikeTickWaitMs, GAP_LIVE.liquid), moved = null;
  // LIQUID: no offer and no trade yet today → the next strike toward the ATM that has one (the ATM always has a trade:
  // the gap was decided on it).
  for (let n = steps - Math.sign(steps); !q && GAP_LIVE.liquid && steps && Math.abs(n) < Math.abs(steps); n -= Math.sign(steps)) {
    const cc = strikeFrom(chain, atm, direction, n), qq = cc && await priced(cc, 0);
    if (qq) { moved = `${pick} ${c.strike} ${direction} had no sellers and no trade yet today`; c = cc; q = qq; steps = n; pick = pickOf(n); }
  }
  if (!q && GAP_LIVE.liquid && steps) {
    const qq = await priced(atm, 0);
    if (qq) { moved = `${pick} ${c.strike} ${direction} had no sellers and no trade yet today`; c = atm; q = qq; steps = 0; pick = 'ATM'; }
  }
  if (!q) {   // one more quote: with LIQUID, only if it shows a trade today
    const r = await adapter.quote?.(seg, c.securityId).catch(() => null);
    if (r?.ltp > 0 && (!GAP_LIVE.liquid || r.open > 0)) q = r;
  }
  const meta = (await instruments(u)).get(c.securityId);
  if (!meta?.lotSize || !meta?.tickSize) return skip(`Lot and tick size for ${u.label} ${c.strike} ${direction} are unavailable.`);
  const symbol = `${u.symbol} ${expiry} ${c.strike} ${direction}`;
  update(id, { security_id: c.securityId, exchange_segment: seg, symbol, expiry, strike: c.strike });
  { const h = heldBy(uid, c.securityId, id); if (h) return skip(`${symbol} is already held by the open ${h.strategy} trade: not bought again.`); }
  if (moved) audit(uid, 'algo.gap_strike_moved', { id, why: moved, to: symbol, pick });
  // The price the order goes by: the best offer (what sellers ask now) when known, else the last trade.
  const quoteAt = q?.ask > 0 ? q.ask : q?.ltp > 0 ? q.ltp : 0, byAsk = q?.ask > 0;
  if (!(quoteAt > 0)) return skip(GAP_LIVE.liquid ? `${symbol} has no sellers and no trade yet today (no live price), so it cannot be priced.` : `${symbol} has no last price yet.`);
  if (G.requireGreen && !premiumGreen(q)) return skip(`${symbol} premium is ${quoteAt} vs its 09:15 open ${q?.open ?? '—'}: not green in the first seconds, so no trade today.`);
  const limit = roundTick(quoteAt + Math.max(G.minPad, quoteAt * G.padPct), meta.tickSize);
  const funds = Number(getBook(uid).funds?.available);
  if (!(funds > 0)) return skip('Dhan did not report the available funds, so the trade cannot be sized.');
  const freeze = AUTO.freezeQty[u.key] || AUTO.maxQty;
  // The Risk rules' Capital per trade when it is on, else FUNDS_USE of the funds. Either way no more than the broker can
  // block for a market buy (the premium + BLOCK_PAD, 98% of the funds), so the first order is not refused for funds.
  // CHASE: the limit can be raised up to the price + CAP, so that is what has to fit.
  // MARKET (GAP_LIVE.market): a market order, re-sent if not filled; else LIM: our own limit, chased.
  const ch = GAP_LIVE.chase, mkt = !!(ch && GAP_LIVE.market), lim = !!(ch && !mkt);
  const cap = risk.budget?.capitalLimit ?? null, fits = funds * 0.98 / (1 + (lim ? ch.cap : G.blockPad));
  const spend = Math.min(cap != null ? cap : funds * G.fundsUse, fits);
  let lots = Math.floor(Math.min(spend / (limit * meta.lotSize), G.lotCap === false ? Infinity : freeze / meta.lotSize) + 1e-9), qty = lots * meta.lotSize;
  if (lots < 1) return skip(`1 lot of ${symbol} needs ₹${round2(limit * meta.lotSize)}; ${cap != null && cap < fits ? `your capital per trade is ₹${round2(cap)}` : `₹${round2(funds)} is available`}.`);
  // Stop-loss room per unit: what the Risk rules still allow to lose today, spread over the whole quantity.
  const today = dayState(uid), budget = riskLeft(risk.budget?.daily, today.realized + today.unrealized), room = budget / qty;
  if (!(room >= Math.max(2 * meta.tickSize, quoteAt * G.minStopPct))) return skip(`The day's stop-loss left (₹${budget}) is only ₹${round2(room)} a unit on ${qty} qty of ${symbol} at ${quoteAt}: too tight a stop.`);

  // CHASE: our own limit above the fresh price (a buy limit pays the sellers' price, the limit is only the ceiling).
  // Otherwise refPrice / marketBand: a broker that turns market orders into limits (StoxKart) prices it from this tick.
  // BUFFER over the best offer is ASK_BUFFER (sellers are there); over a last trade, BUFFER.
  const ceiling = lim ? roundTick(quoteAt * (1 + ch.cap), meta.tickSize) : null, buf = lim ? (byAsk ? ch.askBuffer : ch.buffer) : 0;
  // The latest live price of the contract: its best offer, else its last trade today.
  const latestPx = () => { const t = fromTick(FEED.tick(uid, `${seg}:${c.securityId}`, { since: Date.now() - TICK_FRESH_MS })); return t ? (t.ask || (t.traded ? t.ltp : null)) : null; };
  const order = { symbol, side: 'BUY', qty, ...(lim ? { type: 'LIMIT', price: Math.min(ceiling, roundTick(quoteAt * (1 + buf), meta.tickSize)) }
    : mkt || G.market ? { type: 'MARKET', refPrice: quoteAt, marketBand: G.marketBand } : { type: 'LIMIT', price: limit }), securityId: c.securityId, exchangeSegment: seg, productType: 'INTRADAY',
    ...(qty > freeze ? { slice: true } : {}) };
  const how = mkt ? `market buy of ${qty} (${byAsk ? "best offer" : "last trade"} ${quoteAt} at ${clockMs(Date.now())}; sent again every ${ch.everyMs / 1000} s if not filled)`
    : lim ? `limit buy at ${order.price} (${byAsk ? "best offer" : "last trade"} ${quoteAt} at ${clockMs(Date.now())} + ${Math.round(buf * 100)}%, raised up to ${ceiling} if not filled)`
    : G.market ? `market buy (premium ${limit} at ${clockMs(setup.checkedAt || now)})` : `limit buy at ${limit} (premium ${quoteAt} at ${clockMs(setup.checkedAt || now)} + ${Math.round(G.padPct * 100)}%)`;
  // How long the entry may stay unfilled: CHASE until UNTIL (at least MIN_MS), else the fixed fill wait.
  const waitMs = ch ? Math.max(ch.minMs, Date.parse(`${ist(now).day}T${ch.until}+05:30`) - now) : AUTO.fillWaitMs;
  const t = ist(), s = dayState(uid, t.day), book = getBook(uid), rules = getRules(uid).active;
  // Capital per trade is checked at the premium the order was sized at, not at the chase limit above it.
  const verdict = checkOrder(lim ? { ...order, price: undefined } : order, { price: quoteAt, rules, positions: book.positions, orders: book.orders || [], concurrent: true, entryInFlight: entriesInFlight.has(uid),
    entries: s.entries, pnl: s.realized + s.unrealized, minutes: marketOpen() ? t.minutes : null, capital: capitalFor(uid, s), paused: !!s.paused,
    killSwitchActive: !!s.ks_active_at || getKillStatus(uid)?.active === true, pauseReason: s.pause_reason, subscriptionActive: !!getSubscription(uid)?.active });
  if (!verdict.ok) return skip(verdict.reason);

  // What Dhan holds of this contract (asked a few times, a fill can take a moment to show): before any "not filled",
  // "rejected" or failed placement, so a position the order status missed (4 Nov: Dhan split the order and answered
  // order id "0") is never left without its stop-loss and exit.
  const held = async (tries = HELD_TRIES) => {
    for (let k = 0; k < tries && adapter.snapshot; k++) {
      const p = (await adapter.snapshot({ funds: false }).catch(() => null))?.positions?.find(x => String(x.securityId) === String(c.securityId) && x.qty > 0);
      if (p) return { qty: p.qty, price: Number(p.avg) || null };
      if (k < tries - 1) await (pause || sleep)(HELD_WAIT_MS);
    }
    return null;
  };
  const takeOver = h => {
    qty = h.qty; lots = Math.round(qty / meta.lotSize);
    update(id, { lots, qty });
    notify(uid, { kind: 'risk', level: 'warn', title: `Algo Trading: Gap 09:15 ${direction} position found at Dhan`,
      body: `${symbol}: the order status did not show the fill, but Dhan holds ${qty}. Placing its stop-loss and exit now.` });
    audit(uid, 'algo.gap_took_over', { id, qty, price: h.price });
    return { status: 'filled', price: h.price };
  };
  // MARKET: Dhan turns an option market order into a limit at its last price + ~10% (6 Nov: 953.95 on 867.25, the price
  // ran to 1,085 first and it never filled). So: polled every POLL_MS; not filled after EVERY_MS → cancelled, what traded
  // counted, and a NEW market order sent for the rest (Dhan prices it from the new last price); until `waitMs`.
  // { status: 'filled', price (average), filledQty } when anything traded; a rejection with nothing traded is returned
  // as is (the attempts loop below places it again); else { status: 'pending' } with every order cancelled.
  const marketFill = async first => {
    const started = Date.now();
    let cur = first, filled = 0, cost = 0, waited = 0, sinceSend = 0, sent = 1;
    const add = s => { const q = Number(s?.filledQty) || (s?.status === 'filled' ? order.qty : 0); if (q > 0) { filled += q; cost += q * (Number(s.price) || quoteAt); } };
    const done = () => (filled > 0 ? { status: 'filled', price: round2(cost / filled), filledQty: filled } : { status: 'pending', filledQty: 0 });
    for (;;) {
      let s;
      try { s = await adapter.orderStatus(cur.id); } catch { s = null; }
      if (s?.status === 'filled') { add(s); return done(); }
      if (s?.status === 'failed' && !(s.filledQty > 0) && !filled && sent === 1) return s;
      const timeUp = waited >= waitMs || Date.now() - started >= waitMs;
      if (s?.status === 'failed' || sinceSend >= ch.everyMs || timeUp) {
        let after = s;
        if (s?.status !== 'failed') { await adapter.cancelOrder(cur.id).catch(() => {}); after = await adapter.orderStatus(cur.id).catch(() => null); }
        if (after?.status === 'filled') { add(after); return done(); }
        add(after);
        const rest = qty - filled;
        if (timeUp || rest < meta.lotSize) return done();
        order.qty = rest;
        if (rest > freeze) order.slice = true; else delete order.slice;
        const px = latestPx();
        if (px > 0) order.refPrice = px;
        try { cur = await adapter.placeOrder(order); } catch { return done(); }
        sent++; sinceSend = 0;
        update(id, { entry_order_id: String(cur.id) });
        audit(uid, 'order.placed', { order, result: cur, auto: 'gap', resent: sent, filledSoFar: filled });
      }
      await pause(ch.pollMs); waited += ch.pollMs; sinceSend += ch.pollMs;
    }
  };
  entriesInFlight.add(uid);
  let fill;
  try {
    let placed;
    for (let attempt = 0; ; attempt++) {
      try { placed = await adapter.placeOrder(order); }
      catch (e) {   // the order may still have gone through
        const h = await held();
        if (!h) throw e;
        fill = takeOver(h); placed = null; break;
      }
      update(id, { entry_order_id: String(placed.id), lots, qty });
      audit(uid, 'order.placed', { order, result: placed, auto: 'gap', attempt: attempt + 1 });
      // Confirmed by polling the order every FILL_POLL_MS.
      fill = placed.status === 'filled' ? placed : mkt ? await marketFill(placed)
        : lim ? await chaseFill(adapter, placed.id, { order, ceiling, first: quoteAt, tick: meta.tickSize, waitMs, pause,
        latest: latestPx, buffer: buf })
        : await waitForFill(adapter, placed.id, { pause, stepMs: G.fillPollMs });
      if (fill.status !== 'failed' || attempt >= G.maxAttempts - 1) break;
      // Rejected: placed again at once. Refused for funds (a market order is charged above the price): with the lots
      // that fit; when not even fewer lots fit, stop. Any other refusal: the same order again, priced from the latest tick.
      const forFunds = /insufficient\s+funds|insufficient\s+balance|margin\s+shortfall/i.test(String(fill.reason || ''));
      const fewer = forFunds ? lotsAfterFundsReject(fill.reason, lots, funds) : 0;
      if (forFunds && !fewer) break;
      if (fewer) {
        notify(uid, { kind: 'risk', level: 'info', title: `Algo Trading: Gap 09:15 re-sized to ${fewer} lot${fewer > 1 ? 's' : ''}`,
          body: `The broker needed more funds for ${lots} lots of ${symbol} (${fill.reason}). Placing ${fewer} lot${fewer > 1 ? 's' : ''} instead, now.` });
        lots = fewer; qty = lots * meta.lotSize; order.qty = qty;
        if (qty > freeze) order.slice = true; else delete order.slice;
      } else {
        notify(uid, { kind: 'risk', level: 'warn', title: `Algo Trading: Gap 09:15 entry rejected, placing it again`,
          body: `${symbol}: ${fill.reason || 'rejected'} (attempt ${attempt + 1} of ${G.maxAttempts}). Placing it again now.` });
        await pause(G.retryMs);
        const t = FEED.tick(uid, `${seg}:${c.securityId}`, { since: Date.now() - 5_000 });
        if (t?.ltp > 0 && order.type === 'MARKET') order.refPrice = t.ltp;
        const px = lim ? latestPx() : null;
        if (px > 0) order.price = Math.min(ceiling, Math.max(order.price, roundTick(px * (1 + buf), meta.tickSize)));
      }
    }
    if (fill.status === 'pending') {
      // Not filled at the limit: cancel. If it filled while cancelling, carry on as filled; if part of it traded,
      // carry on with that part. Either way the position gets its stop.
      await adapter.cancelOrder(placed.id).catch(() => {});
      const after = await adapter.orderStatus(placed.id).catch(() => null);
      if (after?.status === 'filled') fill = after;
      else if (after?.filledQty > 0) {
        qty = after.filledQty; lots = Math.round(qty / meta.lotSize);
        fill = { status: 'filled', price: after.price };
        update(id, { lots, qty });
        notify(uid, { kind: 'risk', level: 'info', title: `Algo Trading: Gap 09:15 ${direction} partly filled`, body: `${symbol}: ${qty} of the ${how} traded within ${Math.round(waitMs / 1000)} seconds; the rest was cancelled. Trading the ${qty}.` });
      } else {
        const h = await held();
        if (h) fill = takeOver(h);
        else { update(id, { status: 'skipped', reason: `The ${how} was not filled within ${Math.round(waitMs / 1000)} seconds${lim ? ` (last limit ${order.price})` : mkt ? ` (market orders, sent again every second)` : ""}; cancelled.`, closed_at: Date.now() });
          notify(uid, { kind: 'risk', level: 'info', title: `Algo Trading: Gap 09:15 ${direction} not filled`, body: `${symbol} ${how} was not filled within ${Math.round(waitMs / 1000)} seconds${lim ? ` (last limit ${order.price})` : mkt ? ` (market orders, sent again every second)` : ""} and was cancelled. No trade today.` });
          return { skipped: 'not filled', id }; }
      }
    }
    if (fill.status === 'failed') { const h = await held(); if (h) fill = takeOver(h); }
    if (fill.status === 'failed') {
      update(id, { status: 'failed', reason: fill.reason || 'Entry order rejected', closed_at: Date.now() });
      notify(uid, { kind: 'risk', level: 'critical', title: `Algo Trading: ${symbol} buy rejected`, body: `Dhan rejected the entry${fill.reason ? `: ${fill.reason}` : ''}.` });
      return { failed: fill.reason, id };
    }
    // MARKET re-sent: part of the quantity traded by 09:15:30, the rest cancelled; the stop covers what is held.
    if (mkt && fill.filledQty > 0 && fill.filledQty < qty) {
      qty = fill.filledQty; lots = Math.round(qty / meta.lotSize);
      update(id, { lots, qty });
      notify(uid, { kind: 'risk', level: 'info', title: `Algo Trading: Gap 09:15 ${direction} partly filled`, body: `${symbol}: ${qty} of the ${how} traded within ${Math.round(waitMs / 1000)} seconds; the rest was cancelled. Trading the ${qty}.` });
    }
  } finally { entriesInFlight.delete(uid); }

  const entryPrice = Number(fill.price) || limit;
  // Rounded up to a tick, so a fill at the stop never loses more than the budget (slippage aside).
  const stop = Math.max(meta.tickSize, roundTick(Math.ceil((entryPrice - budget / qty) / meta.tickSize - 1e-9) * meta.tickSize, meta.tickSize));
  update(id, { entry_price: entryPrice, sl_price: stop });
  const exitNow = async why => {
    update(id, { status: 'closing', reason: why });
    notify(uid, { kind: 'risk', level: 'critical', title: `Algo Trading: closing ${symbol}`, body: why });
    await adapter.exitPosition({ securityId: c.securityId, exchangeSegment: seg, productType: 'INTRADAY', qty, symbol })
      .catch(err => notify(uid, { kind: 'risk', level: 'critical', title: `Could not close ${symbol}`, body: `${err.message}. Close it in the Dhan app now.` }));
    return { closing: why, id };
  };
  try {
    const sl = await adapter.placeOrder({ symbol, side: 'SELL', qty, type: 'STOP_LOSS', triggerPrice: stop,
      price: stopLimitPrice(stop, meta.tickSize), securityId: c.securityId, exchangeSegment: seg, productType: 'INTRADAY', ...(qty > freeze ? { slice: true } : {}) });
    update(id, { status: 'open', sl_order_id: String(sl.id) });
  } catch (e) {
    return exitNow(`Dhan refused the stop-loss order (${e.message}); exiting at market so the trade is never left without a stop.`);
  }
  notify(uid, { kind: 'risk', level: 'ok', title: `Algo Trading: bought ${lots} lot${lots > 1 ? 's' : ''} ${symbol}`,
    // Users get the trade, not the strategy's rules (lib/access.js); admins get the full reasoning.
    body: !isAdminUser(uid) ? `Gap 09:15 ${direction}: entry ${entryPrice}, stop-loss ${stop} (from your Risk rules). TradeLock exits it automatically.`
      : `Gap 09:15 ${direction} (${pick}${steps ? `, ATM ${atm.strike}` : ''}${moved ? `; ${moved}` : ''}): the ATM premium opened ${setup.open} vs ${setup.prevClose} yesterday (${setup.gapPct > 0 ? '+' : ''}${setup.gapPct}%), ${setup.premiumLtp} at ${clockMs(setup.checkedAt || now)} (NIFTY ${setup.ltp}; prices from ${setup.priceSource || 'REST'}). Entry ${entryPrice} (${how}), stop-loss ${stop} (₹${budget} of today's stop-loss left ÷ ${qty} qty), risk ≈ ₹${round2((entryPrice - stop) * qty)}. Exits on the first ${direction === 'CE' ? 'red' : 'green'} 1-minute candle, the stop-loss, or at ${squareOffTime(getRules(uid).active)} IST.` });
  audit(uid, 'algo.auto_entered', { id, strategy: 'Gap 09:15', symbol, qty, entryPrice, stop });
  syncAccount(acct, { force: true }).catch(() => {});
  return { entered: true, id, symbol, qty, entryPrice, stop };
}

const gapExitChecked = new Map();   // trade id -> start of the last 1-minute candle checked

/** Gap trade exit: once per 1-minute close, the first opposite-colour index candle since the entry. */
async function gapExitDue(trade, adapter, now) {
  // Fixed exit: at EXIT_AT (09:16:00) at market, whatever the colour of the candles since the entry.
  if (AUTO.gap.exitAt) return ist(now).hhmm >= AUTO.gap.exitAt ? `Fixed exit at ${AUTO.gap.exitAt} (any candle colour)` : null;
  const lastClosed = Math.floor(now / 60_000) * 60_000 - 60_000, sinceClose = now - (lastClosed + 60_000);
  if (gapExitChecked.get(trade.id) === lastClosed) return null;
  const setup = JSON.parse(trade.detail || '{}').setup;
  // Live ticks: the feed's candle for the minute that just closed, if it can vouch for all of it, and only when every
  // minute since the entry was checked (else the REST path below scans them all).
  const first = Math.floor((setup?.checkedAt || trade.created_at) / 60_000) * 60_000;
  const bar = lastClosed >= first && (lastClosed === first || gapExitChecked.get(trade.id) === lastClosed - 60_000)
    ? FEED.minute(trade.user_id, `IDX_I:${underlyingFor(setup?.underlying).securityId}`, lastClosed, now) : null;
  if (bar) {
    gapExitChecked.set(trade.id, lastClosed);
    const opposite = trade.direction === 'CE' ? bar.close < bar.open : bar.close > bar.open;
    return opposite ? `First ${trade.direction === 'CE' ? 'red' : 'green'} 1-minute candle (${ist(lastClosed).hhmm}) after the gap entry (live ticks)` : null;
  }
  if (sinceClose < AUTO.dataGraceMs) return null;
  const one = await candlesFor(adapter, underlyingFor(setup.underlying).securityId, { index: true, interval: '1', now });
  if (!one.some(c => c.time === lastClosed) && sinceClose < AUTO.dataWaitMs) return null;   // not published yet
  gapExitChecked.set(trade.id, lastClosed);
  const c = gapExitCandle(one, { direction: trade.direction, since: setup.checkedAt || trade.created_at, now });
  return c ? `First ${trade.direction === 'CE' ? 'red' : 'green'} 1-minute candle (${ist(c.time).hhmm}) after the gap entry` : null;
}

const emaChecked = new Map();   // trade id -> start of the last 5-minute candle checked

/** Check the EMA 9 exit (or `decide`'s) once per 5-minute close. EMA 9 is seeded with the previous sessions' candles. */
async function emaExitDue(trade, adapter, now, decide = emaNineExit) {
  const lastClosed = Math.floor(now / BAR_MS) * BAR_MS - BAR_MS, sinceClose = now - (lastClosed + BAR_MS);
  if (emaChecked.get(trade.id) === lastClosed) return null;
  const setup = JSON.parse(trade.detail || '{}').setup;
  if (!setup?.confirmedAt) return null;
  // Live ticks: decide on the tick-built candle right at the close; otherwise wait for Dhan's REST candle.
  const id = underlyingFor(setup.underlying).securityId, feedKey = `IDX_I:${id}`;
  if (!tickFive(trade.user_id, feedKey, lastClosed, now) && sinceClose < AUTO.dataGraceMs) return null;
  const from = previousTradingDays(ist(now).day, 3)[0];
  const five = withTickCandle(await candlesFor(adapter, id, { index: true, interval: '5', now, from }), trade.user_id, feedKey, lastClosed, now);
  if (!five.some(c => c.time === lastClosed) && sinceClose < AUTO.dataWaitMs) return null;   // not published yet
  emaChecked.set(trade.id, lastClosed);
  // Candles from the entry on: the first one starts when the confirming candle closed.
  return decide(five, { direction: trade.direction, since: setup.confirmedAt + BAR_MS, now });
}
/** EMA 9/15 5m exit: the first opposite-colour 5-minute candle, checked once per 5-minute close. */
const emaTrendExitDue = (trade, adapter, now) => emaExitDue(trade, adapter, now, emaTrendExit);

const emaScalpChecked = new Map();   // trade id -> start of the last 1-minute candle checked

/** EMA 5/9 1m exit: once per 1-minute close, the opposite crossover since the entry. */
async function emaScalpExitDue(trade, adapter, now) {
  const lastClosed = Math.floor(now / MIN_MS) * MIN_MS - MIN_MS, since = now - (lastClosed + MIN_MS);
  if (emaScalpChecked.get(trade.id) === lastClosed) return null;
  const setup = JSON.parse(trade.detail || '{}').setup;
  if (!setup?.confirmedAt) return null;
  const u = underlyingFor(setup.underlying);
  if (!FEED.minute(trade.user_id, `IDX_I:${u.securityId}`, lastClosed, now) && since < AUTO.dataGraceMs) return null;
  const { one, source } = await oneMinuteIndex(trade.user_id, adapter, u, lastClosed, now);
  if (!source && since < AUTO.dataWaitMs) return null;   // not published yet
  emaScalpChecked.set(trade.id, lastClosed);
  return emaScalpExit(one, { direction: trade.direction, since: setup.confirmedAt + MIN_MS, now });
}

// ---- CE + PE at a target price (own switch strangle_on, settings strangle_cfg) ----
// The user's choice (7 Nov 2026), from the backtest "CE + PE at a target price": every trading day from ENTRY buy BOTH the
// NIFTY call and the put whose last price is nearest TARGET (within ±BAND_PCT %, out of the money, traded today) of the
// nearest expiry (the next one on expiry day). Looked for on every pass until ENTRY + WAIT_MIN minutes (a side not there
// yet, too little volume, an open position… is tried again). Equal lots of both: FUNDS_PCT % of the available funds
// (within the Risk rules' Capital per trade), the price padded by BLOCK_PAD for what the broker blocks on a market buy,
// at most MAX_VOL_PCT % of the thinner option's quantity traded so far today (0 = no limit). Market buys, CE first.
// No stop order at the broker: an option is sold at market once a completed 1-minute candle CLOSES at or below
// entry × (1 − STOP_PCT %) (the backtest's "minute close" stop; a resting stop order is hit by dips inside a minute, and
// on 6 Nov that sold the call at ₹2.32 before it went to ₹18.50). The other one keeps running. Whatever is still open is
// sold at EXIT (the Risk rules cutoff instead, when it is earlier). The pair counts as one trade at the risk gate.
export const STRANGLE = Object.freeze({ name: 'CE + PE target', underlying: 'NIFTY', blockPad: 0.12, retryMs: 20_000,
  defaults: Object.freeze({ target: 4, bandPct: 90, entry: '09:20', waitMin: 25, exit: '15:25', stopPct: 20, fundsPct: 100, maxVolPct: 10,
    // On the expiry day: 'next' = the next expiry, 'skip' = no trade, 'next1' = the next expiry also the trading day before.
    // capital > 0: size from it (+ this strategy's realised P&L since capitalSince when compound), within the available
    // funds and the Risk rules capital; 0 = the available funds.
    expiryDay: 'next', capital: 0, compound: true, capitalSince: 0 }) });
/** Its settings on one index (the Algo Trading grid; NIFTY: also the older strangle_cfg), over the defaults and the index's usual target. */
export const strangleConfig = (acct, U = STRANGLE.underlying) => ({ ...STRANGLE.defaults, target: STRANGLE_INDEX_TARGETS[U] ?? STRANGLE.defaults.target, ...slotCfg(acct, 'strangle', U) });

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Dhan's trade-book symbol of an index option, e.g. NIFTY-Nov2026-27350-CE (the month only, not the expiry day). */
const fillSymbol = t => (t.expiry && t.strike ? `${String(t.symbol || 'NIFTY').split(' ')[0]}-${MONTHS[Number(t.expiry.slice(5, 7)) - 1]}${t.expiry.slice(0, 4)}-${Number(t.strike)}-${t.direction}` : null);
/** Average price of the sells of a closed trade's option from the broker fills (after its entry, up to its quantity). */
export function exitFromFills(t) {
  const sym = fillSymbol(t); if (!sym) return null;
  let q = 0, v = 0;
  for (const f of stmt(`SELECT qty, price FROM trades WHERE user_id = ? AND day = ? AND kind = 'exec' AND symbol = ? AND side = 'SELL' AND ts >= ? ORDER BY ts, id`).all(t.user_id, t.day, sym, t.created_at)) {
    const take = Math.min(Number(f.qty), t.qty - q); if (take <= 0) break;
    q += take; v += take * Number(f.price);
  }
  return q >= t.qty && q > 0 ? Math.round(v / q * 100) / 100 : null;
}
/** The CE + PE strategy's capital: cfg.capital, plus its realised P&L (after charges) since cfg.capitalSince when compounding. */
export function strangleCapital(uid, cfg, paper = 0, U = STRANGLE.underlying) {
  if (!(cfg.capital > 0)) return null;
  if (!cfg.compound) return cfg.capital;
  let pnl = 0;
  for (const t of stmt(`SELECT * FROM auto_trades WHERE user_id = ? AND status = 'closed' AND paper = ? AND created_at >= ? AND entry_price IS NOT NULL AND qty > 0
      AND json_extract(detail, '$.setup.strategy') = ? AND COALESCE(json_extract(detail, '$.setup.underlying'), 'NIFTY') = ?`).all(uid, paper, cfg.capitalSince || 0, STRANGLE.name, U)) {
    let exit = t.exit_price;
    if (exit == null) { exit = exitFromFills(t); if (exit != null) update(t.id, { exit_price: exit }); }
    if (exit == null) continue;
    pnl += (exit - t.entry_price) * t.qty - optionCharges(t.day, t.entry_price * t.qty, exit * t.qty).total;
  }
  return Math.round((cfg.capital + pnl) * 100) / 100;
}
/** The next weekday that is not an NSE holiday. */
const nextMarketDay = day => { let d = day; do { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + 1); d = x.toISOString().slice(0, 10); } while ([0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()) || NSE_HOLIDAYS[d]); return d; };

/** The call and the put (out of the money, traded today) whose last price is nearest cfg.target within ±cfg.bandPct %. */
export function strangleLegs(chain, cfg) {
  const spot = Number(chain?.last_price), lo = cfg.target * (1 - cfg.bandPct / 100), hi = cfg.target * (1 + cfg.bandPct / 100), best = {};
  for (const [k, sides] of Object.entries(chain?.oc || {})) {
    const strike = Number(k);
    if (!Number.isFinite(strike)) continue;
    for (const side of ['CE', 'PE']) {
      const raw = sides?.[side.toLowerCase()];
      if (!raw?.security_id || (spot > 0 && (side === 'CE' ? strike <= spot : strike >= spot))) continue;
      const ltp = Number(raw.last_price);
      if (!(ltp >= lo && ltp <= hi) || !(Number(raw.volume) > 0)) continue;
      if (!best[side] || Math.abs(ltp - cfg.target) < Math.abs(best[side].ltp - cfg.target))
        best[side] = { side, strike, securityId: String(raw.security_id), ltp, ask: Number(raw.top_ask_price) || 0 };
    }
  }
  return best;
}

/** Whole lots of both: the funds share (within the capital limit) at the padded prices, and the volume limit. */
export function sizeStrangle({ ce, pe, lotSize, funds, fundsPct, capitalLimit = Infinity, volumes = null, maxVolPct = 0, pad = STRANGLE.blockPad }) {
  const perLot = (ce + pe) * lotSize * (1 + pad);
  if (!(perLot > 0) || !(funds > 0)) return { lots: 0, why: 'funds' };
  let lots = Math.floor(Math.min(funds * fundsPct / 100 * 0.98, capitalLimit) / perLot + 1e-9), why = 'funds';
  if (maxVolPct > 0 && volumes) {
    const cap = Math.floor(Math.min(...volumes) * maxVolPct / 100 / lotSize + 1e-9);
    if (cap < lots) { lots = cap; why = 'volume'; }
  }
  return { lots: Math.max(0, lots), why };
}

const strangleState = new Map();   // `${userId}:${day}` -> { nextTry, lastReason, gaveUp }
const hhmmOf = ms => new Date(ms + 19_800_000).toISOString().slice(11, 16);

/** One pass for an account with CE + PE on an index: inside its entry window, find the pair and buy it (once a day per index). */
export async function strangleTick(acct, { now = Date.now(), adapter = adapterFor(acct), instruments = optionMeta, pause = sleep, underlying = STRANGLE.underlying } = {}) {
  const u = underlyingFor(underlying), U = u.key, seg = u.optionSegment;
  const raw = acct;
  acct = withAllowedStrategies(indexView(acct, U));
  if (acct.strangle_on !== 1 || !marketOpen(now)) return { skipped: 'off' };
  // NIFTY keeps the key it had before the grid (one trade a day is checked across a deploy); other indices add theirs.
  const uid = acct.user_id, day = ist(now).day, cfg = strangleConfig(raw, U), key = U === 'NIFTY' ? `${day}:strangle` : `${day}:strangle:${U}`;
  const start = Date.parse(`${day}T${cfg.entry}:00+05:30`), until = start + cfg.waitMin * 60_000;
  if (now < start) return { skipped: 'before the entry time' };
  if (stmt('SELECT 1 FROM auto_trades WHERE user_id = ? AND signal_key IN (?, ?)').get(uid, `${key}:CE`, `${key}:PE`)) return { skipped: 'done today' };
  const sk = `${uid}:${day}:${U}`, st = strangleState.get(sk) || {};
  if (now < (st.nextTry || 0)) return { skipped: 'waiting' };
  strangleState.set(sk, { ...st, nextTry: now + STRANGLE.retryMs });
  const later = reason => { strangleState.set(sk, { ...strangleState.get(sk), lastReason: reason }); return { skipped: reason }; };
  if (now > until) {
    // The window is over without an entry: recorded once (the Algo page lists it) and notified.
    const reason = `No entry between ${cfg.entry} and ${hhmmOf(until)}: ${st.lastReason || 'not checked in time'}.`;
    stmt(`INSERT OR IGNORE INTO auto_trades (user_id, day, signal_key, direction, status, reason, detail, created_at, closed_at, paper)
      VALUES (?, ?, ?, 'CE', 'skipped', ?, ?, ?, ?, ?)`).run(uid, day, `${key}:CE`, reason.slice(0, 240), JSON.stringify({ setup: { strategy: STRANGLE.name, underlying: U, cfg } }), now, now, acct.paper_mode === 1 ? 1 : 0);
    notify(uid, { kind: 'risk', level: 'warn', title: `Algo Trading: ${STRANGLE.name} ${u.label} not traded today`, body: reason });
    return { skipped: reason };
  }
  const risk = scalperSignalRisk(uid, { concurrent: true });   // other strategies' or indices' open trades do not block it
  if (risk.reason) return later(risk.reason);
  if (entriesInFlight.has(uid)) return later('another order was being placed');


  const up = [...new Set(await chainCall(uid, () => adapter.optionExpiries({ underlyingScrip: Number(u.securityId), underlyingSeg: 'IDX_I' })))].filter(e => e >= day).sort();
  // On the expiry day: the next expiry, or no trade (cfg.expiryDay 'skip'); 'next1': the next expiry also the day before.
  if (up[0] === day && cfg.expiryDay === 'skip') {
    const reason = `Expiry day (${day}): skipped by your setting.`;
    stmt(`INSERT OR IGNORE INTO auto_trades (user_id, day, signal_key, direction, status, reason, detail, created_at, closed_at, paper)
      VALUES (?, ?, ?, 'CE', 'skipped', ?, ?, ?, ?, ?)`).run(uid, day, `${key}:CE`, reason, JSON.stringify({ setup: { strategy: STRANGLE.name, underlying: U, cfg } }), now, now, acct.paper_mode === 1 ? 1 : 0);
    return { skipped: reason };
  }
  const expiry = up[0] === day || (cfg.expiryDay === 'next1' && up[0] === nextMarketDay(day)) ? up[1] : up[0];
  if (!expiry) return later(`Dhan returned no upcoming ${u.label} expiry`);
  const chain = await chainCall(uid, () => adapter.optionChain({ underlyingScrip: Number(u.securityId), underlyingSeg: 'IDX_I', expiry }));
  const legs = strangleLegs(chain, cfg), lo = round2(cfg.target * (1 - cfg.bandPct / 100)), hi = round2(cfg.target * (1 + cfg.bandPct / 100));
  if (!legs.CE || !legs.PE) return later(`no ${!legs.CE && !legs.PE ? 'call or put' : !legs.CE ? 'call' : 'put'} at ₹${lo}–${hi} that has traded today in the ${expiry} chain`);
  for (const L of [legs.CE, legs.PE]) { const h = heldBy(uid, L.securityId); if (h) return later(`${h.symbol} is held by the open ${h.strategy} trade`); }
  const meta = await instruments(u), lotSize = meta.get(legs.CE.securityId)?.lotSize || meta.get(legs.PE.securityId)?.lotSize, tick = meta.get(legs.CE.securityId)?.tickSize || AUTO.optionTick;
  if (!(lotSize > 0)) return later(`the lot size of ${u.label} ${expiry} options is unavailable`);
  // Quantity traded so far today (1-minute candles, as the backtest's volume limit).
  const volumes = [];
  if (cfg.maxVolPct > 0) for (const L of [legs.CE, legs.PE]) {
    const one = await candlesFor(adapter, L.securityId, { interval: '1', now, segment: seg });
    volumes.push(one.filter(c => c.time <= now).reduce((a, c) => a + (Number(c.volume) || 0), 0));
  }
  const px = L => (L.ask > 0 ? L.ask : L.ltp), available = Number(getBook(uid).funds?.available);
  // Its own capital (+ its realised P&L when compounding), never more than the available funds.
  const own = strangleCapital(uid, cfg, acct.paper_mode === 1 ? 1 : 0, U), funds = own == null ? available : Math.min(available, Math.max(0, own));
  const size = sizeStrangle({ ce: px(legs.CE), pe: px(legs.PE), lotSize, funds, fundsPct: cfg.fundsPct, capitalLimit: risk.budget?.capitalLimit ?? Infinity,
    volumes: cfg.maxVolPct > 0 ? volumes : null, maxVolPct: cfg.maxVolPct });
  if (size.lots < 1) return later(size.why === 'volume' ? `too little traded so far (${volumes.join(' / ')} qty): ${cfg.maxVolPct}% is under one lot of each`
    : own != null && own < available ? `the strategy's capital ₹${Math.round(own)} buys no lot of both` : `₹${Math.round(available || 0)} available buys no lot of both`);
  const qty = size.lots * lotSize;
  // The pair as ONE trade at the risk gate (trade cap, one trade at a time, capital per trade on both together).
  const t = ist(now), s = dayState(uid, t.day), book = getBook(uid), rules = getRules(uid).active;
  const verdict = checkOrder({ symbol: `${u.symbol} ${expiry} CE+PE`, side: 'BUY', qty, price: round2(px(legs.CE) + px(legs.PE)) }, { rules, positions: book.positions, orders: book.orders || [],
    concurrent: true, entryInFlight: entriesInFlight.has(uid), entries: s.entries, pnl: s.realized + s.unrealized, minutes: t.minutes, capital: capitalFor(uid, s), paused: !!s.paused,
    killSwitchActive: !!s.ks_active_at || getKillStatus(uid)?.active === true, pauseReason: s.pause_reason, subscriptionActive: !!getSubscription(uid)?.active });
  if (!verdict.ok) return later(verdict.reason);

  // Claim both legs before any order: a second pass or a restart never buys them again.
  const setup = { strategy: STRANGLE.name, underlying: u.key, cfg, picked: { CE: legs.CE, PE: legs.PE }, volumes, at: now };
  const ids = {};
  for (const side of ['CE', 'PE']) {
    const L = legs[side], symbol = `${u.symbol} ${expiry} ${L.strike} ${side}`;
    const r = stmt(`INSERT OR IGNORE INTO auto_trades (user_id, day, signal_key, direction, status, security_id, exchange_segment, symbol, expiry, strike, lots, qty, detail, created_at, paper)
      VALUES (?, ?, ?, ?, 'placing', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(uid, day, `${key}:${side}`, side, L.securityId, seg, symbol, expiry, L.strike, size.lots, qty, JSON.stringify({ setup }), now, acct.paper_mode === 1 ? 1 : 0);
    if (!r.changes) return { skipped: 'already claimed' };
    ids[side] = Number(r.lastInsertRowid);
  }
  const bought = [], startedAt = Date.now();   // fills are stamped on the caller's clock (`now`) plus the time spent placing
  entriesInFlight.add(uid);
  try {
    for (const side of ['CE', 'PE']) {
      const L = legs[side], id = ids[side], symbol = `${u.symbol} ${expiry} ${L.strike} ${side}`;
      const order = { symbol, side: 'BUY', qty, type: 'MARKET', securityId: L.securityId, exchangeSegment: seg, productType: 'INTRADAY', refPrice: px(L) };
      if (qty > (AUTO.freezeQty[u.key] || AUTO.maxQty)) order.slice = true;
      let fill;
      try {
        const placed = await adapter.placeOrder(order);
        update(id, { entry_order_id: String(placed.id) });
        audit(uid, 'order.placed', { order, result: placed, auto: 'strangle' });
        fill = placed.status === 'filled' ? placed : await waitForFill(adapter, placed.id, { pause });
        if (fill.status === 'pending') {
          await adapter.cancelOrder(placed.id).catch(() => {});
          const after = await adapter.orderStatus(placed.id).catch(() => null);
          fill = after?.filledQty > 0 ? { ...after, status: 'filled' } : { status: 'failed', reason: `not filled within ${AUTO.fillWaitMs / 1000} seconds; cancelled` };
        }
      } catch (e) { fill = { status: 'failed', reason: e.message }; }
      if (fill.status !== 'filled') {
        update(id, { status: 'failed', reason: String(fill.reason || 'Entry order rejected').slice(0, 240), closed_at: Date.now() });
        if (side === 'CE') {
          update(ids.PE, { status: 'skipped', reason: 'The call was not bought, so the put was not either.', closed_at: Date.now() });
          notify(uid, { kind: 'risk', level: 'critical', title: `Algo Trading: ${STRANGLE.name} ${u.label} not traded`, body: `The ${symbol} buy failed (${fill.reason || 'rejected'}), so neither option was bought. Check Dhan for anything open.` });
          return { failed: fill.reason };
        }
        notify(uid, { kind: 'risk', level: 'critical', title: `Algo Trading: ${symbol} not bought`, body: `${fill.reason || 'Rejected'}. The call that was bought keeps its own stop and exit.` });
        break;
      }
      const filledQty = Number(fill.filledQty) || qty, entryPrice = Number(fill.price) || px(L), stop = Math.max(tick, roundTick(Math.floor(entryPrice * (1 - cfg.stopPct / 100) / tick + 1e-8) * tick, tick));
      update(id, { status: 'open', entry_price: entryPrice, sl_price: stop, qty: filledQty, lots: Math.round(filledQty / lotSize), detail: JSON.stringify({ setup: { ...setup, filledAt: now + (Date.now() - startedAt) } }) });
      audit(uid, 'algo.auto_entered', { id, strategy: STRANGLE.name, symbol, qty: filledQty, entryPrice, stop });
      bought.push(`${symbol}: ${Math.round(filledQty / lotSize)} lot${filledQty / lotSize > 1 ? 's' : ''} at ${entryPrice} (stop ${stop} on a 1-minute close)`);
    }
  } finally { entriesInFlight.delete(uid); }
  if (bought.length) notify(uid, { kind: 'risk', level: 'ok', title: `Algo Trading: ${STRANGLE.name} ${u.label} bought`,
    body: `${bought.join('; ')}. Each is sold at market if a 1-minute candle closes ${cfg.stopPct}% below its entry; the rest at ${strangleSquareOff(cfg, getRules(uid).active)} IST.${size.why === 'volume' ? ` Size kept to ${cfg.maxVolPct}% of the quantity traded so far.` : ''}` });
  syncAccount(acct, { force: true }).catch(() => {});
  return { entered: bought.length, ids };
}

/** CE + PE exit time: its own EXIT, or the Risk rules cutoff when that is on and earlier. */
export const strangleSquareOff = (cfg, rules) => (rules?.cutoff?.on && rules.cutoff.value < cfg.exit ? rules.cutoff.value : cfg.exit);

const strangleChecked = new Map();   // trade id -> start of the last 1-minute candle checked
/** CE + PE exit: the exit time, or a completed 1-minute candle of this option closing at or below its stop (once a minute). */
async function strangleExitDue(trade, adapter, now) {
  const setup = JSON.parse(trade.detail || '{}').setup || {}, cfg = { ...STRANGLE.defaults, ...setup.cfg };
  if (ist(now).hhmm >= cfg.exit) return `Exit at ${cfg.exit}`;
  const stop = Number(trade.sl_price), lastClosed = Math.floor(now / MIN_MS) * MIN_MS - MIN_MS, since = now - (lastClosed + MIN_MS);
  if (!(stop > 0) || lastClosed < Math.floor((setup.filledAt || trade.created_at) / MIN_MS) * MIN_MS + MIN_MS || strangleChecked.get(trade.id) === lastClosed) return null;
  const seg = trade.exchange_segment || 'NSE_FNO';
  let bar = FEED.minute(trade.user_id, `${seg}:${trade.security_id}`, lastClosed, now);
  if (!bar) {
    if (since < AUTO.dataGraceMs) return null;
    const one = await candlesFor(adapter, trade.security_id, { interval: '1', now, segment: seg });
    bar = one.find(c => c.time === lastClosed);
    if (!bar && since < AUTO.dataWaitMs) return null;          // not published yet (or no trade that minute)
    bar ||= one.filter(c => c.time < lastClosed).at(-1);       // no trade in that minute: its price is the last one
  }
  strangleChecked.set(trade.id, lastClosed);
  return bar && bar.close <= stop ? `Stop −${cfg.stopPct}%: the ${ist(lastClosed).hhmm} minute closed at ${round2(bar.close)} (stop ${round2(stop)})` : null;
}

const exitTry = new Map();   // trade id -> last exit attempt

/**
 * After cancelling a stop: its final status once Dhan no longer reports it pending (checked every 250 ms, up to 3 s),
 * or null. 'filled' means it sold before the cancel landed: then there is nothing left to exit.
 */
export async function stopGone(adapter, orderId, { tries = 12, waitMs = 250 } = {}) {
  for (let i = 0; i < tries; i++) {
    const s = await adapter.orderStatus(orderId).catch(() => null);
    if (s && s.status !== 'pending') return s.filledQty > 0 ? 'filled' : s.status;
    await new Promise(r => setTimeout(r, waitMs));
  }
  return null;
}

/** Follow an open auto trade: notice the stop-loss fill, square off at cutoff, never leave a stray stop order. */
export async function manageTrade(trade, { now = Date.now(), acct = accountFor(trade.user_id), adapter: given } = {}) {
  const uid = trade.user_id;
  if (trade.status === 'placing') {
    if (now - trade.created_at > AUTO.placingTimeoutMs && !entriesInFlight.has(uid) && !scanning.has(uid)) {
      update(trade.id, { status: 'failed', reason: 'Interrupted while placing the entry', closed_at: now });
      if (trade.entry_order_id) notify(uid, { kind: 'risk', level: 'critical', title: 'Algo Trading: entry interrupted',
        body: `The server was interrupted while placing ${trade.symbol || 'an ORB entry'}. Check Dhan for an open position without a stop-loss.` });
    }
    return;
  }
  if (!acct || acct.status === 'disconnected') return;
  const adapter = given || adapterFor(acct), book = getBook(uid);
  if (!book.at || now - book.at > 15_000) return;   // act only on a fresh broker view
  const pos = book.positions.find(p => String(p.securityId) === trade.security_id && p.qty !== 0);
  if (pos && !trade.seen_open) { update(trade.id, { seen_open: 1 }); trade = { ...trade, seen_open: 1 }; }

  if (!pos && (trade.seen_open || now - trade.created_at > 60_000)) {
    // Flat: the stop filled, or the position was closed some other way. Then the stop order must go,
    // or a later trigger would sell an option we no longer hold.
    let sl = null;
    if (trade.sl_order_id) {
      sl = await adapter.orderStatus(trade.sl_order_id).catch(() => null);
      if (sl?.status === 'pending') {
        try { await adapter.cancelOrder(trade.sl_order_id); }
        catch (e) { notify(uid, { kind: 'risk', level: 'critical', title: `Cancel the stop-loss for ${trade.symbol}`,
          body: `The position is closed but the stop-loss order could not be cancelled (${e.message}). Cancel it in the Dhan app.` }); }
      }
    }
    const stopped = sl?.status === 'filled';
    // Our own exit (fixed exit, strategy exit, square-off): its fill price, from the exit order it last sent.
    const exitId = !stopped && JSON.parse(trade.detail || '{}').exitOrderId;
    const exited = exitId ? await adapter.orderStatus(exitId).catch(() => null) : null;
    // Sliced exits (more than the freeze quantity) and positions closed elsewhere: the average of the broker's sell fills.
    const exitPrice = (stopped ? Number(sl.price) || trade.sl_price : exited?.status === 'filled' ? Number(exited.price) || null : null) ?? exitFromFills(trade);
    update(trade.id, { status: 'closed', closed_at: now, exit_price: exitPrice,
      reason: stopped ? 'Stop-loss hit' : trade.status === 'closing' ? trade.reason || 'Squared off' : 'Position closed outside the auto-trader' });
    notify(uid, { kind: 'risk', level: stopped ? 'warn' : 'info', title: `Algo Trading: ${trade.symbol} closed`,
      body: `${stopped ? `Stop-loss hit at ${Number(sl.price) || trade.sl_price}.` : trade.status === 'closing' ? `${trade.reason || 'Squared off'}.` : 'The position was closed outside the auto-trader; its stop-loss order was cancelled.'} The next ORB or EMA 5/9 crossover signal can trade with the stop-loss left for today.` });
    audit(uid, 'algo.auto_closed', { id: trade.id, symbol: trade.symbol, stopped });
    return;
  }
  if (!pos) return;
  if (trade.status === 'open') await costToCost(trade, adapter, now).catch(e => console.error('[autotrade] cost-to-cost', e.message));
  if (trade.status === 'open') {
    const strategy = JSON.parse(trade.detail || '{}').setup?.strategy;
    // Gap open 09:15 with its auto exit switched off (Algo page): no 09:16 exit; the stop-loss, a manual exit or the cutoff.
    const why = strategy === 'Gap 09:15' && acct?.gap_auto_exit === 0 ? null : await (strategy === 'Gap 09:15' ? gapExitDue : strategy === STRANGLE.name ? strangleExitDue : strategy === EMA_SCALP.name ? emaScalpExitDue : strategy === EMA_TREND.name ? emaTrendExitDue : emaExitDue)(trade, adapter, now).catch(() => null);
    // Users see that the strategy closed it, not its exit rule (lib/access.js).
    const shown = why && strategy === 'Gap 09:15' && !isAdminUser(uid) ? 'Strategy exit' : why;
    if (why) { update(trade.id, { status: 'closing', reason: shown }); trade = { ...trade, status: 'closing', reason: shown }; }
  }
  // CE + PE: its own exit time (15:25), not the default 15:15 square-off; the Risk rules cutoff still wins when earlier.
  const setupNow = JSON.parse(trade.detail || '{}').setup;
  const squareOff = setupNow?.strategy === STRANGLE.name ? strangleSquareOff({ ...STRANGLE.defaults, ...setupNow.cfg }, getRules(uid).active) : squareOffTime(getRules(uid).active);
  const due = trade.status === 'closing' || ist(now).hhmm >= squareOff;
  if (!due || now - (exitTry.get(trade.id) || 0) < 30_000) return;
  // An earlier exit order still working at Dhan: wait for it rather than selling twice.
  const slLegs = String(trade.sl_order_id || '').split(',');   // a sliced stop is several orders
  if ((book.orders || []).some(o => o.symbol === pos.symbol && !slLegs.includes(String(o.id)))) return;
  exitTry.set(trade.id, now);
  // Cancel the stop first: exiting while it rests could sell twice and open a short.
  if (trade.sl_order_id) {
    const sl = await adapter.orderStatus(trade.sl_order_id).catch(() => null);
    if (sl?.status === 'pending') {
      const cancelled = await adapter.cancelOrder(trade.sl_order_id).then(() => true, () => false);
      if (!cancelled) return;   // try again on a later pass
      // Wait until Dhan has really cancelled it: while the stop still holds the quantity, Dhan's RMS reads the exit
      // as a fresh short sale and rejects it for margin (2 Nov 2026: "insufficient funds", the exit went 32 s late).
      const gone = await stopGone(adapter, trade.sl_order_id);
      if (!gone) { exitTry.delete(trade.id); return; }   // still pending: check again on the next pass
      if (gone === 'filled') return;                     // (part) sold by the stop: the next pass sees the book

    } else if (sl?.status === 'filled') return;   // the stop is filling; the next pass sees it flat
  }
  const reason = trade.status === 'closing' ? trade.reason : `Square-off at ${squareOff} IST`;
  if (trade.status !== 'closing') update(trade.id, { status: 'closing', reason });
  await adapter.exitPosition(pos).then(
    r => {
      if (r?.id) update(trade.id, { detail: JSON.stringify({ ...JSON.parse(trade.detail || '{}'), exitOrderId: r.id }) });
      notify(uid, { kind: 'risk', level: 'info', title: `Algo Trading: exiting ${trade.symbol}`, body: `${reason}.` });
    },
    e => notify(uid, { kind: 'risk', level: 'critical', title: `Could not square off ${trade.symbol}`, body: `${e.message}. Close it in the Dhan app.` }));
  syncAccount(acct, { force: true }).catch(() => {});
}

const scanning = new Set();

// ---- Algo only: while Algo Trading is on, a manual F&O position opened today is closed at once ----
const FNO = new Set(['NSE_FNO', 'BSE_FNO']);
const OWN_MS = 120_000;      // a just-closed automatic trade still owns its position while the book catches up
const RECLOSE_MS = 30_000;   // after sending an exit, wait for it before trying the same contract again
const manualClosedAt = new Map();

/**
 * Today's F&O quantity no automatic trade accounts for (what to close), as positions with the signed qty
 * to close. Carried positions are left alone; automatic trades only buy, so any short opened today is manual.
 */
export function manualExcess(positions, autoTrades) {
  const own = new Map();
  for (const t of autoTrades || []) if (t.security_id && t.qty) own.set(String(t.security_id), (own.get(String(t.security_id)) || 0) + Number(t.qty));
  const out = [];
  for (const p of positions || []) {
    const qty = Number(p.qty) || 0;
    if (!qty || !FNO.has(p.exchangeSegment)) continue;
    const today = qty - (Number(p.carryQty) || 0), mine = own.get(String(p.securityId)) || 0;
    let excess = today > 0 ? Math.max(0, today - mine) : today;
    if (!excess || Math.sign(excess) !== Math.sign(qty)) continue;          // nothing manual, or only a carried part is left
    excess = Math.sign(qty) * Math.min(Math.abs(excess), Math.abs(qty));     // never more than is open
    out.push({ ...p, qty: excess });
  }
  return out;
}

// ---- Dynamic SL: cost to cost ----
const costTry = new Map();   // trade id -> last attempt (a refused modify is retried, not hammered)
/** The trade's cost-to-cost R from AUTO.costToCostR (by its strategy). */
const costR = trade => { const k = JSON.parse(trade.detail || '{}').setup?.strategy; return AUTO.costToCostR[k] ?? AUTO.costToCostR.default; };
/**
 * Once the option trades at entry + R × the risk (entry − stop), the stop-loss order at Dhan is moved up to the entry
 * price: from then on the trade cannot lose (only charges and a little slippage). Once per trade. Live tick prices.
 */
export async function costToCost(trade, adapter, now = Date.now(), { r = costR(trade) } = {}) {
  const entry = Number(trade.entry_price), stop = Number(trade.sl_price);
  if (!(r > 0) || !trade.sl_order_id || !(entry > 0) || !(stop > 0) || stop >= entry || !adapter.ltp || !adapter.modifyStopLoss) return null;
  if (now - (costTry.get(trade.id) || 0) < 20_000) return null;
  const price = await livePrice(trade.user_id, adapter, trade.exchange_segment || 'NSE_FNO', trade.security_id, now);
  if (!(price >= entry + r * (entry - stop))) return null;
  costTry.set(trade.id, now);
  const trigger = roundTick(entry, AUTO.optionTick);
  try {
    await adapter.modifyStopLoss(trade.sl_order_id, { triggerPrice: trigger, price: stopLimitPrice(trigger, AUTO.optionTick), qty: trade.qty });
  } catch (e) {
    notify(trade.user_id, { kind: 'risk', level: 'warn', title: `Algo Trading: could not move the stop for ${trade.symbol}`, body: `${e.message}. It stays at ${stop}; TradeLock tries again.` });
    return null;
  }
  const detail = JSON.parse(trade.detail || '{}');
  update(trade.id, { sl_price: trigger, detail: JSON.stringify({ ...detail, costToCost: { at: now, price, from: stop } }) });
  notify(trade.user_id, { kind: 'risk', level: 'ok', title: `Algo Trading: stop moved to cost on ${trade.symbol}`,
    body: `The premium reached ${price} (entry ${entry} + ${r === 1 ? '' : `${r} × `}the ${round2(entry - stop)} risk), so the stop-loss is now at the entry price ${trigger}. Worst case from here: about ₹0 plus charges.` });
  audit(trade.user_id, 'algo.cost_to_cost', { id: trade.id, symbol: trade.symbol, from: stop, to: trigger, price });
  return trigger;
}

/** Close manual entries for one account (Algo Trading on, market open). Returns what was sent. */
export async function closeManualEntries(acct, { adapter = adapterFor(acct), now = Date.now() } = {}) {
  const uid = acct.user_id;
  if (!acct.algo_on || !acct.agent_on || acct.manual_on === 1 || !marketOpen() || entriesInFlight.has(uid)) return [];   // manual trades allowed: leave them
  const autoTrades = stmt(`SELECT * FROM auto_trades WHERE user_id = ? AND (status IN ('placing', 'open', 'closing') OR (status = 'closed' AND closed_at > ?))`).all(uid, now - OWN_MS);
  if (autoTrades.some(t => t.status === 'placing')) return [];   // an automatic entry is landing: match it on the next pass
  const sent = [];
  for (const p of manualExcess(getBook(uid).positions, autoTrades)) {
    const key = `${uid}:${p.securityId}`;
    if (now - (manualClosedAt.get(key) || 0) < RECLOSE_MS) continue;
    manualClosedAt.set(key, now);
    try {
      await adapter.exitPosition(p);
      sent.push(p);
      audit(uid, 'algo.manual_closed', { symbol: p.symbol, qty: p.qty });
      notify(uid, { kind: 'risk', level: 'warn', title: 'Manual trade closed',
        body: `Algo Trading is on, so only automatic entries are allowed. ${p.symbol} (${Math.abs(p.qty)} qty) was closed at market. To trade by hand, allow manual trades on the AI Algo Trading page.` });
    } catch (e) {
      console.error('[autotrade] manual close', p.symbol, e.message);
      notify(uid, { kind: 'risk', level: 'error', title: 'Could not close a manual trade', body: `${p.symbol}: ${e.message}. Close it in your broker app.` });
    }
  }
  if (sent.length) syncAccount(acct, { force: true }).catch(() => {});
  return sent;
}

let gapTimersDay = null;
let manageNow = null;   // startAutoTrader's manage(trade): the 09:16:00 timer checks the gap trade at once

/**
 * Gap open 09:15 runs on its own clock, not the scanner tick: the prefetch PREFETCH_MS before the open, the first-tick
 * watcher from LEAD_MS before it, and the REST check CHECK_AFTER_MS after it (09:15:02) when no first ticks came.
 * Armed by a tick in the minutes before the open; a scanner pass inside the check window is the fallback (e.g. after
 * a restart at 09:15).
 */
function scheduleGap(now = Date.now()) {
  const day = ist(now).day, open = Date.parse(`${day}T09:15:00+05:30`), G = AUTO.gap;
  if (gapTimersDay === day || !isTradingDay(now) || now >= open + G.checkAfterMs || now < open - G.prefetchMs - 5 * 60_000) return;
  gapTimersDay = day;
  const gapAccounts = () => {
    // 'delayed' / 'degraded' too: a sync blip must not drop the trade silently (the entry checks the book itself).
    try { return stmt(`SELECT * FROM broker_accounts WHERE gap_on = 1 AND algo_on = 1 AND agent_on = 1 AND ${TRADES} AND status IN ('connected', 'delayed', 'degraded')`).all(); }
    catch (e) { console.error('[autotrade] gap', e.message); return []; }
  };
  setTimeout(() => {
    for (const acct of gapAccounts()) for (const k of strategyIndices(acct, 'gap'))
      gapPrefetch(acct, adapterFor(acct), underlyingFor(k)).catch(e => console.error('[autotrade] gap prefetch', k, e.message));
  }, Math.max(0, open - G.prefetchMs - now));
  if (G.firstTick) setTimeout(() => {
    for (const acct of gapAccounts()) for (const k of strategyIndices(acct, 'gap'))
      gapFirstTick(acct, adapterFor(acct), underlyingFor(k), { pause: sleep, instruments: optionMeta }).catch(e => console.error('[autotrade] gap first tick', k, e.message));
  }, Math.max(0, open - G.leadMs - now));
  // The fixed gap exit, exactly at EXIT_AT (09:16:00.000): open gap trades are checked then, not on the next tick.
  if (G.exitAt) setTimeout(() => {
    try {
      for (const trade of stmt(`SELECT * FROM auto_trades WHERE day = ? AND status IN ('open', 'closing') AND json_extract(detail, '$.setup.strategy') = 'Gap 09:15'`).all(day)) manageNow?.(trade);
    } catch (e) { console.error('[autotrade] gap exit', e.message); }
  }, Math.max(0, Date.parse(`${day}T${G.exitAt}:00+05:30`) - now));
  // Without the first-tick watcher: the REST check at 09:15:02 (with it, the watcher polls Dhan's quotes itself).
  if (!G.firstTick) setTimeout(() => {
    if (!marketOpen()) return;
    for (const acct of gapAccounts()) (async () => {
      for (const k of strategyIndices(acct, 'gap')) await gapCheck(withAllowedStrategies(indexView(acct, k)), adapterFor(acct), Date.now(), underlyingFor(k), { pause: sleep, instruments: optionMeta })
        .catch(e => console.error('[autotrade] gap', k, e.message));
    })();
  }, Math.max(0, open + G.checkAfterMs - now));
}

const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} did not answer within ${ms / 1000} s`)), ms))]);
const brokerName = b => (b === 'stoxkart' ? 'StoxKart' : b === 'paper' ? 'Paper' : 'Dhan');
const accountRow = id => stmt('SELECT * FROM broker_accounts WHERE id = ?').get(id);
// The broker calls of the pre-open check and route; a mutable object so tests can stand in for the brokers.
export const PREOPEN_IO = { sync: (acct, o) => syncAccount(acct, o), probe: (acct, via) => probeAdapter(acct, via), switchVia: (acct, on, o) => switchTradeVia(acct, on, o) };

/** Sync the trading broker now. connected: it answered; ok: and it reports funds. */
async function brokerHealth(acct) {
  await withTimeout(PREOPEN_IO.sync(acct, { force: true }), AUTO.preopen.probeMs, brokerName(tradingBroker(acct))).catch(() => {});
  const fresh = accountRow(acct.id) || acct, funds = Number(getBook(acct.user_id).funds?.available);
  return { acct: fresh, connected: fresh.status === 'connected', ok: fresh.status === 'connected' && funds > 0, status: fresh.status, error: fresh.last_error, funds };
}

/** The broker this account is NOT trading through, tested now: { to, on, funds } when it answers with funds, else { to, error }. */
async function otherBroker(acct) {
  const on = acct.trade_via !== 'stoxkart', to = on ? 'stoxkart' : acct.broker;
  const a = PREOPEN_IO.probe(acct, on ? 'stoxkart' : 'own');
  if (!a) return { to, error: on ? 'StoxKart is not linked and tested' : 'Dhan is not connected' };
  try {
    const s = await withTimeout(a.snapshot({ funds: true, orders: true }), AUTO.preopen.probeMs, brokerName(to));
    const funds = Number(s.funds?.available);
    return funds > 0 ? { to, on, funds } : { to, error: `${brokerName(to)} reports no available funds` };
  } catch (e) { return { to, error: String(e.message).slice(0, 160) }; }
}

/**
 * CHECK_AT (08:55): what the 09:15 gap trade will do for this account, or what will stop it, as a notification.
 * Checks the switches, the trading broker (synced now), its funds and the risk gate; when the broker does not answer,
 * whether the other one could take over at ROUTE_AT.
 */
export async function preopenCheck(acct) {
  const uid = acct.user_id, via = brokerName(tradingBroker(acct)), problems = [];
  if (acct.algo_on !== 1) problems.push(`Algo Trading is off for ${via}: turn it on (AI Algo Trading page), or nothing trades at 09:15.`);
  if (acct.agent_on !== 1) problems.push(`Protection is off for ${via}: Algo Trading only trades with it on.`);
  const h = await brokerHealth(acct);
  let alt = null;
  if (!h.connected) {
    problems.push(`${via} is not answering (${h.status}${h.error ? `: ${h.error}` : ''}).`);
    alt = await otherBroker(h.acct);
    problems.push(alt.error ? `${brokerName(alt.to)} cannot take over either: ${alt.error}. Reconnect ${via} before ${AUTO.preopen.routeAt.slice(0, 5)}.`
      : `${brokerName(alt.to)} answers (₹${round2(alt.funds)} available): if ${via} has not recovered by ${AUTO.preopen.routeAt.slice(0, 5)}, Algo Trading switches to ${brokerName(alt.to)} for today.`);
  } else if (!(h.funds > 0)) problems.push(`${via} reports no available funds.`);
  else {
    const risk = scalperSignalRisk(uid);
    if (risk.reason) problems.push(risk.reason);
  }
  if (problems.length) notify(uid, { kind: 'risk', level: alt && !alt.error && problems.length === 2 ? 'warn' : 'critical', title: 'Before 09:15: Gap 09:15 is not ready', body: problems.join('\n') });
  else {
    const risk = scalperSignalRisk(uid), today = dayState(uid), budget = riskLeft(risk.budget?.daily, today.realized + today.unrealized);
    const steps = GAP_LIVE.strike || 0, pick = steps ? `${steps > 0 ? 'ITM' : 'OTM'}${Math.abs(steps)}` : 'ATM';
    notify(uid, { kind: 'risk', level: 'ok', title: `Ready for 09:15 via ${via}`,
      body: !isAdminUser(uid) ? `Gap 09:15 is on, with ₹${round2(h.funds)} available and ₹${budget} of today's stop-loss. Keep ${via} as the trading broker until then.`
        : `Gap 09:15 is on: ${pick} of the nearest expiry on the first tick, ${Math.round(AUTO.gap.fundsUse * 100)}% of the ₹${round2(h.funds)} available, stop-loss from the ₹${budget} of today's stop-loss, exit at ${AUTO.gap.exitAt}. Keep ${via} as the trading broker until then.` });
  }
  audit(uid, 'algo.preopen_check', { via, ok: !problems.length, problems });
  return { ok: !problems.length, problems, alt };
}

/**
 * ROUTE_AT (09:13): the trading broker must answer before the open. If it does not (after one retry), nothing is open
 * and the other broker answers with funds, Algo Trading switches to it (with the switches in use now) and says so.
 */
export async function preopenRoute(acct, { pause = sleep } = {}) {
  if (acct.algo_on !== 1 || acct.agent_on !== 1 || acct.gap_on !== 1) return { skipped: 'gap off' };
  if (acct.paper_mode === 1) return { skipped: 'paper: no broker to fall back to' };
  const uid = acct.user_id;
  let h = await brokerHealth(acct);
  if (!h.connected) { await pause(AUTO.preopen.retryMs); h = await brokerHealth(h.acct); }
  if (h.connected) return { ok: true };
  const cur = h.acct, via = brokerName(tradingBroker(cur)), why = `${h.status}${h.error ? `: ${h.error}` : ''}`;
  const alt = await otherBroker(cur), busy = brokerBusy(cur);
  if (alt.error || busy.length) {
    notify(uid, { kind: 'risk', level: 'critical', title: `Gap 09:15 may not trade today: ${via} is not answering`,
      body: `${via}: ${why}. ${busy.length ? `Not switched to ${brokerName(alt.to)}: ${busy.join(', ')} open.` : `${brokerName(alt.to)} cannot take over: ${alt.error}.`} Reconnect ${via} now.` });
    audit(uid, 'algo.preopen_route', { via, ok: false, why, alt: alt.error || null, busy });
    return { failed: why };
  }
  const fresh = await PREOPEN_IO.switchVia(cur, alt.on, { carryFlags: true, reason: `pre-open: ${via} not answering` });
  notify(uid, { kind: 'risk', level: 'critical', title: `Algo Trading switched to ${brokerName(alt.to)} for 09:15`,
    body: `${via} did not answer before the open (${why}). ${brokerName(alt.to)} did, with ₹${round2(alt.funds)} available, so orders now go through ${brokerName(alt.to)}, with the same Algo Trading switches. Switch back on the Brokers page when ${via} works again (with nothing open).` });
  audit(uid, 'algo.preopen_route', { via, ok: true, switchedTo: alt.to, why, status: fresh?.status });
  return { switched: alt.to, status: fresh?.status };
}

let preopenDay = null;
/** Arms the day's pre-open check (CHECK_AT) and route (ROUTE_AT) timers; a restart after ROUTE_AT arms nothing. */
function schedulePreopen(now = Date.now()) {
  const day = ist(now).day, P = AUTO.preopen, at = hms => Date.parse(`${day}T${hms}+05:30`);
  if (preopenDay === day || !isTradingDay(now) || now >= at(P.routeAt)) return;
  preopenDay = day;
  const each = fn => {
    let rows;
    try { rows = stmt(`SELECT * FROM broker_accounts WHERE broker IN ('dhan', 'paper') AND gap_on = 1 AND status != 'disconnected'`).all(); }
    catch (e) { console.error('[autotrade] pre-open', e.message); return; }
    for (const a of rows) fn(a).catch(e => console.error('[autotrade] pre-open', a.user_id, e.message));
  };
  if (now < at(P.checkAt) + 10 * 60_000) setTimeout(() => each(preopenCheck), Math.max(0, at(P.checkAt) - now));
  setTimeout(() => each(a => preopenRoute(a)), at(P.routeAt) - now);
}

/** Start the scanner. Accounts: Dhan, connected, protection on, Algo Trading on. */
let feedUsers = new Set();
/** Subscribe each Algo Trading account's feed (index, near-ATM contracts for the gap, open trades) during the session. */
function syncFeeds(accounts, active, now = Date.now()) {
  const t = ist(now), on = isTradingDay(now) && t.minutes >= FEED_FROM && t.minutes <= FEED_TO, want = new Set();
  if (on) for (const acct of accounts) {
    const keys = new Set(algoIndices(acct).map(k => `IDX_I:${underlyingFor(k).securityId}`));
    // The near-ATM contracts with market depth (Full mode): the gap entry prices from their best offer.
    const depth = gapFeedKeys.get(`${acct.user_id}:${t.day}`) || new Set();
    for (const k of depth) keys.add(k);
    for (const tr of active) if (tr.user_id === acct.user_id && tr.security_id) keys.add(`${tr.exchange_segment || 'NSE_FNO'}:${tr.security_id}`);
    try { FEED.watch(acct.user_id, keys, depth); want.add(acct.user_id); } catch (e) { console.error('[autotrade] feed', e.message); }
  }
  for (const uid of feedUsers) if (!want.has(uid)) { try { FEED.unwatch(uid); } catch { /* closed anyway */ } }
  feedUsers = want;
}

export function startAutoTrader({ tickMs = AUTO.tickMs } = {}) {
  const busy = new Set();
  const manage = trade => {
    const k = `t:${trade.id}`;
    if (busy.has(k)) return;
    busy.add(k);
    manageTrade(trade).catch(e => console.error('[autotrade] manage', e.message)).finally(() => busy.delete(k));
  };
  manageNow = manage;
  const scan = acct => {
    if (scanning.has(acct.user_id)) return;
    scanning.add(acct.user_id);
    // Each ticked index in turn (one Dhan request queue per user); the first signal that passes the risk gate trades.
    (async () => { for (const key of algoIndices(acct)) await scanForEntry(acct, { underlying: key }).catch(e => console.error('[autotrade] scan', key, e.message)); })()
      .finally(() => scanning.delete(acct.user_id));
  };
  // A 1-minute index candle closed on the live feed: check the user's open trades and scan for entries now, not on the
  // next tick (EMA 5/9 trades on every 1-minute close; ORB on 5-minute closes).
  const offMinute = onMinuteClose((userId, key, minute) => {
    if (!key.startsWith('IDX_I:')) return;
    try {
      for (const trade of stmt(`SELECT * FROM auto_trades WHERE user_id = ? AND status IN ('open', 'closing')`).all(userId)) manage(trade);
      if (marketOpen())
        for (const acct of stmt(`SELECT * FROM broker_accounts WHERE user_id = ? AND algo_on = 1 AND agent_on = 1 AND ${TRADES} AND status = 'connected'`).all(userId)) scan(acct);
    } catch (e) { console.error('[autotrade] minute close', e.message); }
  });
  const timer = setInterval(() => {
    let accounts, active;
    try {
      accounts = stmt(`SELECT * FROM broker_accounts WHERE algo_on = 1 AND agent_on = 1 AND ${TRADES} AND status = 'connected'`).all();
      active = stmt(`SELECT * FROM auto_trades WHERE status IN ('placing', 'open', 'closing')`).all();
    } catch (e) { console.error('[autotrade]', e.message); return; }
    for (const trade of active) manage(trade);
    syncFeeds(accounts, active);
    schedulePreopen();
    scheduleGap();
    if (!marketOpen()) return;
    for (const acct of accounts) {
      const g = `g:${acct.user_id}`;
      if (!busy.has(g)) { busy.add(g); closeManualEntries(acct).catch(e => console.error('[autotrade] manual guard', e.message)).finally(() => busy.delete(g)); }
      scan(acct);
      // CE + PE at a target price: its own entry window (09:20 …), checked on every tick.
      // One pass per index it is switched on for (Algo Trading grid), each with its own settings.
      if (acct.strangle_on === 1) for (const U of strategyIndices(acct, 'strangle')) {
        const sKey = `s:${acct.user_id}:${U}`;
        if (!busy.has(sKey)) { busy.add(sKey); strangleTick(acct, { underlying: U }).catch(e => console.error('[autotrade] strangle', U, e.message)).finally(() => busy.delete(sKey)); }
      }
    }
  }, tickMs);
  return () => { clearInterval(timer); offMinute(); for (const uid of feedUsers) FEED.unwatch(uid); feedUsers = new Set(); };
}
