import { DEFAULT_RULES, getRules } from '../rules/service.js';
import { capitalFor, dayState } from '../risk/service.js';
import { getBook, getKillStatus } from '../broker/book.js';
import { getAlgoConfig, askOpenAI } from '../algo/service.js';
import { getStrategy } from '../strategy/service.js';
import { audit } from '../audit/service.js';
import { ist, marketOpen, toMinutes } from '../../lib/time.js';
import { signalBudget, sizeSwingTrade, swingStopFor, openingRangeBreakout, openingRangeBreakout1m } from './signal-risk.js';
import { niftyInstruments } from './instruments.js';
import { config } from '../../config.js';

export function scalperSignalRisk(userId) {
  const rules = getRules(userId).active, day = dayState(userId), book = getBook(userId);
  const budget = signalBudget(rules, capitalFor(userId, day), Number(day.realized) + Number(day.unrealized));
  let reason = '';
  if (!budget) reason = 'A daily stop-loss and starting capital are needed to size a trade.';
  else if (day.paused || day.ks_armed || getKillStatus(userId)?.active) reason = 'Broker trading is locked by your risk rules.';
  else if (rules.maxTrades.on && day.entries >= rules.maxTrades.value) reason = 'Daily trade limit reached.';
  else if (rules.cutoff.on && ist().minutes >= toMinutes(rules.cutoff.value)) reason = 'New-entry cutoff reached.';
  else if (budget.available <= 0) reason = 'Daily loss budget exhausted.';
  else if (!book.at || Date.now() - book.at > 60_000) reason = 'Waiting for a fresh broker sync.';
  else if (book.positions.some(p => p.qty !== 0) || book.orders.length) reason = 'Open broker positions or pending orders block a new entry.';
  else if (!(book.funds?.available > 0)) reason = 'Available broker funds are unknown or insufficient.';
  const scanReason = !config.openai.apiKey ? 'Configure the server OpenAI API key to generate AI signals.'
    : !marketOpen() ? 'Market closed. Scan during market hours.' : '';
  // Power Scalper sizes lots with this stop distance (Risk rules › Option SL room); null = sizing off.
  const optionSl = rules.optionSl ?? DEFAULT_RULES.optionSl, optionSlPct = optionSl.on ? optionSl.value : null;
  return { budget, optionSlPct, reason, scanReason, scanAllowed:!scanReason, timeframe: '1m', swing: 'Two completed 1-minute candles on each side; stop one tick below the pre-breakout option swing low.' };
}

export async function scanScalperSignal(userId, ip, { adapter, optionRequest, normalizeCandles }) {
  const startedAt = Date.now(), initial = scalperSignalRisk(userId);
  const noTrade = (reason, setup = null) => ({ action: 'NO_TRADE', rationale: reason, setup, risk: scalperSignalRisk(userId), asOf: Date.now(), brokerOrderPlaced: false });
  if (initial.scanReason) return noTrade(initial.scanReason);
  const profile = getAlgoConfig(userId), metadata = await niftyInstruments();
  const expiryList = await optionRequest(() => adapter.optionExpiries({ underlyingScrip: 13, underlyingSeg: 'IDX_I' }));
  // “Next two expiries” means the next two future contracts; do not let the
  // current-day expiry occupy the first slot and exclude the nearer future week.
  const expiries = [...new Set(expiryList)].filter(e => /^\d{4}-\d{2}-\d{2}$/.test(e) && e > ist().day).sort().slice(0,2);
  const now = Date.now(), fromDate = `${ist(now).day} 09:00:00`;   // Dhan's fromDate is exclusive: 09:15:00 would drop the 09:15 candle
  const candlesFor = async (securityId, index = false, interval = '1') => normalizeCandles(await adapter.intradayCandles({ securityId,
    exchangeSegment: index ? 'IDX_I' : 'NSE_FNO', instrument: index ? 'INDEX' : 'OPTIDX', interval, fromDate,
    toDate:new Date(Date.now() + 330*60_000).toISOString().slice(0,19).replace('T',' ') }));
  const [spotCandles, rangeCandles] = await Promise.all([candlesFor('13', true), candlesFor('13', true, '5')]);
  const range = openingRangeBreakout(rangeCandles, now);
  const setup=openingRangeBreakout1m(spotCandles, now, range);
  if (!setup.ready || !setup.direction) return noTrade(setup.reason,setup);
  const candidates = [];
  for (const expiry of expiries) {
    const chain = await optionRequest(() => adapter.optionChain({ underlyingScrip:13, underlyingSeg:'IDX_I', expiry }));
    const spot = Number(chain?.last_price);
    if (!(spot > 0)) continue;
    const nearby = Object.entries(chain.oc || {}).filter(([strike]) => Math.abs(Number(strike)-spot)/spot <= .02)
      .sort(([a],[b]) => Math.abs(Number(a)-spot)-Math.abs(Number(b)-spot)).slice(0,3);
    for (const [strikeText, sides] of nearby) for (const option of [setup.direction==='BUY_CE'?'CE':'PE']) {
      const raw = sides[option.toLowerCase()], securityId = String(raw?.security_id || ''), meta = metadata.get(securityId);
      const bid = Number(raw?.top_bid_price), ask = Number(raw?.top_ask_price), strike = Number(strikeText);
      if (!meta || meta.expiry !== expiry || meta.strike !== strike || meta.option !== option) continue;
      if (!(bid > 0 && ask >= bid && ask <= profile.maxPremium && Number(raw.volume) > 0)) continue;
      const spreadPct = (ask-bid)/((ask+bid)/2)*100;
      if (spreadPct > profile.maxSpreadPct) continue;
      const candles = await candlesFor(securityId);
      // Entry minute = the index candle that confirmed the breakout (broke the breakout candle's high/low).
      const nextMinute = setup.stale && (candles.find(c => c.time === setup.confirmedAt) || candles.find(c => c.time >= setup.confirmedAt && c.time < setup.confirmedAt + 120_000));
      const breakoutMinute = setup.stale && candles.find(c => c.time === setup.breakoutAt);
      // For a historical first-trade review, use the option's 1m open in the confirming minute
      // (or the breakout minute's close if that bar is missing).
      // Never substitute the live quote as the historical entry price.
      const entry = setup.stale ? Number(nextMinute?.open ?? breakoutMinute?.close) : ask;
      const entryTime = setup.stale ? (nextMinute?.time ?? breakoutMinute?.time + 60_000) : null;
      if (!(entry > 0)) continue;
      const historicalClock = setup.stale ? setup.breakoutAt + 60_000 : Date.now();
      const swing = swingStopFor(candles, {entry,...meta,now:historicalClock,beforeTime:setup.breakoutAt,intervalMs:60_000});
      if (!swing) continue;
      const sizingBudget = setup.stale ? (initial.budget?.available || initial.budget?.perTrade) : initial.budget?.available;
      const sizing = sizingBudget > 0 ? sizeSwingTrade(candles, { entry, ...meta, budget:sizingBudget, funds:getBook(userId).funds?.available, now:historicalClock, beforeTime:setup.breakoutAt, intervalMs:60_000 }) : null;
      candidates.push({ securityId, action:`BUY_${option}`, option, expiry, strike, entry, entryTime, entrySource:setup.stale ? 'historical_option_candle' : 'live_ask', breakoutAt:setup.breakoutAt, ...meta, ...swing,
        ...(sizing || {lots:0,quantity:0,risk:0,capitalRequired:0}), entryAllowed:!!sizing&&!initial.reason&&!setup.stale, bid, ask, spreadPct,
        oneLotCapital:entry*meta.lotSize, volume:Number(raw.volume), oi:Number(raw.oi), candles:candles.filter(c => c.time+60_000 <= setup.breakoutAt).slice(-40) });
    }
  }
  if (!candidates.length) return noTrade(setup.stale
    ? 'No contract had both a historical option price after the first breakout and a confirmed pre-breakout swing in the next two expiries.'
    : 'A fresh 1-minute opening-range breakout was found, but no liquid CE/PE in the next two expiries has a confirmed pre-breakout 1-minute swing low.',setup);
  let decision;
  try {
    decision = await askOpenAI({ underlying:'NIFTY', swingRisk:true, openingRange:setup, expiries, risk:initial.budget,
    instructions:`Analyze today's NIFTY data from the open. The opening range is the high and low of the first five 1-minute candles. Today's latest confirmed breakout (trade ${setup.tradeNumber || 1} of the day): a 1-minute candle closed ${setup.direction==='BUY_CE'?'above the range high':'below the range low'} at ${new Date(setup.breakoutAt).toISOString()}, and the next candle (${new Date(setup.confirmedAt).toISOString()}) broke that candle's ${setup.direction==='BUY_CE'?'high and closed green':'low and closed red'} with a body of at least 30% of its range, which triggers the entry at that candle's close. Compare candidates across exactly these next two upcoming expiries, excluding today's expiry: ${expiries.join(', ')}. Select the single best ${setup.direction} contract from the supplied candidates, or NO_TRADE only if none has a valid pre-breakout swing. Each stop is one tick below that contract's confirmed pre-breakout 1-minute swing low; the swing and its two confirming candles must finish before the breakout candle. Respect the supplied maximum risk budget. Among valid candidates, prefer the one whose precomputed position risk uses the greatest amount of the available per-trade risk budget without exceeding it; then prefer tighter spread, stronger liquidity, and greater premium capital deployed. Never increase quantity beyond the supplied sizing. The configured per-trade cap is ${initial.budget ? `${initial.budget.percent.toFixed(2)}% of capital (₹${initial.budget.perTrade}); currently available risk is ₹${initial.budget.available} (${(initial.budget.available/initial.budget.capital*100).toFixed(2)}%)` : 'unavailable'}, derived from the daily loss cap divided by trades per day. ${setup.stale?'This is a historical setup only. Candidate entry is its option-candle price immediately after the index breakout; current bid/ask are only for liquidity and spread. If current risk is exhausted, still select the best candidate for review, but do not describe it as actionable.':'Prefer a candidate with at least one lot within the currently available risk cap.'} Report its exact supplied expiry, strike, entry price, stop, quantity, risk and premium capital required. Never invent or alter levels, quantity, or capital. The scan is informational only.`,
      candles:spotCandles.filter(c => c.time+60_000 <= setup.breakoutAt), candidates }, getStrategy(userId), profile);
  } catch (error) {
    if (!setup.stale) return noTrade(`AI analysis failed: ${error.message}`,setup);
    // A historical first-trade review should remain useful if the model refuses,
    // times out, or returns no structured answer. The candidates are already
    // bounded to live quotes, valid contracts, and confirmed pre-breakout stops.
    decision = { action:'NO_TRADE', confidence:0, fallback:true,
      rationale:`AI returned no usable structured decision (${error.message}). Showing the best validated historical candidate for review.` };
  }
  let selected = candidates.find(c => c.action === decision.action && c.strike === decision.strike && c.expiry === decision.expiry);
  if (!selected && setup.stale) {
    // Preserve the requested first-trade review even when the model elects NO_TRADE;
    // this deterministic fallback remains explicitly blocked as a historical signal.
    selected = [...candidates].sort((a,b) =>
      (b.risk - a.risk) || (b.premium - a.premium) || (a.spreadPct - b.spreadPct) || (b.volume - a.volume) || (a.expiry.localeCompare(b.expiry)))[0];
  }
  if (decision.action === 'NO_TRADE' && !setup.stale) return noTrade(decision.rationale,setup);
  if (!selected || (!setup.stale && (decision.confidence < profile.minConfidence || decision.confidence > 1))) return noTrade('AI did not select a valid opening-range breakout contract with sufficient confidence.',setup);
  // A scan can take time: re-read rules, funds, locks and the selected quote before returning.
  const current = scalperSignalRisk(userId);
  if (current.scanReason) return noTrade(current.scanReason);
  if (Date.now()-startedAt > 120_000) return noTrade('Scan took too long; request a fresh signal.',setup);
  const latest = await optionRequest(() => adapter.optionChain({ underlyingScrip:13, underlyingSeg:'IDX_I', expiry:selected.expiry }));
  const quote = latest?.oc?.[String(selected.strike)]?.[selected.option.toLowerCase()]
    || Object.entries(latest?.oc || {}).find(([s]) => Number(s) === selected.strike)?.[1]?.[selected.option.toLowerCase()];
  const ask = Number(quote?.top_ask_price), bid = Number(quote?.top_bid_price);
  if (String(quote?.security_id) !== selected.securityId || !(bid > 0 && ask >= bid) || ask > profile.maxPremium
    || (ask-bid)/((ask+bid)/2)*100 > profile.maxSpreadPct
    || (!setup.stale && Math.abs(ask-selected.entry) > selected.tickSize * 2)) return noTrade('Selected price moved during analysis. Scan again for a fresh entry.',setup);
  const candles = await candlesFor(selected.securityId);
  const finalRisk = scalperSignalRisk(userId);
  if (finalRisk.reason && !setup.stale) return noTrade(finalRisk.reason,setup);
  const historicalClock = setup.stale ? setup.breakoutAt + 60_000 : Date.now();
  const entry = setup.stale ? selected.entry : ask;
  const swing = swingStopFor(candles, { ...selected, entry, now:historicalClock, beforeTime:setup.breakoutAt, intervalMs:60_000 });
  if (!swing || swing.swingAt !== selected.swingAt) return noTrade('Option swing changed during analysis. Scan again.',setup);
  const finalSizingBudget = setup.stale ? (finalRisk.budget?.available || finalRisk.budget?.perTrade) : finalRisk.budget?.available;
  const sizing = finalSizingBudget > 0 ? sizeSwingTrade(candles, { ...selected, entry, budget:finalSizingBudget, funds:getBook(userId).funds?.available, now:historicalClock, beforeTime:setup.breakoutAt, intervalMs:60_000 }) : null;
  const { candles: _candles, ...contract } = selected;
  const blockReason = setup.stale ? 'Historical first-trade analysis only; breakout entry is stale.'
    : finalRisk.reason || (!sizing ? 'One-lot risk or required funds exceed what is available.' : '');
  const result = { action:selected.action, contract:{ ...contract, ...swing, ...(sizing || {lots:0,quantity:0,risk:0}), entry, entryTime:setup.stale ? selected.entryTime : null,
    ask:setup.stale ? entry : ask, currentAsk:setup.stale ? ask : null, bid, capitalRequired:sizing?.premium || contract.premium || contract.oneLotCapital,
    entryAllowed:!blockReason, blockReason }, confidence:decision.confidence, setup,
    rationale:setup.stale ? `Historical first-trade review only. Entry price comes from the option's 1-minute candle after the index breakout; no late entry. ${decision.fallback ? decision.rationale : decision.action === 'NO_TRADE' ? 'AI declined a live entry; best available contract is shown for review.' : decision.rationale || 'Best eligible contract selected by risk, spread, and liquidity.'}` : decision.rationale,
    risk:finalRisk, asOf:Date.now(), expiresAt:Date.now()+60_000,
    expiriesScanned:expiries, brokerOrderPlaced:false };
  audit(userId, 'scalper.ai_signal', result, ip);
  return result;
}
