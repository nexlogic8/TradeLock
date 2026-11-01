import { config } from '../../config.js';
import { accountFor, adapterFor } from '../broker/registry.js';
import { sharedSource } from '../broker/market-data.js';
import { getPermissions } from '../broker/book.js';
import { bad, conflict, HttpError } from '../../lib/errors.js';
import { limit } from '../../lib/ratelimit.js';
import { ist, marketOpen } from '../../lib/time.js';
import { allowScalperContracts } from './live.js';
import { scalperSignalRisk, scanScalperSignal } from './signals.js';
import { cachedMarketData } from './cache.js';
import { activeNiftyExpiries, resolveNiftyExpiry } from './expiry.js';
import { openingRangeBreakout } from './signal-risk.js';
import { indexOptionInstruments } from './instruments.js';
import { UNDERLYINGS, isIndexId, underlyingFor } from './underlyings.js';
import { OPTION_BACKTEST, optionTrades } from './option-backtest.js';
import { ORB5_DEFAULTS, orb5Backtest } from './orb5.js';
import { ORB5_EXPIRIES, ORB5_OPTION_DEFAULTS, orb5OptionTrades } from './orb5-options.js';
import { stmt, tx } from '../../db/index.js';
import { GAP_DEFAULTS, gapBacktestInWorker, gapCoverage } from '../backtest/gap.js';
import { EMA915_DEFAULTS, ema915BacktestInWorker } from '../backtest/ema915.js';
import { CUSTOM_BUILT_IN, CUSTOM_DEFAULTS, CUSTOM_TIMEFRAMES, customBacktestInWorker } from '../backtest/custom.js';
import { listStrategies, normalizeStrategy } from '../strategy/service.js';
import { openHistory } from '../backtest/history-store.js';
import { getRules } from '../rules/service.js';
import { gzipSync, gunzipSync } from 'node:zlib';
import { STOP_RULES, backtestSignals, countOpeningRangeSessions, ema45HammerSignals, emaIndicatorRows, normalizeBacktestCandles, openingRangeFirstTradeSignals, previousDayBreakoutSignals } from '../../../../web/js/pages/scalper-chart-signals.js';

// Dhan limits option-chain requests to one per user every three seconds. Queue requests
// server-side so one page refresh or expiry change cannot accidentally trip the limit.
const lastChainRequest = new Map();
const chainQueues = new Map();
const allowedByUser = new Map();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
// With a shared market-data account every user reads the same chain and candles: one cache scope for all, and
// Dhan's pacing lives in broker/market-data.js (so no per-user 3-second gap here).
const SHARED_SCOPE = {};
const scopeOf = adapter => (sharedSource() ? SHARED_SCOPE : adapter);
const ownerOf = userId => (sharedSource() ? 'shared' : userId);

function optionRequest(userId, fn) {
  if (sharedSource()) return Promise.resolve().then(fn);
  const previous = chainQueues.get(userId) || Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    const elapsed = Date.now() - (lastChainRequest.get(userId) || 0);
    if (elapsed < 3100) await wait(3100 - elapsed);
    lastChainRequest.set(userId, Date.now());
    return fn();
  });
  chainQueues.set(userId, current);
  current.then(() => { if (chainQueues.get(userId) === current) chainQueues.delete(userId); }, () => { if (chainQueues.get(userId) === current) chainQueues.delete(userId); });
  return current;
}

// Lot size from Dhan's instrument master; the page sizes orders in lots. Never blocks the page for long.
async function lotSizeFor(securityId, exchange = 'NSE') {
  if (!securityId) return null;
  try { return (await Promise.race([indexOptionInstruments(), wait(250).then(() => null)]))?.get(`${exchange}:${securityId}`)?.lotSize || null; }
  catch { return null; }
}

function requireDhan(userId) {
  const acct = accountFor(userId);
  // The store reviewers' simulated account reads the shared market data.
  if (acct?.broker === 'mock' && config.reviewUserId === userId && sharedSource()) return adapterFor(acct);
  if (!acct || acct.status !== 'connected' || acct.broker !== 'dhan' || !acct.token_enc) {
    throw conflict('DHAN_REQUIRED', 'Connect or reconnect Dhan to open Power Scalper.');
  }
  return adapterFor(acct);
}

const TRANSIENT = new Set(['NETWORK', 'BROKER', 'DH-904', 'DH-908']);
async function dataCall(fn) {
  try {
    // Market data is read-only: retry transient failures (timeout, throttle, 5xx) twice, backing off.
    for (let attempt = 0; ; attempt++) {
      try { return await fn(); }
      catch (e) {
        if (!TRANSIENT.has(String(e?.code)) || attempt >= 2) throw e;
        await wait(attempt ? 2500 : 1200);
      }
    }
  }
  catch (e) {
    console.warn(`[scalper] Dhan market data failed: ${e?.code || 'UNKNOWN'} ${e?.message || e}`);
    if (e?.code === 'TOKEN_EXPIRED') throw conflict('DHAN_RECONNECT_REQUIRED', 'Your Dhan token expired. Reconnect Dhan from Broker accounts, then reopen Power Scalper.');
    if (['DH-902','806'].includes(String(e?.code))) {
      throw new HttpError(403, 'DHAN_DATA_API_REQUIRED', 'Power Scalper needs an active Dhan Data APIs subscription for this account.');
    }
    if (e?.code === 'DH-904') throw new HttpError(429, 'DHAN_RATE_LIMIT', 'Dhan market-data limit reached. Wait a few seconds and try again.');
    if (e?.code === 'NETWORK') throw new HttpError(504, 'DHAN_MARKET_DATA_TIMEOUT', `Dhan market data is slow right now (${e.message}). Try again in a few seconds.`);
    throw new HttpError(502, 'DHAN_MARKET_DATA_FAILED', `Dhan could not provide market data${e?.message ? ` (${e.message})` : ''}. Check Data APIs access and reconnect the broker if needed.`);
  }
}

// Last good expiry list / chain per user, index and expiry. Dhan has short 5xx outages (often around
// pre-open); the page then shows this snapshot, marked stale, instead of an error. Account problems
// (token, Data APIs subscription) are never hidden this way.
const lastGood = new Map();
const LAST_GOOD_MS = 20 * 60 * 60_000;
const ACCOUNT_ERRORS = new Set(['DHAN_RECONNECT_REQUIRED', 'DHAN_DATA_API_REQUIRED', 'DHAN_REQUIRED']);
async function orLastGood(key, load) {
  try {
    const result = await load();
    lastGood.delete(key); lastGood.set(key, { value: result.value, asOf: result.asOf });
    if (lastGood.size > 300) lastGood.delete(lastGood.keys().next().value);
    return result;
  } catch (e) {
    const good = lastGood.get(key);
    if (ACCOUNT_ERRORS.has(e?.code) || !good || Date.now() - good.asOf > LAST_GOOD_MS) throw e;
    console.warn(`[scalper] serving last good ${key.split(':').slice(1).join(':')} after: ${e?.message || e}`);
    return { ...good, cached: true, stale: true };
  }
}

// The chain contracts a user loaded, per index (the page preloads all three). With the index named
// (NSE and BSE ids can collide) only that index's chain is searched.
function allowedFor(userId, securityId, key) {
  const fresh = [...(allowedByUser.get(userId)?.entries() || [])].filter(([, a]) => Date.now() - a.at <= 8 * 60 * 60_000);
  const scoped = key ? fresh.filter(([k]) => k === String(key).toUpperCase()) : fresh;
  if (!securityId) return scoped[0]?.[1] || null;
  return scoped.find(([, a]) => a.ids.has(securityId))?.[1] || null;
}

const fmtIst = at => {
  const d = new Date(at + 330 * 60_000);
  return `${d.toISOString().slice(0, 10)} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`;
};

function candleTime(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e11 ? numeric * 1000 : numeric;
  if (typeof value !== 'string') return NaN;
  const text = value.trim();
  // Dhan's date-only timestamps are exchange-local IST with no zone marker.
  if (/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d/.test(text)) {
    const normalized = text.slice(0, 19).replace(' ', 'T');
    const zone = text.match(/([zZ]|[+-]\d\d:?\d\d)$/)?.[1];
    return Date.parse(`${normalized}${zone || '+05:30'}`);
  }
  return Date.parse(text);
}

export function normalizeScalperCandles(response) {
  const rows = (response?.timestamp || []).map((stamp, i) => ({
    time: candleTime(stamp),
    open: Number(response.open?.[i]), high: Number(response.high?.[i]), low: Number(response.low?.[i]),
    close: Number(response.close?.[i]), volume: Number(response.volume?.[i]) || 0, oi: Number(response.open_interest?.[i]) || 0,
  })).filter(c => Number.isFinite(c.time) && c.time > 0 && [c.open, c.high, c.low, c.close].every(Number.isFinite));
  rows.sort((a, b) => a.time - b.time);
  // Providers may repeat the last bar at the end of adjacent history windows.
  return rows.filter((row, i) => i === 0 || row.time > rows[i - 1].time);
}

function historyStart(day, days = 7) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return `${date.toISOString().slice(0, 10)} 09:00:00`;   // fromDate is exclusive at Dhan; keep the 09:15 bar
}

const validIsoDay = day => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)
  && Number.isFinite(Date.parse(`${day}T00:00:00Z`)) && new Date(`${day}T00:00:00Z`).toISOString().slice(0,10) === day;
const shiftDay = (day, amount) => { const date=new Date(`${day}T00:00:00Z`); date.setUTCDate(date.getUTCDate()+amount); return date.toISOString().slice(0,10); };
function shiftMonths(day, months) {
  const date=new Date(`${day}T00:00:00Z`),wanted=date.getUTCDate();
  date.setUTCDate(1);date.setUTCMonth(date.getUTCMonth()+months);
  const last=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate();
  date.setUTCDate(Math.min(wanted,last));
  return date.toISOString().slice(0,10);
}
function dateWindows(startDate, endDate) {
  const chunks=[];
  for(let start=startDate; start<=endDate;) {
    const end=shiftDay(start,89)>endDate?endDate:shiftDay(start,89);
    chunks.push([start,end]); start=shiftDay(end,1);
  }
  return chunks;
}

// Chart history: a month back for the index and for option contracts (weekly contracts are listed weeks before
// they become the nearest expiry, and Dhan has their candles since). The chart scrolls through it; 1M shows it
// all. One Dhan request either way (intraday allows 90 days).
const CHART_DAYS = { INDEX: 31, OPTIDX: 31 };
function chartHistory(adapter, spec, interval, fresh = false) {
  const now = Date.now(), day = ist(now).day, days = CHART_DAYS[spec.instrument] || 7;
  const key = `candles:${day}:${spec.exchangeSegment}:${spec.securityId}:${interval}:${days}d`;
  return cachedMarketData(scopeOf(adapter), key, 30_000, async () => {
    const response = await dataCall(() => adapter.intradayCandles({ ...spec, interval,
      fromDate: historyStart(day, days), toDate: fmtIst(Date.now()) }));
    return normalizeScalperCandles(response);
  }, { fresh });
}

const backtestDay = new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Kolkata', year:'numeric', month:'2-digit', day:'2-digit' });
function backtestRange(startDate, endDate, today) {
  if (!validIsoDay(startDate)||!validIsoDay(endDate)||startDate>endDate||endDate>today)
    throw bad('INVALID_BACKTEST_DATES','Choose valid start and end dates up to today.');
  const earliest=shiftMonths(today,-60);
  if(startDate<earliest) throw bad('BACKTEST_RANGE_TOO_LARGE',`Dhan minute history covers the last five years. Choose a start date on or after ${earliest}.`);
}
async function loadBacktestCandles(adapter, startDate, endDate, strategy, now, exitLogic = 'horizon') {
  const today=ist(now).day;
  backtestRange(startDate,endDate,today);
  const warmupStart=shiftDay(startDate,-14),earliest=shiftMonths(today,-60);
  const needsWarmup=strategy==='previousDay'||exitLogic==='emaZone';
  const historyStartDate=needsWarmup&&warmupStart<earliest?earliest:needsWarmup?warmupStart:startDate;
  const windows=dateWindows(historyStartDate,endDate);
  const load = async interval => {
    const all=[]; let asOf=Infinity,cached=true;
    for(const [fromDay,toDay] of windows) {
      const key=`backtest:${fromDay}:${toDay}:13:IDX_I:${interval}`;
      const snapshot=await cachedMarketData(scopeOf(adapter),key,toDay===today?30_000:6*60*60_000,async()=>{
        // Dhan treats fromDate as exclusive: starting at 09:15:00 would drop each window's first 09:15 bar.
        const fromDate=`${fromDay} 09:00:00`,toDate=toDay===today?fmtIst(now):`${toDay} 15:30:00`;
        const response=await dataCall(()=>adapter.intradayCandles({securityId:'13',exchangeSegment:'IDX_I',instrument:'INDEX',interval,fromDate,toDate}));
        return normalizeScalperCandles(response);
      });
      all.push(...snapshot.value);asOf=Math.min(asOf,snapshot.asOf);cached&&=snapshot.cached;
    }
    const value=normalizeBacktestCandles(all);
    return {value,asOf,cached};
  };
  const [oneMinute,fiveMinute]=await Promise.all([load('1'),load('5')]);
  return {oneMinute:oneMinute.value,fiveMinute:fiveMinute.value,asOf:Math.min(oneMinute.asOf,fiveMinute.asOf),cached:oneMinute.cached&&fiveMinute.cached};
}

function savedBacktest(row) {
  return {id:row.id,strategy:row.strategy,startDate:row.start_date,endDate:row.end_date,horizon:row.horizon_bars,exitLogic:row.exit_logic||'horizon',stopLogic:row.stop_logic||'none',
    createdAt:row.created_at,asOf:row.as_of,oneMinuteBars:row.one_minute_bars,rangeSessions:row.range_sessions,
    signalCount:row.signal_count,metrics:JSON.parse(row.metrics_json)};
}

// --- Nifty 5-Minute ORB backtest (historical data only; never places orders) ---
// ~90 s of option-data calls per month of trades; 60 days keeps a run well under the 5-minute request limit.
const ORB5_LIMITS = { maxOptionDays:60 };
const intIn = (value, min, max) => Number.isSafeInteger(Number(value)) && Number(value) >= min && Number(value) <= max;
const numIn = (value, min, max) => Number.isFinite(Number(value)) && Number(value) >= min && Number(value) <= max;
function orb5Settings(body) {
  const b = body || {}, mode = b.mode || 'directional';
  if (!['directional', 'options'].includes(mode)) throw bad('INVALID_ORB_MODE', 'Choose the directional or actual-options mode.');
  const riskReward = Number(b.riskReward ?? ORB5_DEFAULTS.riskReward), maxEntriesPerDay = Number(b.maxEntriesPerDay ?? ORB5_DEFAULTS.maxEntriesPerDay);
  const squareOff = String(b.squareOff ?? ORB5_DEFAULTS.squareOff), slippagePoints = Number(b.slippagePoints ?? ORB5_DEFAULTS.slippagePoints);
  if (!numIn(riskReward, 0.5, 10)) throw bad('INVALID_ORB_RR', 'Risk-reward must be between 0.5 and 10.');
  if (!intIn(maxEntriesPerDay, 1, 10)) throw bad('INVALID_ORB_ENTRIES', 'Maximum entries per day must be a whole number from 1 to 10.');
  if (!/^\d\d:\d\d$/.test(squareOff) || squareOff < '09:21' || squareOff > '15:29') throw bad('INVALID_ORB_SQUAREOFF', 'Square-off time must be between 09:21 and 15:29 IST.');
  if (!numIn(slippagePoints, 0, 20)) throw bad('INVALID_ORB_SLIPPAGE', 'Slippage must be between 0 and 20 points.');
  const oppositeExit = String(b.oppositeExit ?? ORB5_DEFAULTS.oppositeExit);
  if (!['off', '1m', '5m'].includes(oppositeExit)) throw bad('INVALID_ORB_EXIT', 'Opposite-candle exit must be off, 1-minute or 5-minute.');
  const settings = { mode, riskReward, maxEntriesPerDay, squareOff, oppositeExit, slippagePoints:mode === 'options' ? 0 : slippagePoints };
  if (mode !== 'options') return settings;
  const o = { ...ORB5_OPTION_DEFAULTS, ...(b.options || {}) };
  o.statutoryCharges = o.statutoryCharges !== false && o.statutoryCharges !== 'false';
  if (!ORB5_EXPIRIES[o.expiry]) throw bad('INVALID_ORB_EXPIRY', 'Choose a supported expiry.');
  if (!intIn(o.moneyness, -5, 5)) throw bad('INVALID_ORB_STRIKE', 'Choose ATM or up to 5 strikes ITM/OTM.');
  if (!intIn(o.lots, 1, 100)) throw bad('INVALID_ORB_LOTS', 'Lots must be a whole number from 1 to 100.');
  if (!numIn(o.brokeragePerOrder, 0, 500)) throw bad('INVALID_ORB_BROKERAGE', 'Brokerage per order must be between ₹0 and ₹500.');
  if (!numIn(o.slippagePerUnit, 0, 50)) throw bad('INVALID_ORB_SLIPPAGE', 'Option slippage must be between ₹0 and ₹50 per unit.');
  return { ...settings, options:{ expiry:o.expiry, moneyness:Number(o.moneyness), lots:Number(o.lots), brokeragePerOrder:Number(o.brokeragePerOrder),
    slippagePerUnit:Number(o.slippagePerUnit), statutoryCharges:o.statutoryCharges } };
}
/**
 * Weekly-expiry option candles from the stored history (history.db: the same Dhan rollingoption rows, by expiry slot
 * and strike offset), so actual-options runs need no 60-day cap there. A day or offset not stored (beyond the
 * stored strikes, after the last stored day) still comes from Dhan through `fallback`.
 */
function historyLoader(store, expiryKey, fallback) {
  const { flag, code } = ORB5_EXPIRIES[expiryKey];
  if (flag !== 'WEEK') return fallback;
  const q = store.db.prepare('SELECT time, strike, open, high, low, close, volume, oi, iv, spot FROM option_1m WHERE underlying = ? AND expiry_code = ? AND side = ? AND offset = ? AND time >= ? AND time < ? ORDER BY time');
  return async (day, option, offset) => {
    const from = Date.parse(`${day}T00:00:00+05:30`) / 1000, rows = q.all('NIFTY', code, option, offset, from, from + 86_400);
    return rows.length ? rows : fallback(day, option, offset);
  };
}
function rollingLoader(adapter, expiryKey, today) {
  const { flag, code } = ORB5_EXPIRIES[expiryKey];
  return async (day, option, offset) => {
    const strike = offset === 0 ? 'ATM' : `ATM${offset > 0 ? '+' : ''}${offset}`;
    try {
      const snapshot = await cachedMarketData(scopeOf(adapter), `rolling:${flag}:${code}:${day}:${option}:${strike}`, day === today ? 30_000 : 6 * 60 * 60_000,
        () => dataCall(() => adapter.rollingOption({ expiryFlag:flag, expiryCode:code, strike, option, fromDate:day, toDate:shiftDay(day, 1) })));
      return snapshot.value.filter(row => backtestDay.format(new Date(row.time * 1000)) === day);
    } catch (e) {
      // Account problems stop the run; a missing day only marks that trade unavailable.
      if (['DHAN_RECONNECT_REQUIRED', 'DHAN_DATA_API_REQUIRED'].includes(e?.code)) throw e;
      return [];
    }
  };
}
async function runOrb5Backtest(ctx) {
  const { startDate, endDate } = ctx.body, now = Date.now(), today = ist(now).day;
  backtestRange(startDate, endDate, today);
  const settings = orb5Settings(ctx.body);
  const days = (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000 + 1;
  // Weekly expiries inside the stored history read option candles locally: any length. Otherwise each trade's
  // candles come from Dhan, which keeps a run to ORB5_LIMITS.maxOptionDays.
  let store = null, coverage = null;
  if (settings.mode === 'options' && ORB5_EXPIRIES[settings.options.expiry]?.flag === 'WEEK') {
    try { store = openHistory(); coverage = gapCoverage(store); } catch { coverage = null; }
    if (!coverage || startDate < coverage.from) { store?.close(); store = null; }
  }
  if (settings.mode === 'options' && !store && days > ORB5_LIMITS.maxOptionDays)
    throw bad('BACKTEST_RANGE_TOO_LARGE', `Actual-options mode loads each trade's option candles from Dhan; choose up to ${ORB5_LIMITS.maxOptionDays} days${coverage ? `, or a weekly expiry from ${coverage.from} (stored history: any length)` : ''}.`);
  try { return await runOrb5(ctx, { startDate, endDate, now, today, settings, store }); }
  finally { store?.close(); }
}
async function runOrb5(ctx, { startDate, endDate, now, today, settings, store }) {
  const adapter = requireDhan(ctx.user.id);
  const history = await loadBacktestCandles(adapter, startDate, endDate, 'openingRange', now, 'horizon');
  const run = orb5Backtest(history.oneMinute, { startDay:startDate, endDay:endDate, now, ...settings });
  const metrics = { orb5:true, mode:settings.mode, settings, summary:run.summary, days:run.days, trades:run.trades,
    skippedSignals:run.skippedSignals, equityCurve:run.equityCurve, totalPoints:run.summary.net };
  let optionCandles = {};
  if (settings.mode === 'options') {
    const tradingDays = new Set(history.oneMinute.map(candle => backtestDay.format(new Date(candle.time * 1000))));
    const dhanLoader = rollingLoader(adapter, settings.options.expiry, today);
    const priced = await orb5OptionTrades(run.trades, { loadDay:store ? historyLoader(store, settings.options.expiry, dhanLoader) : dhanLoader, tradingDays, ...settings.options });
    Object.assign(metrics, { trades:priced.trades, optionSummary:priced.summary, equityCurve:priced.equityCurve, directionalSummary:run.summary });
    metrics.days = run.days.map(day => ({ ...day, pnl:priced.dailyPnl[day.day] ?? 0 }));
    optionCandles = priced.candles;
  }
  const tradedDays = new Set(metrics.trades.map(trade => trade.day));
  const chartCandles = {};
  for (const candle of history.oneMinute) {
    const day = backtestDay.format(new Date(candle.time * 1000));
    if (tradedDays.has(day)) (chartCandles[day] ??= []).push(candle);
  }
  for (const [time, rows] of Object.entries(optionCandles)) chartCandles[`option:${time}`] = rows;
  const start = Date.parse(`${startDate}T00:00:00+05:30`) / 1000, end = Date.parse(`${endDate}T23:59:59+05:30`) / 1000;
  const visibleBars = history.oneMinute.filter(candle => candle.time >= start && candle.time <= end).length;
  const saved = tx(() => {
    const inserted = stmt(`INSERT INTO backtest_runs
      (user_id,strategy,start_date,end_date,horizon_bars,created_at,as_of,one_minute_bars,range_sessions,signal_count,metrics_json,candles_gzip,exit_logic,stop_logic)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(ctx.user.id, 'orb5', startDate, endDate, 0, now, history.asOf, visibleBars, run.summary.sessions,
        run.trades.length + run.skippedSignals.length, JSON.stringify(metrics), gzipSync(Buffer.from(JSON.stringify(chartCandles))), 'horizon', 'none');
    stmt(`DELETE FROM backtest_runs WHERE user_id=? AND id NOT IN
      (SELECT id FROM backtest_runs WHERE user_id=? ORDER BY id DESC LIMIT 20)`).run(ctx.user.id, ctx.user.id);
    return stmt('SELECT * FROM backtest_runs WHERE id=? AND user_id=?').get(Number(inserted.lastInsertRowid), ctx.user.id);
  })();
  return savedBacktest(saved);
}
// --- Gap open 09:15 backtest (the live Algo strategy) on the local 1-minute history; no Dhan calls ---
/** Defaults follow the account's Risk rules (daily loss limit %, cutoff), as the live strategy does. */
function gapDefaults(userId) {
  const r = getRules(userId).active, d = { ...GAP_DEFAULTS };
  if (r?.maxLoss?.on && r.maxLoss.mode === 'percent' && Number(r.maxLoss.value) > 0) d.dailySlPct = Number(r.maxLoss.value);
  if (r?.cutoff?.on && /^\d{2}:\d{2}$/.test(r.cutoff.value)) d.squareOff = r.cutoff.value;
  return d;
}
function gapCapabilities(userId) {
  let store;
  try { store = openHistory(); const coverage = gapCoverage(store); return { available: !!coverage, coverage, defaults: gapDefaults(userId) }; }
  catch (e) { return { available: false, reason: e.message, defaults: gapDefaults(userId) }; }
  finally { store?.close(); }
}
function gapSettings(body) {
  const b = body || {}, d = GAP_DEFAULTS;
  const s = { capital: Number(b.capital ?? d.capital), compound: b.compound === undefined ? d.compound : b.compound === true, fundsUse: Number(b.fundsUse ?? d.fundsUse),
    dailySlPct: Number(b.dailySlPct ?? d.dailySlPct), lotCap: Number(b.lotCap ?? d.lotCap), slippage: Number(b.slippage ?? d.slippage), squareOff: String(b.squareOff ?? d.squareOff),
    costToCostR: Number(b.costToCostR ?? d.costToCostR), exitCandle: String(b.exitCandle ?? d.exitCandle), strike: Number(b.strike ?? d.strike), lateEntryPct: Number(b.lateEntryPct ?? d.lateEntryPct) };
  if (!intIn(s.strike, -3, 3)) throw bad('INVALID_GAP_STRIKE', 'Choose a strike from OTM3 to ITM3.');
  if (!numIn(s.lateEntryPct, 0, 15)) throw bad('INVALID_GAP_LATE_ENTRY', 'Late entry must be 0–15% above the 09:15 open.');
  if (!numIn(s.capital, 1000, 1e10)) throw bad('INVALID_GAP_CAPITAL', 'Starting capital must be between ₹1,000 and ₹1,000 crore.');
  if (!numIn(s.fundsUse, 1, 100)) throw bad('INVALID_GAP_FUNDS', 'Capital used per trade must be 1–100%.');
  if (!numIn(s.dailySlPct, 0.1, 100)) throw bad('INVALID_GAP_SL', 'Daily stop-loss must be 0.1–100% of capital.');
  if (!intIn(s.lotCap, 0, 100000)) throw bad('INVALID_GAP_LOTS', 'Lot cap must be a whole number (0 = no cap).');
  if (!numIn(s.slippage, 0, 50)) throw bad('INVALID_GAP_SLIPPAGE', 'Slippage must be ₹0–50 a unit.');
  if (!numIn(s.costToCostR, 0, 5)) throw bad('INVALID_GAP_COST_TO_COST', 'Cost to cost must be 0 (off) to 5 × the risk.');
  if (!['1m', '5m', '0916'].includes(s.exitCandle)) throw bad('INVALID_GAP_EXIT', 'Exit on the opposite 1-minute or 5-minute candle, or at 09:16.');
  if (!/^\d{2}:\d{2}$/.test(s.squareOff) || s.squareOff < '09:20' || s.squareOff > '15:29') throw bad('INVALID_GAP_SQUARE_OFF', 'Square-off must be between 09:20 and 15:29.');
  return s;
}
async function runGapBacktest(ctx) {
  const { startDate, endDate } = ctx.body || {}, now = Date.now();
  backtestRange(startDate, endDate, ist(now).day);
  const settings = gapSettings(ctx.body);
  const store = openHistory();
  let coverage;
  try { coverage = gapCoverage(store); } finally { store.close(); }
  if (!coverage) throw bad('GAP_HISTORY_MISSING', 'The 1-minute option history is not downloaded on this server yet.');
  if (endDate < coverage.from || startDate > coverage.to) throw bad('GAP_RANGE_OUTSIDE_HISTORY', `Stored history covers ${coverage.from} to ${coverage.to}; choose dates inside it.`);
  const run = await gapBacktestInWorker({ startDate, endDate, ...settings });
  const metrics = { gap: true, coverage, ...run };
  const saved = tx(() => {
    const inserted = stmt(`INSERT INTO backtest_runs
      (user_id,strategy,start_date,end_date,horizon_bars,created_at,as_of,one_minute_bars,range_sessions,signal_count,metrics_json,candles_gzip,exit_logic,stop_logic)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(ctx.user.id, 'gap', startDate, endDate, 0, now, Date.parse(`${coverage.to}T15:30:00+05:30`), run.oneMinuteBars, run.sessions,
        run.signals, JSON.stringify(metrics), gzipSync(Buffer.from('{}')), 'horizon', 'none');
    stmt(`DELETE FROM backtest_runs WHERE user_id=? AND id NOT IN
      (SELECT id FROM backtest_runs WHERE user_id=? ORDER BY id DESC LIMIT 20)`).run(ctx.user.id, ctx.user.id);
    return stmt('SELECT * FROM backtest_runs WHERE id=? AND user_id=?').get(Number(inserted.lastInsertRowid), ctx.user.id);
  })();
  return savedBacktest(saved);
}
// --- EMA 9/15 5m · 30° angle backtest (the live Algo strategy) on the local 1-minute history; no Dhan calls ---
/** Square-off follows the account's Risk rules cutoff, as live. */
function ema915Defaults(userId) {
  const r = getRules(userId).active, d = { ...EMA915_DEFAULTS };
  if (r?.cutoff?.on && /^\d{2}:\d{2}$/.test(r.cutoff.value)) d.squareOff = r.cutoff.value;
  return d;
}
function ema915Settings(body) {
  const b = body || {}, d = EMA915_DEFAULTS;
  const s = { lots: Number(b.lots ?? d.lots), slippage: Number(b.slippage ?? d.slippage), minAngle: Number(b.minAngle ?? d.minAngle), afterCross: Number(b.afterCross ?? d.afterCross),
    costToCostR: Number(b.costToCostR ?? d.costToCostR), lastEntry: String(b.lastEntry ?? d.lastEntry), squareOff: String(b.squareOff ?? d.squareOff) };
  if (!intIn(s.lots, 1, 1000)) throw bad('INVALID_EMA915_LOTS', 'Lots must be a whole number from 1 to 1,000.');
  if (!numIn(s.slippage, 0, 50)) throw bad('INVALID_EMA915_SLIPPAGE', 'Slippage must be ₹0–50 a unit.');
  if (!numIn(s.minAngle, 0, 89)) throw bad('INVALID_EMA915_ANGLE', 'The minimum angle must be 0–89°.');
  if (!intIn(s.afterCross, 0, 10)) throw bad('INVALID_EMA915_AFTER_CROSS', 'Candles after the crossover must be 0–10.');
  if (!numIn(s.costToCostR, 0, 5)) throw bad('INVALID_EMA915_COST_TO_COST', 'Cost to cost must be 0 (off) to 5 × the risk.');
  for (const [k, label] of [['lastEntry', 'Last entry'], ['squareOff', 'Square-off']])
    if (!/^\d{2}:\d{2}$/.test(s[k]) || s[k] < '09:20' || s[k] > '15:29') throw bad('INVALID_EMA915_TIME', `${label} must be between 09:20 and 15:29.`);
  return s;
}
async function runEma915Backtest(ctx) {
  const { startDate, endDate } = ctx.body || {}, now = Date.now();
  backtestRange(startDate, endDate, ist(now).day);
  const settings = ema915Settings(ctx.body);
  const store = openHistory();
  let coverage;
  try { coverage = gapCoverage(store); } finally { store.close(); }
  if (!coverage) throw bad('GAP_HISTORY_MISSING', 'The 1-minute option history is not downloaded on this server yet.');
  if (endDate < coverage.from || startDate > coverage.to) throw bad('GAP_RANGE_OUTSIDE_HISTORY', `Stored history covers ${coverage.from} to ${coverage.to}; choose dates inside it.`);
  const run = await ema915BacktestInWorker({ startDate, endDate, ...settings });
  const metrics = { ema915: true, coverage, ...run };
  const saved = tx(() => {
    const inserted = stmt(`INSERT INTO backtest_runs
      (user_id,strategy,start_date,end_date,horizon_bars,created_at,as_of,one_minute_bars,range_sessions,signal_count,metrics_json,candles_gzip,exit_logic,stop_logic)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(ctx.user.id, 'ema915', startDate, endDate, 0, now, Date.parse(`${coverage.to}T15:30:00+05:30`), run.oneMinuteBars, run.sessions,
        run.signals, JSON.stringify(metrics), gzipSync(Buffer.from('{}')), 'horizon', 'none');
    stmt(`DELETE FROM backtest_runs WHERE user_id=? AND id NOT IN
      (SELECT id FROM backtest_runs WHERE user_id=? ORDER BY id DESC LIMIT 20)`).run(ctx.user.id, ctx.user.id);
    return stmt('SELECT * FROM backtest_runs WHERE id=? AND user_id=?').get(Number(inserted.lastInsertRowid), ctx.user.id);
  })();
  return savedBacktest(saved);
}
// --- "My strategies" backtest: a saved strategy on the local 1-minute history; no Dhan calls ---
function customCapabilities(userId) {
  let store, coverage = null, reason = null;
  try { store = openHistory(); coverage = gapCoverage(store); } catch (e) { reason = e.message; } finally { store?.close(); }
  const strategies = [...Object.entries(CUSTOM_BUILT_IN).map(([id, x]) => ({ id, builtIn: true, ...x })),
    ...listStrategies(userId).map(x => ({ id: x.id, name: x.name, timeframe: x.timeframe, direction: x.direction, market: x.market, entries: x.entries, exits: x.exits }))];
  return { available: !!coverage, coverage, reason, defaults: CUSTOM_DEFAULTS, timeframes: Object.keys(CUSTOM_TIMEFRAMES), strategies };
}
function customSettings(body) {
  const b = body || {}, d = CUSTOM_DEFAULTS;
  const s = { lots: Number(b.lots ?? d.lots), slippage: Number(b.slippage ?? d.slippage), brokeragePerOrder: Number(b.brokeragePerOrder ?? d.brokeragePerOrder),
    measure: String(b.measure ?? d.measure), oppositeExit: b.oppositeExit === undefined ? d.oppositeExit : b.oppositeExit === true || b.oppositeExit === 'true', maxTrades: Number(b.maxTrades ?? d.maxTrades) };
  if (!intIn(s.lots, 1, 100)) throw bad('INVALID_CUSTOM_LOTS', 'Lots must be a whole number from 1 to 100.');
  if (!numIn(s.slippage, 0, 50)) throw bad('INVALID_CUSTOM_SLIPPAGE', 'Slippage must be ₹0–50 a unit.');
  if (!numIn(s.brokeragePerOrder, 0, 500)) throw bad('INVALID_CUSTOM_BROKERAGE', 'Brokerage per order must be between ₹0 and ₹500.');
  if (!['premium', 'index'].includes(s.measure)) throw bad('INVALID_CUSTOM_MEASURE', 'Measure the stop and target on the option premium or on NIFTY.');
  if (!intIn(s.maxTrades, 1, 100)) throw bad('INVALID_CUSTOM_MAX_TRADES', 'Maximum trades a day must be a whole number from 1 to 100.');
  return s;
}
async function runCustomBacktest(ctx) {
  const { startDate, endDate, strategyId } = ctx.body || {}, now = Date.now();
  backtestRange(startDate, endDate, ist(now).day);
  // A built-in (string id, exits only on the opposite signal / square-off) or one of the user's saved strategies.
  const builtIn = CUSTOM_BUILT_IN[strategyId];
  const row = builtIn ? null : stmt('SELECT config FROM user_strategies WHERE id = ? AND user_id = ?').get(Number(strategyId), ctx.user.id);
  if (!builtIn && !row) throw bad('STRATEGY_NOT_FOUND', 'Choose one of your saved strategies.');
  const strategy = builtIn ? structuredClone(builtIn) : normalizeStrategy(JSON.parse(row.config));
  if (!CUSTOM_TIMEFRAMES[strategy.timeframe]) throw bad('INVALID_CUSTOM_TIMEFRAME', 'Daily-timeframe strategies cannot be backtested on the 1-minute history; choose 1, 3, 5 or 15 minutes in the strategy.');
  const e = strategy.entries;
  if (!e.ema && !e.vwap && !e.rsi && !e.breakout) throw bad('CUSTOM_NO_ENTRY_RULE', 'Switch on at least one entry rule (EMA, VWAP, RSI or breakout) in the strategy.');
  const settings = customSettings(ctx.body);
  if (builtIn) settings.oppositeExit = true;   // its only exit besides the square-off
  const store = openHistory();
  let coverage;
  try { coverage = gapCoverage(store); } finally { store.close(); }
  if (!coverage) throw bad('GAP_HISTORY_MISSING', 'The 1-minute option history is not downloaded on this server yet.');
  if (endDate < coverage.from || startDate > coverage.to) throw bad('GAP_RANGE_OUTSIDE_HISTORY', `Stored history covers ${coverage.from} to ${coverage.to}; choose dates inside it.`);
  const run = await customBacktestInWorker({ startDate, endDate, strategy, ...settings });
  const metrics = { custom: true, strategyId: builtIn ? strategyId : Number(strategyId), coverage, ...run };
  const saved = tx(() => {
    const inserted = stmt(`INSERT INTO backtest_runs
      (user_id,strategy,start_date,end_date,horizon_bars,created_at,as_of,one_minute_bars,range_sessions,signal_count,metrics_json,candles_gzip,exit_logic,stop_logic)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(ctx.user.id, 'custom', startDate, endDate, 0, now, Date.parse(`${coverage.to}T15:30:00+05:30`), run.oneMinuteBars, run.sessions,
        run.signals, JSON.stringify(metrics), gzipSync(Buffer.from('{}')), 'horizon', 'none');
    stmt(`DELETE FROM backtest_runs WHERE user_id=? AND id NOT IN
      (SELECT id FROM backtest_runs WHERE user_id=? ORDER BY id DESC LIMIT 20)`).run(ctx.user.id, ctx.user.id);
    return stmt('SELECT * FROM backtest_runs WHERE id=? AND user_id=?').get(Number(inserted.lastInsertRowid), ctx.user.id);
  })();
  return savedBacktest(saved);
}
/** Whether historical option data can be read for this account (actual-options mode). */
async function optionDataAvailability(userId) {
  let adapter;
  try { adapter = requireDhan(userId); } catch (e) { return { available:false, reason:e.message }; }
  let probe = new Date(Date.now() + 19_800_000 - 7 * 86_400_000);
  while ([0, 6].includes(probe.getUTCDay())) probe = new Date(probe.getTime() - 86_400_000);
  const day = probe.toISOString().slice(0, 10);
  try {
    const snapshot = await cachedMarketData(scopeOf(adapter), `rolling-available:${day}`, 6 * 60 * 60_000,
      () => dataCall(() => adapter.rollingOption({ expiryFlag:'WEEK', expiryCode:1, strike:'ATM', option:'CE', fromDate:day, toDate:shiftDay(day, 1) })));
    return snapshot.value.length ? { available:true } : { available:false, reason:'Dhan returned no historical option candles for this account.' };
  } catch (e) {
    return { available:false, reason:e?.message || 'Historical option data could not be read from Dhan.' };
  }
}

// Option expiries for one index: cached for the day's key (6 h), shared by the page and the warm-up below.
function loadExpiries(userId, adapter, u) {
  return orLastGood(`${ownerOf(userId)}:expiries:${u.key}`, () => cachedMarketData(scopeOf(adapter), `expiries:${u.key}:${ist().day}`, 6 * 3_600_000, async () => {
    const value = await dataCall(() => optionRequest(userId, () => adapter.optionExpiries({ underlyingScrip: Number(u.securityId), underlyingSeg: 'IDX_I' })));
    if (!value.length) throw new HttpError(502, 'EXPIRY_UNAVAILABLE', `Dhan did not return any active ${u.label} option expiries.`);
    return value;
  }));
}

/**
 * Keep Power Scalper's slow first load warm: Dhan's instrument master and each connected Dhan account's
 * expiry list. Without it the first open after a restart, the morning token renewal or a new day waits for
 * both (and for Dhan's 3-second gap before the chain call): 5–10 s. Cached entries cost no Dhan call.
 */
let scalperPage = null;   // the /api/scalper handler (set by scalperRoutes)

/**
 * Shared market data: keep what Power Scalper opens with (the index, its nearest expiry's chain and ATM CE/PE
 * charts, 5-minute) loaded for everyone, so a first open reads the cache: every 20 s in market hours, else 10 min.
 */
function startSharedWarmup() {
  let last = 0;
  const tick = async () => {
    const src = sharedSource();
    if (!src || !scalperPage || (!marketOpen() && Date.now() - last < 10 * 60_000)) return;
    last = Date.now();
    const keys = new Set(['NIFTY', ...stmt(`SELECT algo_underlying FROM broker_accounts WHERE status = 'connected'`).all()
      .flatMap(a => String(a.algo_underlying || '').split(',')).map(k => k.trim()).filter(k => UNDERLYINGS[k])]);
    for (const key of keys) {
      try { await scalperPage({ warm: true, user: { id: src.userId }, query: { interval: '5', underlying: key }, params: {}, headers: {} }); }
      catch { /* the page loads it itself */ }
    }
  };
  const first = setTimeout(tick, 8_000), timer = setInterval(tick, 20_000);
  first.unref?.(); timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}

export function startScalperWarmup({ everyMs = 10 * 60_000 } = {}) {
  const stopShared = startSharedWarmup();
  const warm = async () => {
    indexOptionInstruments().catch(() => {});
    const accounts = stmt(`SELECT user_id, algo_underlying FROM broker_accounts WHERE broker = 'dhan' AND status = 'connected' AND token_enc IS NOT NULL`).all();
    for (const a of accounts) {
      let adapter; try { adapter = requireDhan(a.user_id); } catch { continue; }
      const keys = new Set(['NIFTY', ...String(a.algo_underlying || '').split(',').map(k => k.trim()).filter(Boolean)]);
      for (const key of keys) { try { await loadExpiries(a.user_id, adapter, underlyingFor(key)); } catch { /* the page retries */ } }
    }
  };
  const first = setTimeout(warm, 5_000), timer = setInterval(warm, everyMs);
  first.unref?.(); timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); stopShared(); };
}

export function scalperRoutes(r) {
  r.get('/api/scalper/backtest-capabilities', async ctx => ({ optionsData:await optionDataAvailability(ctx.user.id), optionExpiries:ORB5_EXPIRIES,
    orb5:{ defaults:{ ...ORB5_DEFAULTS, options:ORB5_OPTION_DEFAULTS }, maxOptionDays:ORB5_LIMITS.maxOptionDays }, gap:gapCapabilities(ctx.user.id), ema915:{ defaults:ema915Defaults(ctx.user.id) }, custom:customCapabilities(ctx.user.id) }));
  // (gap.coverage is also the stored-history range ORB's weekly actual-options runs read locally.)
  r.get('/api/scalper/signal-risk', ctx => scalperSignalRisk(ctx.user.id));
  r.get('/api/scalper/backtest-candles', async ctx => {
    limit(`scalper-backtest:${ctx.user.id}`, 12, 60_000);
    const adapter = requireDhan(ctx.user.id);
    const now=Date.now();
    const startDate=ctx.query.startDate, endDate=ctx.query.endDate;
    const {oneMinute,fiveMinute,asOf,cached}=await loadBacktestCandles(adapter,startDate,endDate,ctx.query.strategy,now,ctx.query.exitLogic||'horizon');
    return {oneMinute:oneMinute.map(candle=>({...candle,time:candle.time*1000})),fiveMinute:fiveMinute.map(candle=>({...candle,time:candle.time*1000})),startDate,endDate,asOf,cached};
  });
  r.get('/api/scalper/backtest-runs', ctx => stmt('SELECT * FROM backtest_runs WHERE user_id=? ORDER BY id DESC LIMIT 20').all(ctx.user.id).map(savedBacktest));
  r.post('/api/scalper/backtest-runs', async ctx => {
    limit(`scalper-backtest-save:${ctx.user.id}`,6,60_000);
    const {strategy,startDate,endDate,horizon}=ctx.body;
    if(strategy==='orb5') return runOrb5Backtest(ctx);
    if(strategy==='gap') return runGapBacktest(ctx);
    if(strategy==='ema915') return runEma915Backtest(ctx);
    if(strategy==='custom') return runCustomBacktest(ctx);
    const exitLogic=ctx.body.exitLogic||'horizon';
    if(!['openingRange','previousDay','ema45'].includes(strategy)) throw bad('INVALID_BACKTEST_STRATEGY','Choose a supported backtest strategy.');
    if(!['horizon','emaZone','swingSL','levelReject'].includes(exitLogic)) throw bad('INVALID_BACKTEST_EXIT','Choose a supported exit rule.');
    const stopLogic=ctx.body.stopLogic||'none';
    if(!STOP_RULES.includes(stopLogic)) throw bad('INVALID_BACKTEST_STOP','Choose a supported stop-loss rule.');
    if(stopLogic==='breakoutCandle'&&strategy!=='openingRange') throw bad('INVALID_BACKTEST_STOP','The breakout-candle stop applies to the opening-range breakout strategy.');
    if(![5,10,15,30].includes(Number(horizon))) throw bad('INVALID_BACKTEST_HORIZON','Choose a supported exit horizon.');
    const now=Date.now(); backtestRange(startDate,endDate,ist(now).day);
    // Option mode replays each index trade on the ATM option of the 2nd weekly expiry, in rupees.
    const resultMode=ctx.body.resultMode||'index', capital=Number(ctx.body.capital??OPTION_BACKTEST.defaultCapital);
    if(!['index','option'].includes(resultMode)) throw bad('INVALID_BACKTEST_MODE','Choose index points or option rupees.');
    const sizing=ctx.body.sizing||'compound';
    if(resultMode==='option') {
      if(!OPTION_BACKTEST.sizings.includes(sizing)) throw bad('INVALID_BACKTEST_SIZING','Choose compounding or fixed capital.');
      if(!OPTION_BACKTEST.exitRules.includes(exitLogic)) throw bad('INVALID_BACKTEST_EXIT','Option backtests exit on the option chart: choose fixed time, previous swing stop or level rejection.');
      if(!(capital>=1000&&capital<=10_000_000)) throw bad('INVALID_BACKTEST_CAPITAL','Enter capital between ₹1,000 and ₹1,00,00,000.');
      const days=(Date.parse(`${endDate}T00:00:00Z`)-Date.parse(`${startDate}T00:00:00Z`))/86_400_000+1;
      if(days>OPTION_BACKTEST.maxDays) throw bad('BACKTEST_RANGE_TOO_LARGE',`Option backtests load expired-option candles for every trade; choose up to ${OPTION_BACKTEST.maxDays} days.`);
    }
    const history=await loadBacktestCandles(requireDhan(ctx.user.id),startDate,endDate,strategy,now,exitLogic);
    const candidates=strategy==='previousDay' ? previousDayBreakoutSignals(history.oneMinute,{now})
      : strategy==='ema45' ? ema45HammerSignals(history.oneMinute,{now})
        : openingRangeFirstTradeSignals(history.oneMinute,history.fiveMinute,{now});
    const start=Date.parse(`${startDate}T00:00:00+05:30`)/1000,end=Date.parse(`${endDate}T23:59:59+05:30`)/1000;
    const signals=candidates.filter(row=>row.time>=start&&row.time<=end);
    // Index mode: SL and exit on the index. Option mode reuses only the entry signals (below).
    const metrics=backtestSignals(signals,history.oneMinute,{horizonBars:Number(horizon),exitLogic:resultMode==='option'&&exitLogic!=='horizon'?'horizon':exitLogic,stopLogic:resultMode==='option'?'none':stopLogic});
    let optionCandles=null;
    if(resultMode==='option') {
      const adapter=requireDhan(ctx.user.id), today=ist(now).day;
      const loadDay=async(day,option,offset)=>{
        const strike=offset===0?'ATM':`ATM${offset>0?'+':''}${offset}`;
        try {
          const snapshot=await cachedMarketData(scopeOf(adapter),`rolling:${OPTION_BACKTEST.expiryCode}:${day}:${option}:${strike}`,day===today?30_000:6*60*60_000,
            ()=>dataCall(()=>adapter.rollingOption({expiryCode:OPTION_BACKTEST.expiryCode,strike,option,fromDate:day,toDate:shiftDay(day,1)})));
          return snapshot.value.filter(row=>backtestDay.format(new Date(row.time*1000))===day);
        } catch(e) {
          // Account problems stop the run; a missing day only marks that trade unavailable.
          if(['DHAN_RECONNECT_REQUIRED','DHAN_DATA_API_REQUIRED'].includes(e?.code)) throw e;
          return [];
        }
      };
      // SL and exit are read from each option's own candles; the index only supplies the entry.
      const indexClose=new Map(history.oneMinute.map(candle=>[candle.time,candle.close]));
      const tradingDays=new Set(history.oneMinute.map(candle=>backtestDay.format(new Date(candle.time*1000))));
      const replay=await optionTrades(signals,{loadDay,capital,stopLogic,sizing,exitLogic,horizonBars:Number(horizon),tradingDays,indexAt:time=>indexClose.get(time)});
      metrics.trades=replay.trades; metrics.option=replay.summary; optionCandles=replay.candles;
    }
    const rangeBars=history.fiveMinute.filter(candle=>candle.time>=start&&candle.time<=end);
    const rangeSessions=countOpeningRangeSessions(rangeBars,{now});
    const tradedDays=new Set(metrics.trades.map(trade=>backtestDay.format(new Date(trade.time*1000))));
    const chartCandles={};
    const emaByTime=exitLogic==='emaZone'?new Map(emaIndicatorRows(history.oneMinute).map(row=>[row.time,{ema45:row.ema45,ema105:row.ema105}])):null;
    for(const candle of history.oneMinute) {
      const day=backtestDay.format(new Date(candle.time*1000));
      if(tradedDays.has(day)) (chartCandles[day]??=[]).push(emaByTime?{...candle,...emaByTime.get(candle.time)}:candle);
    }
    // Each option trade's premium candles (the whole session for its strike) for the trade chart.
    for(const [time,rows] of Object.entries(optionCandles||{})) chartCandles[`option:${time}`]=rows;
    const visibleBars=history.oneMinute.filter(candle=>candle.time>=start&&candle.time<=end).length;
    const result=tx(()=>{
      const inserted=stmt(`INSERT INTO backtest_runs
        (user_id,strategy,start_date,end_date,horizon_bars,created_at,as_of,one_minute_bars,range_sessions,signal_count,metrics_json,candles_gzip,exit_logic,stop_logic)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(ctx.user.id,strategy,startDate,endDate,Number(horizon),now,history.asOf,visibleBars,rangeSessions,signals.length,
          JSON.stringify(metrics),gzipSync(Buffer.from(JSON.stringify(chartCandles))),exitLogic,stopLogic);
      stmt(`DELETE FROM backtest_runs WHERE user_id=? AND id NOT IN
        (SELECT id FROM backtest_runs WHERE user_id=? ORDER BY id DESC LIMIT 20)`).run(ctx.user.id,ctx.user.id);
      return stmt('SELECT * FROM backtest_runs WHERE id=? AND user_id=?').get(Number(inserted.lastInsertRowid),ctx.user.id);
    })();
    return savedBacktest(result);
  });
  r.get('/api/scalper/backtest-runs/:id/chart', async ctx => {
    const id=Number(ctx.params.id),index=Number(ctx.query.tradeIndex);
    if(!Number.isSafeInteger(id)||id<1||!Number.isSafeInteger(index)||index<0) throw bad('INVALID_BACKTEST_TRADE','Choose a saved trade chart.');
    const row=stmt('SELECT * FROM backtest_runs WHERE id=? AND user_id=?').get(id,ctx.user.id);
    if(!row) throw new HttpError(404,'BACKTEST_NOT_FOUND','Saved backtest not found.');
    const trade=JSON.parse(row.metrics_json).trades[index];
    if(!trade) throw bad('INVALID_BACKTEST_TRADE','That trade is not in this saved backtest.');
    const day=backtestDay.format(new Date(trade.time*1000));
    let candles=JSON.parse(gunzipSync(row.candles_gzip).toString('utf8'))[day]||[],emaApproximate=false;
    if((row.exit_logic||'horizon')==='emaZone'&&candles.length&&!candles.some(candle=>Number.isFinite(candle.ema45)&&Number.isFinite(candle.ema105))) {
      let values;
      try {
        const history=await loadBacktestCandles(requireDhan(ctx.user.id),day,day,row.strategy,Date.now(),'emaZone');
        values=emaIndicatorRows(history.oneMinute);
      } catch {
        values=emaIndicatorRows(candles);emaApproximate=true;
      }
      const byTime=new Map(values.map(row=>[row.time,{ema45:row.ema45,ema105:row.ema105}]));
      candles=candles.map(candle=>({...candle,...byTime.get(candle.time)}));
      if(candles.some(candle=>!Number.isFinite(candle.ema45)||!Number.isFinite(candle.ema105))) {
        const fallback=new Map(emaIndicatorRows(candles).map(row=>[row.time,{ema45:row.ema45,ema105:row.ema105}]));
        candles=candles.map(candle=>({...candle,...fallback.get(candle.time)}));emaApproximate=true;
      }
    }
    const optionCandles=trade.option?JSON.parse(gunzipSync(row.candles_gzip).toString('utf8'))[`option:${trade.time}`]||[]:[];
    return {trade,day,candles,optionCandles,strategy:row.strategy,exitLogic:row.exit_logic||'horizon',stopLogic:row.stop_logic||'none',emaApproximate};
  });
  r.post('/api/scalper/signal', async ctx => {
    return scanScalperSignal(ctx.user.id, ctx.ip, {
      adapter: requireDhan(ctx.user.id),
      optionRequest: fn => optionRequest(ctx.user.id, fn),
      normalizeCandles: normalizeScalperCandles,
    });
  });
  r.get('/api/scalper', scalperPage = async ctx => {
    if (!ctx.warm) limit(`scalper:${ctx.user.id}`, 15, 60_000);
    const adapter = requireDhan(ctx.user.id);
    const interval = ['1', '5', '15', '25', '60'].includes(ctx.query.interval) ? ctx.query.interval : '5';
    const fresh = ctx.query.fresh === '1';
    // charts=0 returns only the chain (expiry switch); the page loads the option charts separately
    // so the chain is not held behind Dhan's serialized candle-history requests.
    const withCharts = ctx.query.charts !== '0';
    const u = underlyingFor(ctx.query.underlying), index = { securityId:u.securityId, exchangeSegment:'IDX_I', instrument:'INDEX' };
    // Index history does not depend on the expiry/chain. Capture rejection immediately
    // so a failed chain request cannot leave an unhandled parallel history request.
    const spotLoading = withCharts ? chartHistory(adapter, index, interval, fresh)
      .then(result => ({ result }), error => ({ error })) : null;
    const openingRangeLoading = !withCharts ? null : interval === '5'
      ? spotLoading
      : chartHistory(adapter, index, '5', fresh)
        .then(result => ({ result }), error => ({ error }));
    const { value: listedExpiries } = await loadExpiries(ctx.user.id, adapter, u);
    const clock=ist(),expiries=activeNiftyExpiries(listedExpiries,clock);
    if (!expiries.length) throw new HttpError(502, 'EXPIRY_UNAVAILABLE', `Dhan did not return an upcoming ${u.label} option expiry. Refresh or check the Dhan data connection.`);
    const expiry=resolveNiftyExpiry(ctx.query.expiry,expiries,clock,u.expiryRule);
    if (!expiry) throw bad('INVALID_EXPIRY', `Choose an active upcoming ${u.label} expiry.`);
    const chainSnapshot = await orLastGood(`${ownerOf(ctx.user.id)}:chain:${u.key}:${expiry}`, () => cachedMarketData(scopeOf(adapter), `chain:${u.key}:${ist().day}:${expiry}`, 5_000, async () => {
      const value = await dataCall(() => optionRequest(ctx.user.id, () => adapter.optionChain({ underlyingScrip: Number(u.securityId), underlyingSeg: 'IDX_I', expiry })));
      if (!value?.oc || !Object.keys(value.oc).length || !Number(value.last_price)) throw new HttpError(502, 'MARKET_DATA_UNAVAILABLE', `Dhan returned no option contracts for ${expiry}. Refresh or choose another expiry.`);
      return value;
    }, { fresh }));
    const chain = chainSnapshot.value;
    const staleWarning = chainSnapshot.stale ? `Dhan is not responding right now. Showing the option chain from ${fmtIst(chainSnapshot.asOf).slice(11, 16)} IST; it refreshes automatically.` : null;

    const now = Date.now();
    // Include the recent sessions so a closed market or the first minutes after open still has
    // useful chart history. Dhan returns only completed/current-session bars for a same-day range.
    const strikes = Object.entries(chain.oc).map(([strike, sides]) => ({
      strike: Number(strike),
      ce: contract(sides.ce, Number(strike), 'CE', expiry, u),
      pe: contract(sides.pe, Number(strike), 'PE', expiry, u),
    })).filter(x => Number.isFinite(x.strike)).sort((a, b) => a.strike - b.strike);
    const atm = strikes.reduce((best, row) => !best || Math.abs(row.strike - Number(chain.last_price)) < Math.abs(best.strike - Number(chain.last_price)) ? row : best, null);
    allowScalperContracts(ctx.user.id, expiry, strikes, u);
    if (!allowedByUser.has(ctx.user.id)) allowedByUser.set(ctx.user.id, new Map());
    allowedByUser.get(ctx.user.id).set(u.key, { expiry, underlying:u.key, indexId:u.securityId, segment:u.optionSegment, exchange:u.exchange,
      ids: new Set(strikes.flatMap(row => [row.ce?.securityId, row.pe?.securityId]).filter(Boolean).map(String)), at: now });
    const lotSize = await lotSizeFor(atm?.ce?.securityId || atm?.pe?.securityId, u.exchange);
    const market = { underlyingKey:u.key, optionSegment:u.optionSegment, underlyings:Object.values(UNDERLYINGS).map(({ key, label }) => ({ key, label })) };
    if (!withCharts) {
      return { lotSize, ...market,
        underlying: { symbol: u.label, key:u.key, securityId: u.securityId, exchangeSegment: 'IDX_I', ltp: Number(chain.last_price), candles: null },
        openingRange: null, expiry, expiries, strikes,
        selectedCharts: { atm: atm?.strike ?? null, ce: null, pe: null }, selectedOpeningRanges: {},
        marketOpen: marketOpen(), asOf: chainSnapshot.asOf, stale: !!chainSnapshot.stale, historyWarning: staleWarning,
        broker: { label: 'Dhan', connected: true, ordersAllowed: getPermissions(ctx.user.id)?.ordersAllowed ?? null },
        feed: { source: 'Dhan Data APIs', mode: 'live websocket', timeframe: `${interval}m` },
      };
    }
    const specs = [
      { securityId: atm?.ce?.securityId || u.securityId, exchangeSegment: atm?.ce ? u.optionSegment : 'IDX_I', instrument: atm?.ce ? 'OPTIDX' : 'INDEX' },
      { securityId: atm?.pe?.securityId || u.securityId, exchangeSegment: atm?.pe ? u.optionSegment : 'IDX_I', instrument: atm?.pe ? 'OPTIDX' : 'INDEX' },
    ];
    const settled = await Promise.allSettled([
      spotLoading.then(({ result, error }) => { if (error) throw error; return result; }),
      openingRangeLoading.then(({ result, error }) => { if (error) throw error; return result; }),
      ...specs.map(spec => chartHistory(adapter, spec, interval, fresh)),
      ...specs.map((spec, i) => interval === '5'
        ? Promise.resolve(null)
        : chartHistory(adapter, spec, '5', fresh)),
    ]);
    // Account problems must still stop the page; a slow or throttled history request must not.
    // The chain is already loaded, so show it with an empty chart and let the page retry that chart.
    const failures = settled.filter(x => x.status === 'rejected').map(x => x.reason);
    const fatal = failures.find(e => ['DHAN_RECONNECT_REQUIRED', 'DHAN_DATA_API_REQUIRED', 'DHAN_REQUIRED'].includes(e?.code));
    if (fatal) throw fatal;
    const empty = { value: [], asOf: null };
    const [spot, rangeData, ce, pe, ceRangeData, peRangeData] = settled.map(x => x.status === 'fulfilled' ? x.value : empty);
    const openingRange = openingRangeBreakout(rangeData.value);
    const selectedOpeningRanges = [ceRangeData, peRangeData].map((snapshot, i) =>
      openingRangeBreakout(snapshot?.value || (interval === '5' ? i === 0 ? ce.value : pe.value : [])));

    return { ...market,
      underlying: { symbol: u.label, key:u.key, securityId: u.securityId, exchangeSegment: 'IDX_I', ltp: Number(chain.last_price),
        candles: spot.value },
      openingRange,
      expiry, expiries, strikes,
      selectedCharts: { atm: atm?.strike ?? null, ce: ce.value, pe: pe.value },
      selectedOpeningRanges: { ce:selectedOpeningRanges[0], pe:selectedOpeningRanges[1] },
      marketOpen: marketOpen(), asOf: chainSnapshot.asOf,
      historyAsOf: { spot:spot.asOf, ce:ce.asOf, pe:pe.asOf },
      lotSize,
      stale: !!chainSnapshot.stale,
      historyWarning: staleWarning || (failures.length ? 'Some chart history did not load from Dhan. It will retry automatically.' : null),
      broker: { label: 'Dhan', connected: true, ordersAllowed: getPermissions(ctx.user.id)?.ordersAllowed ?? null },
      feed: { source: 'Dhan Data APIs', mode: 'live websocket', timeframe: `${interval}m` },
    };
  });

  // Funds each order ticket would need, from Dhan's margin calculator. Read-only: places no order.
  r.get('/api/scalper/margin', async ctx => {
    limit(`scalper-margin:${ctx.user.id}`, 40, 60_000);
    const adapter = requireDhan(ctx.user.id);
    const securityId = String(ctx.query.securityId || ''), lots = Number(ctx.query.lots), price = Number(ctx.query.price);
    const allowed = allowedFor(ctx.user.id, securityId, ctx.query.underlying);
    if (!allowed) throw bad('INVALID_INSTRUMENT', 'Reload the option chain before checking margin.');
    if (!Number.isSafeInteger(lots) || lots < 1 || lots > 1000) throw bad('INVALID_LOTS', 'Enter a whole number of lots.');
    if (!(price > 0)) throw bad('INVALID_PRICE', 'No live price for this contract yet.');
    const lotSize = await lotSizeFor(securityId, allowed.exchange || 'NSE');
    if (!lotSize) throw new HttpError(503, 'LOT_SIZE_UNAVAILABLE', 'Lot size is not available yet. Try again in a few seconds.');
    const qty = lots * lotSize;
    const spec = { securityId, exchangeSegment:allowed.segment || 'NSE_FNO', qty, price, productType:'INTRADAY' };
    const [buy, sell] = await Promise.all(['BUY', 'SELL'].map(side => cachedMarketData(adapter, `margin:${securityId}:${side}:${qty}:${price.toFixed(2)}`, 15_000,
      () => dataCall(() => adapter.marginRequired({ ...spec, side })))));
    return { lotSize, lots, qty, price, buy:buy.value.total, sell:sell.value.total,
      available:Number.isFinite(sell.value.available) ? sell.value.available : buy.value.available, asOf:Math.min(buy.asOf, sell.asOf) };
  });

  r.get('/api/scalper/candles', async ctx => {
    limit(`scalper-candles:${ctx.user.id}`, 60, 60_000);
    const adapter = requireDhan(ctx.user.id);
    const securityId = String(ctx.query.securityId || '');
    const interval = ['1', '5', '15', '25', '60'].includes(ctx.query.interval) ? ctx.query.interval : '5';
    const index = isIndexId(securityId);
    const allowed = allowedFor(ctx.user.id, index ? null : securityId, ctx.query.underlying);
    if (!allowed) throw bad('INVALID_INSTRUMENT', 'Reload the option chain before requesting this chart.');
    const spec = { securityId, exchangeSegment: index ? 'IDX_I' : allowed.segment || 'NSE_FNO', instrument: index ? 'INDEX' : 'OPTIDX' };
    const [snapshot, rangeSnapshot] = await Promise.all([
      chartHistory(adapter, spec, interval, ctx.query.fresh === '1'),
      interval === '5' ? null : chartHistory(adapter, spec, '5', ctx.query.fresh === '1'),
    ]);
    return { candles: snapshot.value, interval, asOf: snapshot.asOf,
      openingRange: openingRangeBreakout(rangeSnapshot?.value || snapshot.value) };
  });
}

function contract(raw, strike, option, expiry, u = UNDERLYINGS.NIFTY) {
  if (!raw) return null;
  return {
    securityId: String(raw.security_id || ''), exchangeSegment: u.optionSegment, symbol: `${u.symbol} ${expiry} ${strike} ${option}`, underlying: u.symbol,
    strike, option, expiry, ltp: Number(raw.last_price) || 0,
    bid: Number(raw.top_bid_price) || 0, ask: Number(raw.top_ask_price) || 0,
    bidQty: Number(raw.top_bid_quantity) || 0, askQty: Number(raw.top_ask_quantity) || 0,
    volume: Number(raw.volume) || 0, oi: Number(raw.oi) || 0, iv: Number(raw.implied_volatility) || 0,
    delta: Number(raw.greeks?.delta) || 0, change: Number(raw.last_price) - Number(raw.previous_close_price || raw.last_price),
  };
}
