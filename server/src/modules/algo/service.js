import { stmt } from '../../db/index.js';
import { bad, conflict, forbidden, HttpError } from '../../lib/errors.js';
import { v } from '../../lib/validate.js';
import { config } from '../../config.js';
import { ist, marketOpen, toMinutes } from '../../lib/time.js';
import { accountFor, adapterFor } from '../broker/registry.js';
import { getPermissions, getKillStatus, getBook } from '../broker/book.js';
import { dayState } from '../risk/service.js';
import { getRules } from '../rules/service.js';
import { getStrategy } from '../strategy/service.js';
import { audit } from '../audit/service.js';

export const DEFAULT_ALGO = Object.freeze({
  paperEnabled: false,
  autoTrading: false,
  autoQuantity: 1,
  underlying: 'NIFTY',
  maxPremium: 250,
  maxSpreadPct: 4,
  minConfidence: 0.75,
  stopLossPct: 20,
  takeProfitPct: 30,
  maxDailyLoss: 1500,
});

let optionRequestAt = 0;
let optionRequestQueue = Promise.resolve();
const optionRequest = fn => {
  const run = optionRequestQueue.then(async () => {
    const wait = Math.max(0, 3100 - (Date.now() - optionRequestAt));
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    optionRequestAt = Date.now();
    return fn();
  });
  optionRequestQueue = run.catch(() => {});
  return run;
};

export function getAlgoConfig(userId) {
  const row = stmt('SELECT config FROM algo_profiles WHERE user_id = ?').get(userId);
  const profile = row ? { ...structuredClone(DEFAULT_ALGO), ...JSON.parse(row.config) } : structuredClone(DEFAULT_ALGO);
  // Drop the retired proposal/entry cap from profiles saved by older app versions.
  delete profile.maxTradesPerDay;
  return profile;
}

function validateConfig(input = {}) {
  return {
    paperEnabled: v.bool(input.paperEnabled, 'Paper mode'),
    autoTrading: v.bool(input.autoTrading ?? false, 'Automatic paper trading'),
    autoQuantity: v.num(input.autoQuantity ?? 1, 'Automatic paper quantity', { min: 1, max: 100_000, int: true }),
    // NIFTY is the only enabled underlying in this initial release; the Dhan security ID is fixed server-side.
    underlying: v.oneOf(input.underlying ?? 'NIFTY', 'Underlying', ['NIFTY']),
    maxPremium: v.num(input.maxPremium, 'Maximum option premium', { min: 10, max: 100_000 }),
    maxSpreadPct: v.num(input.maxSpreadPct, 'Maximum bid-ask spread', { min: 0.1, max: 25 }),
    minConfidence: v.num(input.minConfidence, 'Minimum AI confidence', { min: 0.5, max: 0.99 }),
    stopLossPct: v.num(input.stopLossPct, 'Paper stop loss', { min: 1, max: 90 }),
    takeProfitPct: v.num(input.takeProfitPct, 'Paper target', { min: 1, max: 500 }),
    maxDailyLoss: v.num(input.maxDailyLoss, 'Paper daily loss limit', { min: 100, max: 10_000_000 }),
  };
}

export function saveAlgoConfig(userId, input, ip) {
  const next = validateConfig(input);
  const now = Date.now();
  stmt(`INSERT INTO algo_profiles (user_id, config, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`)
    .run(userId, JSON.stringify(next), now);
  audit(userId, 'algo.config_updated', { paperEnabled: next.paperEnabled, underlying: next.underlying }, ip);
  return { ...next, updatedAt: now };
}

function latestEvents(userId, limit = 20) {
  return stmt(`SELECT id, kind, action, detail, created_at AS createdAt
    FROM algo_events WHERE user_id = ? ORDER BY id DESC LIMIT ?`).all(userId, limit)
    .map(row => ({ ...row, detail: JSON.parse(row.detail) }));
}

function paperBook(userId, day = ist().day) {
  const start = Date.parse(`${day}T00:00:00+05:30`);
  const totals = stmt(`SELECT
      COALESCE(SUM(CASE WHEN status = 'closed' AND closed_at >= ? THEN realized_pnl ELSE 0 END), 0) AS realizedToday,
      COALESCE(SUM(CASE WHEN status = 'open' THEN (mark_price - entry_price) * quantity ELSE 0 END), 0) AS unrealized,
      COALESCE(SUM(CASE WHEN status = 'closed' THEN realized_pnl ELSE 0 END), 0) AS realizedTotal,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS openCount
    FROM algo_paper_trades WHERE user_id = ?`).get(start, userId);
  const openTrades = stmt(`SELECT id, proposal_id AS proposalId, action, strike, option_type AS option,
      expiry, quantity, entry_price AS entryPrice, mark_price AS markPrice, auto_managed AS autoManaged,
      (mark_price - entry_price) * quantity AS unrealizedPnl, marked_at AS markedAt, opened_at AS openedAt
    FROM algo_paper_trades WHERE user_id = ? AND status = 'open' ORDER BY opened_at DESC`).all(userId);
  const closedTrades = stmt(`SELECT id, action, strike, option_type AS option, expiry, quantity,
      entry_price AS entryPrice, exit_price AS exitPrice, realized_pnl AS realizedPnl, opened_at AS openedAt, closed_at AS closedAt
    FROM algo_paper_trades WHERE user_id = ? AND status = 'closed' ORDER BY closed_at DESC LIMIT 20`).all(userId);
  const recordedProposalIds = stmt('SELECT proposal_id FROM algo_paper_trades WHERE user_id = ?').all(userId).map(row => row.proposal_id);
  const round = n => Math.round((Number(n) || 0) * 100) / 100;
  const realizedToday = round(totals.realizedToday), unrealized = round(totals.unrealized);
  return {
    todayPnl: round(realizedToday + unrealized), realizedToday, unrealized,
    totalPnl: round(Number(totals.realizedTotal) + unrealized),
    openCount: Number(totals.openCount) || 0, openTrades, closedTrades, recordedProposalIds,
  };
}

function paperTradeById(userId, id) {
  return stmt(`SELECT id, proposal_id AS proposalId, action, strike, option_type AS option,
      expiry, quantity, entry_price AS entryPrice, mark_price AS markPrice, auto_managed AS autoManaged,
      (mark_price - entry_price) * quantity AS unrealizedPnl, marked_at AS markedAt,
      opened_at AS openedAt, status
    FROM algo_paper_trades WHERE user_id = ? AND id = ?`).get(userId, id);
}

function refreshPaperMarks(userId, chain) {
  const mark = stmt(`UPDATE algo_paper_trades SET mark_price = ?, marked_at = ?
    WHERE user_id = ? AND security_id = ? AND status = 'open'`);
  const now = Date.now();
  for (const sides of Object.values(chain?.oc || {})) {
    for (const item of [sides?.ce, sides?.pe]) {
      if (!item?.security_id) continue;
      const bid = Number(item.top_bid_price), ltp = Number(item.last_price);
      const price = bid > 0 ? bid : ltp;
      if (Number.isFinite(price) && price > 0) mark.run(price, now, userId, String(item.security_id));
    }
  }
}

export function openPaperTrade(userId, input = {}, ip) {
  if (!getAlgoConfig(userId).paperEnabled) throw conflict('PAPER_MODE_OFF', 'Enable paper mode before recording a paper trade.');
  const proposalId = v.num(input.proposalId, 'Proposal', { min: 1, max: Number.MAX_SAFE_INTEGER, int: true });
  const quantity = v.num(input.quantity, 'Paper quantity', { min: 1, max: 100_000, int: true });
  const event = stmt(`SELECT action, detail FROM algo_events WHERE id = ? AND user_id = ? AND kind = 'proposal'`).get(proposalId, userId);
  if (!event || !['BUY_CE', 'BUY_PE'].includes(event.action)) throw bad('PAPER_PROPOSAL_INVALID', 'Only a saved BUY CE or BUY PE proposal can be recorded as a paper trade.');
  const proposal = JSON.parse(event.detail);
  const contract = proposal.contract;
  if (!contract || !contract.securityId || !Number.isFinite(Number(contract.ask)) || Number(contract.ask) <= 0
    || !Number.isFinite(Number(contract.strike)) || !/^\d{4}-\d{2}-\d{2}$/.test(proposal.expiry || '')) {
    throw bad('PAPER_PROPOSAL_INVALID', 'The saved proposal is missing valid contract details.');
  }
  const existing = stmt('SELECT id FROM algo_paper_trades WHERE user_id = ? AND proposal_id = ?').get(userId, proposalId);
  if (existing) throw conflict('PAPER_TRADE_EXISTS', 'This proposal has already been recorded as a paper trade.');
  const profile = getAlgoConfig(userId);
  const current = paperBook(userId);
  if (current.todayPnl <= -profile.maxDailyLoss) throw forbidden('PAPER_DAILY_LIMIT', 'Paper P&L has reached the AI paper daily-loss limit.');
  const now = Date.now(), entry = Number(contract.ask), mark = Number(contract.bid) > 0 ? Number(contract.bid) : Number(contract.ltp) || entry;
  const option = event.action === 'BUY_CE' ? 'CE' : 'PE';
  const result = stmt(`INSERT INTO algo_paper_trades
      (user_id, proposal_id, security_id, action, strike, option_type, expiry, quantity, entry_price, mark_price, opened_at, marked_at, auto_managed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(userId, proposalId, String(contract.securityId), event.action, Number(contract.strike), option,
      proposal.expiry, quantity, entry, mark, now, now, input.autoManaged ? 1 : 0);
  const trade = paperTradeById(userId, Number(result.lastInsertRowid));
  audit(userId, 'algo.paper_trade_opened', { id: trade.id, action: trade.action, quantity, entryPrice: entry }, ip);
  return trade;
}

export function closePaperTrade(userId, input = {}, ip) {
  const id = v.num(input.id, 'Paper trade', { min: 1, max: Number.MAX_SAFE_INTEGER, int: true });
  const exitPrice = v.num(input.exitPrice, 'Exit price', { min: 0.01, max: 10_000_000 });
  const trade = paperTradeById(userId, id);
  if (!trade) throw bad('PAPER_TRADE_NOT_FOUND', 'Paper trade not found.');
  if (trade.status !== 'open') throw conflict('PAPER_TRADE_CLOSED', 'This paper trade is already closed.');
  const realized = Math.round((exitPrice - trade.entryPrice) * trade.quantity * 100) / 100;
  const now = Date.now();
  stmt(`UPDATE algo_paper_trades SET status = 'closed', exit_price = ?, mark_price = ?, realized_pnl = ?, closed_at = ?
    WHERE id = ? AND user_id = ? AND status = 'open'`).run(exitPrice, exitPrice, realized, now, id, userId);
  audit(userId, 'algo.paper_trade_closed', { id, quantity: trade.quantity, exitPrice, realizedPnl: realized }, ip);
  return { ...trade, status: 'closed', exitPrice, realizedPnl: realized, closedAt: now };
}

export async function refreshPaperTrades(userId, ip) {
  const trades = stmt(`SELECT DISTINCT expiry FROM algo_paper_trades WHERE user_id = ? AND status = 'open'`).all(userId);
  if (!trades.length) return paperBook(userId);
  if (!marketOpen()) throw conflict('MARKET_CLOSED', 'Paper option marks can refresh during market hours only.');
  const acct = accountFor(userId);
  if (!acct || acct.status !== 'connected' || acct.broker !== 'dhan' || !acct.token_enc) throw conflict('DHAN_REQUIRED', 'Connect Dhan to refresh paper option prices.');
  const adapter = adapterFor(acct);
  if (!adapter.optionChain) throw conflict('OPTIONS_UNAVAILABLE', 'This broker does not provide the required options data.');
  for (const { expiry } of trades) {
    let chain;
    try { chain = await optionRequest(() => adapter.optionChain({ underlyingScrip: 13, underlyingSeg: 'IDX_I', expiry })); }
    catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(502, 'BROKER_DATA_UNAVAILABLE', 'Could not refresh paper option prices from Dhan. Reconnect the broker and try again.'); }
    refreshPaperMarks(userId, chain);
  }
  audit(userId, 'algo.paper_marks_refreshed', { openTrades: trades.length }, ip);
  return paperBook(userId);
}

export function algoStatus(userId) {
  const acct = accountFor(userId);
  const day = ist().day;
  const start = Date.parse(`${day}T00:00:00+05:30`);
  const proposalsToday = stmt(`SELECT COUNT(*) AS n FROM algo_events WHERE user_id = ? AND kind = 'proposal' AND created_at >= ?`).get(userId, start).n;
  const state = dayState(userId, day);
  const book = getBook(userId);
  const rules = getRules(userId).active;
  const strategy = getStrategy(userId);
  const permission = getPermissions(userId);
  const kill = getKillStatus(userId);
  const scan = stmt('SELECT last_candle_at AS lastCandleAt, last_scan_at AS lastScanAt, last_error AS lastError FROM algo_scan_state WHERE user_id = ?').get(userId) || {};
  const connected = !!acct && acct.status === 'connected';
  const supported = connected && acct.broker === 'dhan';
  const riskWarnings = [];
  if (kill?.active === true) riskWarnings.push('Dhan reports its kill switch is active; broker order placement remains locked.');
  if (state.ks_active_at) riskWarnings.push('TradeLock triggered its kill switch today.');
  else if (state.ks_armed) riskWarnings.push(`TradeLock kill switch is armed${state.ks_armed === 'broker' ? ' by the broker' : `: ${state.ks_armed}`}.`);
  if (state.paused) riskWarnings.push(`TradeLock risk protection is paused${state.pause_reason ? `: ${state.pause_reason}` : ' for today'}.`);
  return {
    config: getAlgoConfig(userId),
    provider: { configured: !!config.openai.apiKey, model: config.openai.model },
    broker: { connected, supported, label: acct?.broker === 'dhan' ? 'Dhan' : acct?.broker || null,
      tokenReady: supported && !!acct.token_enc, agentOn: supported && acct.agent_on !== 0,
      ordersAllowed: permission?.ordersAllowed ?? null, killSwitchActive: kill?.active === true },
    marketOpen: marketOpen(),
    scanner: { enabled: getAlgoConfig(userId).autoTrading && getAlgoConfig(userId).paperEnabled, intervalSeconds: 60, timeframe: '5m', ...scan },
    safety: { rulesLoaded: !!rules, positions: book.positions.filter(p => p.qty !== 0).length,
      pendingOrders: book.orders.length, realPnlToday: (state.realized || 0) + (state.unrealized || 0),
      proposalsToday, hasStrategy: !!strategy?.name,
      accountClear: !book.positions.some(p => p.qty !== 0) && book.orders.length === 0,
      paper: paperBook(userId), riskPaused: !!(state.paused || state.ks_active_at || state.ks_armed), riskWarnings },
    mode: 'paper',
    liveOrdersEnabled: false,
    events: latestEvents(userId),
  };
}

function recordEvent(userId, kind, action, detail) {
  const result = stmt(`INSERT INTO algo_events (user_id, kind, action, detail, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(userId, kind, action, JSON.stringify(detail), Date.now());
  return { id: Number(result.lastInsertRowid), kind, action, detail, createdAt: Date.now() };
}

export function recordAlgoFailure(userId, err, ip) {
  const code = String(err?.code || 'ANALYSIS_FAILED').slice(0, 60);
  const message = String(err?.message || 'Analysis could not be completed.').slice(0, 240);
  recordEvent(userId, 'error', code, { message });
  audit(userId, 'algo.analysis_failed', { code }, ip);
}

function optionCandidates(chain, profile) {
  const spot = Number(chain?.last_price);
  const oc = chain?.oc;
  if (!(spot > 0) || !oc || typeof oc !== 'object') throw bad('MARKET_DATA_UNAVAILABLE', 'Dhan did not return a usable NIFTY option chain.');
  const out = [];
  for (const [strikeText, sides] of Object.entries(oc)) {
    const strike = Number(strikeText);
    if (!Number.isFinite(strike) || Math.abs(strike - spot) / spot > 0.02) continue;
    for (const [optionType, item] of [['BUY_CE', sides?.ce], ['BUY_PE', sides?.pe]]) {
      if (!item || !Number.isFinite(Number(item.security_id))) continue;
      const bid = Number(item.top_bid_price), ask = Number(item.top_ask_price), ltp = Number(item.last_price);
      if (!(bid > 0 && ask >= bid && ltp > 0 && ask <= profile.maxPremium)) continue;
      const spreadPct = ((ask - bid) / ((ask + bid) / 2)) * 100;
      if (!Number.isFinite(spreadPct) || spreadPct > profile.maxSpreadPct) continue;
      out.push({ action: optionType, strike, securityId: String(item.security_id), ltp, bid, ask,
        spreadPct: Math.round(spreadPct * 100) / 100, volume: Number(item.volume) || 0, oi: Number(item.oi) || 0,
        iv: Number(item.implied_volatility) || null, delta: Number(item.greeks?.delta) || null,
        theta: Number(item.greeks?.theta) || null });
    }
  }
  return { spot, candidates: out.sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot)).slice(0, 24) };
}

export async function askOpenAI(snapshot, strategy, profile, openTrade = null) {
  if (!config.openai.apiKey) throw conflict('AI_NOT_CONFIGURED', 'The OpenAI API key has not been added to the TradeLock server yet.');
  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      action: { type: 'string', enum: openTrade ? ['EXIT', 'HOLD'] : snapshot.openingRange?.direction
        ? [snapshot.openingRange.direction, 'NO_TRADE'] : ['BUY_CE', 'BUY_PE', 'NO_TRADE'] },
      strike: { type: 'number' },
      confidence: { type: 'number' },
      rationale: { type: 'string' },
    }, required: ['action', 'strike', 'confidence', 'rationale'],
  };
  if (snapshot.swingRisk) {
    schema.properties.expiry = { type: 'string' };
    schema.required.push('expiry');
  }
  let response;
  try {
    response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST', signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.openai.model, store: false, max_output_tokens: 260,
        instructions: openTrade
          ? 'You manage an existing long NIFTY option paper position. Choose EXIT to sell-to-close this position or HOLD. Never open a short position. Use only the supplied candle and option data; prefer HOLD if evidence is mixed. This is paper only.'
          : 'You analyze a current, bounded NIFTY options snapshot for a paper-trading system. Choose only BUY_CE, BUY_PE, or NO_TRADE. Never recommend selling/opening a short position. Use only the supplied snapshot and strategy. Prefer NO_TRADE if the evidence is mixed, stale, or weak. Return a concise factual rationale; do not invent data or claim certainty.',
        input: JSON.stringify({ snapshot, strategy, openTrade, constraints: { maxPremium: profile.maxPremium, maxSpreadPct: profile.maxSpreadPct, minimumConfidence: profile.minConfidence } }),
        text: { format: { type: 'json_schema', name: 'options_trade_proposal', strict: true, schema } },
      }),
    });
  } catch (e) {
    throw new HttpError(502, 'AI_UNAVAILABLE', e.name === 'TimeoutError' ? 'OpenAI did not respond in time.' : 'Could not reach the OpenAI API.');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new HttpError(502, 'AI_REQUEST_FAILED', body.error?.message || `OpenAI request failed (${response.status}).`);
  }
  const payload = await response.json();
  const text = payload.output?.flatMap(item => item.content || []).find(item => item.type === 'output_text')?.text;
  if (!text) throw new HttpError(502, 'AI_EMPTY_RESPONSE', 'OpenAI returned no structured decision.');
  let decision;
  try { decision = JSON.parse(text); } catch { throw new HttpError(502, 'AI_INVALID_RESPONSE', 'OpenAI returned an invalid decision.'); }
  const allowedActions = openTrade ? ['EXIT', 'HOLD'] : snapshot.openingRange?.direction
    ? [snapshot.openingRange.direction, 'NO_TRADE'] : ['BUY_CE', 'BUY_PE', 'NO_TRADE'];
  if (!allowedActions.includes(decision.action) || !Number.isFinite(decision.confidence)
    || typeof decision.rationale !== 'string' || decision.rationale.length > 600 || !Number.isFinite(decision.strike)) {
    throw new HttpError(502, 'AI_INVALID_RESPONSE', 'OpenAI returned a decision that failed validation.');
  }
  return decision;
}

export async function analyzeOptions(userId, ip, { auto = false, candles = [] } = {}) {
  const profile = getAlgoConfig(userId);
  if (!profile.paperEnabled) throw conflict('PAPER_MODE_OFF', 'Enable paper mode before requesting an AI analysis.');
  if (!marketOpen()) throw conflict('MARKET_CLOSED', 'AI analysis is available during market hours only.');
  if (!config.openai.apiKey) throw conflict('AI_NOT_CONFIGURED', 'The OpenAI API key has not been added to the TradeLock server yet.');
  const acct = accountFor(userId);
  if (!acct || acct.status !== 'connected' || acct.broker !== 'dhan' || !acct.token_enc) throw conflict('DHAN_REQUIRED', 'Connect Dhan to read live option-chain data.');
  const book = getBook(userId);
  if (book.positions.some(p => p.qty !== 0) || book.orders.length) throw conflict('ACCOUNT_NOT_CLEAR', 'Close open broker positions and clear working orders before requesting an AI proposal.');
  // This endpoint only creates a paper proposal and never places an order. Broker
  // protection locks should remain visible, but must not block read-only analysis.
  const adapter = adapterFor(acct);
  if (!adapter.optionExpiries || !adapter.optionChain) throw conflict('OPTIONS_UNAVAILABLE', 'This broker does not provide the required options data.');
  const underlyingScrip = 13, underlyingSeg = 'IDX_I';
  let expiries;
  try { expiries = await optionRequest(() => adapter.optionExpiries({ underlyingScrip, underlyingSeg })); }
  catch (e) {
    if (e instanceof HttpError) throw e;
    // Keep the broker failure category so the user can tell an expired token
    // from permissions, throttling, or a transient Dhan outage. Never include
    // request headers or credentials in this message.
    const code = e?.code === 'TOKEN_EXPIRED' ? 'DHAN_TOKEN_EXPIRED' : 'DHAN_OPTIONS_UNAVAILABLE';
    const message = e?.code === 'TOKEN_EXPIRED'
      ? 'Your Dhan access token has expired. Reconnect Dhan from Broker accounts, then try again.'
      : `Dhan could not provide NIFTY option expiries${e?.code ? ` (${String(e.code).slice(0, 40)})` : ''}. Check Dhan API access and reconnect the broker if needed.`;
    throw new HttpError(502, code, message);
  }
  const expiry = expiries.find(date => /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= ist().day);
  if (!expiry) throw bad('EXPIRY_UNAVAILABLE', 'Dhan returned no upcoming NIFTY options expiry.');
  let chain;
  try { chain = await optionRequest(() => adapter.optionChain({ underlyingScrip, underlyingSeg, expiry })); }
  catch (e) {
    if (e instanceof HttpError) throw e;
    const code = e?.code === 'TOKEN_EXPIRED' ? 'DHAN_TOKEN_EXPIRED' : 'DHAN_OPTIONS_UNAVAILABLE';
    const message = e?.code === 'TOKEN_EXPIRED'
      ? 'Your Dhan access token has expired. Reconnect Dhan from Broker accounts, then try again.'
      : `Dhan could not provide the live NIFTY option chain${e?.code ? ` (${String(e.code).slice(0, 40)})` : ''}. Check Dhan API access and reconnect the broker if needed.`;
    throw new HttpError(502, code, message);
  }
  refreshPaperMarks(userId, chain);
  const bounded = optionCandidates(chain, profile);
  if (!bounded.candidates.length) {
    const detail = { underlying: profile.underlying, expiry, spot: bounded.spot, reason: 'No liquid contracts passed the premium and spread filters.' };
    recordEvent(userId, 'proposal', 'NO_TRADE', detail);
    audit(userId, 'algo.analysis', { action: 'NO_TRADE', reason: 'no_eligible_contracts' }, ip);
    return { action: 'NO_TRADE', confidence: 0, rationale: detail.reason, paperOnly: true, expiry, spot: bounded.spot };
  }
  const savedStrategy = getStrategy(userId);
  const strategy = auto ? { ...savedStrategy, timeframe: '5m' } : savedStrategy;
  const decision = await askOpenAI({ underlying: profile.underlying, expiry, spot: bounded.spot, candles, candidates: bounded.candidates }, strategy, profile);
  const confidence = Math.max(0, Math.min(1, decision.confidence));
  let contract = null, action = decision.action, rationale = decision.rationale;
  if (action !== 'NO_TRADE') {
    contract = bounded.candidates.find(c => c.action === action && c.strike === decision.strike) || null;
    if (confidence < profile.minConfidence) { action = 'NO_TRADE'; rationale = `Confidence was below your ${Math.round(profile.minConfidence * 100)}% minimum.`; contract = null; }
    else if (!contract) { action = 'NO_TRADE'; rationale = 'The proposed strike was not in the validated live option-chain candidates.'; contract = null; }
  }
  const result = { action, confidence, rationale, contract: contract ? {
    option: action === 'BUY_CE' ? 'CE' : 'PE', strike: contract.strike, securityId: contract.securityId,
    ltp: contract.ltp, bid: contract.bid, ask: contract.ask, spreadPct: contract.spreadPct,
    stopLossPrice: Math.round(contract.ask * (1 - profile.stopLossPct / 100) * 100) / 100,
    targetPrice: Math.round(contract.ask * (1 + profile.takeProfitPct / 100) * 100) / 100,
  } : null, expiry, spot: bounded.spot, paperOnly: true, brokerOrderPlaced: false };
  const event = recordEvent(userId, 'proposal', action, result);
  audit(userId, 'algo.analysis', { action, confidence, expiry, strike: contract?.strike || null }, ip);
  return { ...result, id: event.id };
}

const IST_FMT = n => `${String(n).padStart(2, '0')}`;
function formatIstDateTime(at) {
  const d = new Date(at + 330 * 60_000);
  return `${d.toISOString().slice(0, 10)} ${IST_FMT(d.getUTCHours())}:${IST_FMT(d.getUTCMinutes())}:${IST_FMT(d.getUTCSeconds())}`;
}

async function fiveMinuteCandles(adapter, now) {
  const day = ist(now).day;
  const response = await adapter.intradayCandles({ securityId: '13', exchangeSegment: 'IDX_I', instrument: 'INDEX', interval: '5',
    fromDate: `${day} 09:00:00`, toDate: formatIstDateTime(now) });
  const rows = (response?.timestamp || []).map((stamp, i) => ({
    time: Number(stamp) * 1000, open: Number(response.open?.[i]), high: Number(response.high?.[i]),
    low: Number(response.low?.[i]), close: Number(response.close?.[i]), volume: Number(response.volume?.[i]) || 0,
  })).filter(c => Number.isFinite(c.time) && [c.open,c.high,c.low,c.close].every(Number.isFinite));
  const completed = rows.filter(c => c.time + 5 * 60_000 <= now);
  return completed.slice(-30);
}

function writeScanState(userId, { candleAt, error = null }) {
  stmt(`INSERT INTO algo_scan_state (user_id, last_candle_at, last_scan_at, last_error, updated_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET
    last_candle_at = MAX(algo_scan_state.last_candle_at, excluded.last_candle_at),
    last_scan_at = excluded.last_scan_at, last_error = excluded.last_error, updated_at = excluded.updated_at`)
    .run(userId, candleAt || 0, Date.now(), error, Date.now());
}

function quoteForTrade(chain, securityId) {
  for (const sides of Object.values(chain?.oc || {})) for (const item of [sides?.ce, sides?.pe]) {
    if (String(item?.security_id || '') === String(securityId)) return item;
  }
  return null;
}

export async function autoPaperScanTick(userId, ip = 'scanner') {
  const profile = getAlgoConfig(userId);
  const autoOpenCount = stmt(`SELECT COUNT(*) AS n FROM algo_paper_trades WHERE user_id = ? AND status = 'open' AND auto_managed = 1`).get(userId).n;
  if (!marketOpen() || ((!profile.autoTrading || !profile.paperEnabled) && !autoOpenCount)) return { skipped: true };
  const acct = accountFor(userId);
  if (!acct || acct.status !== 'connected' || acct.broker !== 'dhan' || !acct.token_enc) throw conflict('DHAN_REQUIRED', 'Reconnect Dhan to run automatic paper scans.');
  const book = getBook(userId);
  if (!autoOpenCount && (book.positions.some(p => p.qty !== 0) || book.orders.length)) throw conflict('ACCOUNT_NOT_CLEAR', 'Automatic paper entries are paused because the real Dhan account has open risk.');
  const adapter = adapterFor(acct);
  if (!adapter.intradayCandles || !adapter.optionChain) throw conflict('OPTIONS_UNAVAILABLE', 'Dhan intraday candles and option-chain access are required for automatic scanning.');
  const now = Date.now(), state = stmt('SELECT last_candle_at AS lastCandleAt FROM algo_scan_state WHERE user_id = ?').get(userId) || { lastCandleAt: 0 };
  const candles = await fiveMinuteCandles(adapter, now);
  const latest = candles.at(-1);
  if (!latest) { writeScanState(userId, {}); return { skipped: true, reason: 'No completed five-minute candle yet.' }; }
  const fresh = now - latest.time <= 7 * 60_000;
  const isNewCandle = latest.time > Number(state.lastCandleAt || 0);
  const trades = stmt(`SELECT id, proposal_id AS proposalId, security_id AS securityId, action, strike,
      option_type AS option, expiry, quantity, entry_price AS entryPrice, mark_price AS markPrice, auto_managed AS autoManaged
    FROM algo_paper_trades WHERE user_id = ? AND status = 'open' ORDER BY opened_at DESC`).all(userId);

  if (trades.length) {
    for (const trade of trades) {
      const chain = await optionRequest(() => adapter.optionChain({ underlyingScrip: 13, underlyingSeg: 'IDX_I', expiry: trade.expiry }));
      refreshPaperMarks(userId, chain);
      const quote = quoteForTrade(chain, trade.securityId);
      if (!quote) continue;
      const bid = Number(quote.top_bid_price) > 0 ? Number(quote.top_bid_price) : Number(quote.last_price);
      const stop = trade.entryPrice * (1 - profile.stopLossPct / 100);
      const target = trade.entryPrice * (1 + profile.takeProfitPct / 100);
      const squareOff = toMinutes(getStrategy(userId).exits.squareOff || '15:15');
      let exitReason = bid <= stop ? 'Paper stop loss reached.' : bid >= target ? 'Paper target reached.'
        : ist(now).minutes >= squareOff ? 'Scheduled paper square-off reached.' : '';
      let exitByAi = false;
      if (!exitReason && isNewCandle && fresh) {
        const strategy = { ...getStrategy(userId), timeframe: '5m' };
        const decision = await askOpenAI({ underlying: 'NIFTY', spot: Number(chain?.last_price), expiry: trade.expiry,
          candles, option: { strike: trade.strike, type: trade.option, entryPrice: trade.entryPrice, bid, ltp: Number(quote.last_price) } },
          strategy, profile, trade);
        if (decision.action === 'EXIT' && decision.confidence >= profile.minConfidence) { exitReason = decision.rationale; exitByAi = true; }
      }
      if (exitReason) {
        const event = recordEvent(userId, 'signal', 'SELL_TO_CLOSE', { tradeId: trade.id, strike: trade.strike, option: trade.option, expiry: trade.expiry,
          price: bid, rationale: exitReason, source: exitByAi ? 'AI exit signal' : 'Paper risk limit' });
        const closed = closePaperTrade(userId, { id: trade.id, exitPrice: bid }, ip);
        audit(userId, 'algo.auto_exit', { eventId: event.id, tradeId: trade.id, price: bid, source: exitByAi ? 'ai' : 'risk_limit' }, ip);
        writeScanState(userId, { candleAt: latest.time });
        return { action: 'SELL_TO_CLOSE', trade: closed };
      }
    }
    writeScanState(userId, { candleAt: isNewCandle ? latest.time : Number(state.lastCandleAt || 0) });
    return { action: isNewCandle && fresh ? 'HOLD' : 'MONITOR' };
  }

  if (!profile.autoTrading || !isNewCandle || !fresh) { writeScanState(userId, { candleAt: latest.time }); return { skipped: true, reason: 'Waiting for automatic entries to be enabled and a fresh completed five-minute candle.' }; }
  if (paperBook(userId).todayPnl <= -profile.maxDailyLoss) {
    writeScanState(userId, { candleAt: latest.time });
    return { skipped: true, reason: 'Paper entries paused at the configured paper daily-loss limit.' };
  }
  const proposal = await analyzeOptions(userId, ip, { auto: true, candles });
  if (proposal.action === 'BUY_CE' || proposal.action === 'BUY_PE') {
    const trade = openPaperTrade(userId, { proposalId: proposal.id, quantity: profile.autoQuantity, autoManaged: true }, ip);
    audit(userId, 'algo.auto_entry', { proposalId: proposal.id, tradeId: trade.id, action: proposal.action, quantity: profile.autoQuantity }, ip);
  }
  writeScanState(userId, { candleAt: latest.time });
  return proposal;
}

export function startAlgoScanner() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const rows = stmt('SELECT user_id AS userId, config FROM algo_profiles').all();
      const managed = stmt(`SELECT DISTINCT user_id AS userId FROM algo_paper_trades WHERE status = 'open' AND auto_managed = 1`).all();
      const users = new Map(rows.map(row => [row.userId, row.config]));
      for (const row of managed) if (!users.has(row.userId)) users.set(row.userId, '{}');
      for (const [userId, rawConfig] of users) {
        let enabled = false, managingOpenTrade = false;
        try { const cfg = JSON.parse(rawConfig); enabled = !!cfg.autoTrading && !!cfg.paperEnabled; } catch {}
        managingOpenTrade = stmt(`SELECT 1 FROM algo_paper_trades WHERE user_id = ? AND status = 'open' AND auto_managed = 1 LIMIT 1`).get(userId) != null;
        if (!enabled && !managingOpenTrade) continue;
        try { await autoPaperScanTick(userId); writeScanState(userId, {}); }
        catch (error) {
          const code = String(error?.code || 'SCAN_FAILED').slice(0, 80);
          const previous = stmt('SELECT last_error AS lastError, last_scan_at AS lastScanAt FROM algo_scan_state WHERE user_id = ?').get(userId);
          writeScanState(userId, { error: code });
          if (previous?.lastError !== code || Date.now() - Number(previous?.lastScanAt || 0) >= 5 * 60_000) recordAlgoFailure(userId, error, 'scanner');
        }
      }
    } catch (error) { console.error('[algo-scanner]', error?.message || error); }
    finally { running = false; }
  };
  const timer = setInterval(tick, 60_000);
  timer.unref();
  setTimeout(tick, 10_000).unref();
  return () => clearInterval(timer);
}
