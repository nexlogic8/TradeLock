// Gap wick 09:15, on paper: the live Gap open 09:15 decision (same ATM gap rule, same ITM2 contract, same 09:16 exit),
// but not a blind buy on the first tick. Inside the 09:15 minute it waits for NIFTY to make a wick against the trade and
// turn: for a CE, NIFTY trades below its 09:15 open and then comes back above it; for a PE, above it and back below.
// It buys then (on paper), with the stop one tick below the option's lowest price so far (the low of its wick). No
// wick by 09:15:59 → no trade. Prices are live (feed ticks; the minute in progress is built tick by tick); nothing is
// ever sent to a broker. Each step is kept in paper_trades, so a restart resumes the day.
// (Internally still "retest": the account switch is retest_paper_on, the strategy key gapRetest.)
import { stmt } from '../../db/index.js';
import { ist, regularTradingDay as isTradingDay } from '../../lib/time.js';
import { adapterFor } from '../broker/registry.js';
import { getBook } from '../broker/book.js';
import { getRules } from '../rules/service.js';
import { capitalLimit } from '../rules/limits.js';
import { dayState, capitalFor } from '../risk/service.js';
import { notify } from '../notifications/service.js';
import { audit } from '../audit/service.js';
import { underlyingFor } from './underlyings.js';
import { optionCharges } from './orb5-options.js';
import { AUTO, FEED, GAP_LIVE, algoIndices, atmContract, gapPick, gapPrefetch, nearIds, optionMeta, riskLeft, strikeFrom } from './autotrade.js';

export const STRATEGY = 'Gap wick 09:15';
export const RETEST_DEFAULTS = Object.freeze({ windowMin: 15, slPct: 3 });   // the earlier retest variant's settings (kept for old rows)
// FAST_MS through the 09:15 minute (the wick and the turn are seconds apart), SLOW_MS otherwise. QUOTE_AFTER_MS: its
// own quote request only after the live Gap trade's first one (Dhan allows one quote request a second).
const P = { fastMs: 200, slowMs: 1_000, quoteAfterMs: 2_300, decideUntilMs: 20_000, quoteEveryMs: 2_000, prefetchLeadMs: 70_000, exitAfterMs: 60_000 };
const TICK_FRESH_MS = 3_000, TICK = 0.05;
const round2 = n => Math.round(n * 100) / 100;
const roundTick = (n, t = TICK) => Math.round(Math.round(n / t) * t * 10_000) / 10_000;
const clock = ms => new Date(ms + 19_800_000).toISOString().slice(11, 23);

/** The account's saved settings of the earlier retest variant (unused by the wick entry). */
export function retestConfig(acct) {
  let c = {};
  try { c = JSON.parse(acct?.retest_cfg || '{}') || {}; } catch { c = {}; }
  const n = (v, lo, hi, d) => (Number.isFinite(Number(v)) && Number(v) >= lo && Number(v) <= hi ? Number(v) : d);
  return { windowMin: Math.round(n(c.windowMin, 1, 60, RETEST_DEFAULTS.windowMin)), slPct: n(c.slPct, 0.5, 50, RETEST_DEFAULTS.slPct) };
}

const row = (uid, day) => stmt('SELECT * FROM paper_trades WHERE user_id = ? AND day = ? AND strategy = ?').get(uid, day, STRATEGY);
const update = (id, patch) => {
  const keys = Object.keys(patch);
  if (keys.length) stmt(`UPDATE paper_trades SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(k => patch[k]), id);
};
const say = (uid, level, title, body) => notify(uid, { kind: 'risk', level, title: `Paper: ${title}`, body: `${body} (paper trade: no order was sent)` });

/** Today's and earlier paper trades, newest first, for the Algo page. */
export function paperTrades(userId, limit = 120) {
  return stmt(`SELECT id, day, strategy, direction, symbol, lots, qty, level, entry_price AS entryPrice, sl_price AS slPrice, exit_price AS exitPrice,
      pnl, charges, status, reason, created_at AS createdAt, entered_at AS enteredAt, closed_at AS closedAt
      FROM paper_trades WHERE user_id = ? ORDER BY day DESC, id DESC LIMIT ?`).all(userId, limit);
}

/** The live price of a contract: a fresh feed tick, else a Dhan quote (at most every QUOTE_EVERY_MS). */
async function priceOf(uid, adapter, seg, id, now, memo) {
  const t = FEED.tick(uid, `${seg}:${id}`, { since: now - TICK_FRESH_MS });
  if (t?.ltp > 0) return { ltp: t.ltp, open: t.dayOpen || null, at: t.at };
  if (memo.quoteAt && now - memo.quoteAt < P.quoteEveryMs) return memo.quote || null;
  memo.quoteAt = now;
  const q = await adapter.quote?.(seg, id).catch(() => null);
  memo.quote = q?.ltp > 0 ? { ltp: q.ltp, open: q.open || null, at: now } : null;
  return memo.quote;
}

/**
 * The 09:15 decision, as the live Gap trade: the ATM CE / PE opening premiums (first ticks since 09:15:00, else one
 * quote request from QUOTE_AFTER_MS) against their previous session's last trade; the gap side's ITM2 contract.
 */
async function decide(acct, adapter, u, open, now, memo) {
  const uid = acct.user_id, seg = u.optionSegment;
  const prep = await gapPrefetch(acct, adapter, u, now).catch(() => null);
  if (!prep?.chain) return now > open + P.decideUntilMs ? { skip: 'the option chain was not available from Dhan' } : null;
  const idx = FEED.tick(uid, `IDX_I:${u.securityId}`, { since: open - 10 * 60_000 });
  let spot = idx?.ltp > 0 ? idx.ltp : Number(prep.chain.last_price) || 0;
  const atmAt = s => Object.fromEntries(['CE', 'PE'].map(o => [o, atmContract({ ...prep.chain, last_price: s }, o)]));
  let atm = atmAt(spot);
  const opt = {};
  for (const c of Object.values(atm)) {
    const t = c && FEED.tick(uid, `${seg}:${c.securityId}`, { since: open });
    if (t?.ltp > 0 && t.dayOpen > 0) opt[c.securityId] = { open: t.dayOpen, ltp: t.ltp };
  }
  if (Object.keys(opt).length < 2 && now >= open + P.quoteAfterMs && !memo.decideQuoted && adapter.quotes) {
    memo.decideQuoted = true;
    const qs = await adapter.quotes({ IDX_I: [u.securityId], [seg]: nearIds(prep.chain, spot) }).catch(() => null);
    const q = qs?.IDX_I?.[String(u.securityId)];
    if (q?.ltp > 0) { spot = q.ltp; atm = atmAt(spot); memo.indexOpen ??= q.open || null; }
    for (const [id, x] of Object.entries(qs?.[seg] || {})) if (x?.open > 0) opt[id] ??= { open: x.open, ltp: x.ltp };
  }
  if (!Object.values(atm).every(c => c && opt[c.securityId]?.open > 0)) return now > open + P.decideUntilMs ? { skip: 'no opening price for the ATM options by 09:15:20' } : null;
  const sides = Object.fromEntries(Object.entries(atm).map(([s, c]) => {
    const last = prep.prevLast?.get(String(c.securityId));
    return [s, { strike: c.strike, prev: last ?? (c.ltp || null), open: opt[c.securityId].open, ltp: opt[c.securityId].ltp }];
  }));
  const g = gapPick(sides, { requireGreen: AUTO.gap.requireGreen });
  if (g.skip) return { skip: `no gap trade: ${g.skip}`, sides };
  const c = strikeFrom(prep.chain, atm[g.direction], g.direction, GAP_LIVE.strike || 0);
  if (!c) return { skip: `no ITM${GAP_LIVE.strike} ${g.direction} in the ${prep.expiry} option chain` };
  return { direction: g.direction, gapPct: g.gapPct, contract: c, expiry: prep.expiry, sides };
}

/** Lots for an entry: Capital per trade (Risk rules) when on, else 80% of the funds, as the live Gap trade; and the day's stop-loss left. */
function sizeAt(uid, entry, lotSize) {
  const s = dayState(uid), rules = getRules(uid).active, capital = capitalFor(uid, s), funds = Number(getBook(uid).funds?.available) || capital || 0;
  const cap = capitalLimit(rules, capital), fits = funds * 0.98 / (1 + AUTO.gap.blockPad);
  const spend = Math.min(cap != null ? cap : funds * AUTO.gap.fundsUse, fits);
  const daily = rules.maxLoss?.on ? (rules.maxLoss.mode === 'percent' ? capital * rules.maxLoss.value / 100 : rules.maxLoss.value) : null;
  return { lots: Math.floor(spend / (entry * lotSize) + 1e-9), budget: riskLeft(daily, s.realized + s.unrealized) };
}

/** NIFTY's 09:15 open and the 09:15 minute so far (built tick by tick): low and high, and the last price. */
function indexMinute(uid, u, open, memo) {
  const key = `IDX_I:${u.securityId}`, t = FEED.tick(uid, key, { since: open }), bar = FEED.bar(uid, key, open);
  const ref = t?.dayOpen > 0 ? t.dayOpen : memo.indexOpen > 0 ? memo.indexOpen : bar?.open;
  if (!(ref > 0) || !bar || !(t?.ltp > 0)) return null;
  return { open: ref, low: Math.min(bar.low, t.ltp), high: Math.max(bar.high, t.ltp), ltp: t.ltp };
}

/** One step of the day for one account (every FAST_MS through 09:15, else SLOW_MS). */
export async function paperStep(acct, { now = Date.now(), adapter = adapterFor(acct), memo = {}, instruments = optionMeta } = {}) {
  const uid = acct.user_id, day = ist(now).day, open = Date.parse(`${day}T09:15:00+05:30`);
  const u = underlyingFor(algoIndices(acct)[0]), seg = u.optionSegment;
  let r = row(uid, day);
  if (!r) {
    if (now < open) { if (now >= open - P.prefetchLeadMs) gapPrefetch(acct, adapter, u, now).catch(() => {}); return { waiting: 'the open' }; }
    if (now > open + P.decideUntilMs + 5_000) return { skipped: 'started after 09:15:25' };   // switched on late: the decision time has passed
    const d = await decide(acct, adapter, u, open, now, memo);
    if (!d) return { waiting: 'opening prices' };
    if (d.skip) {
      stmt(`INSERT OR IGNORE INTO paper_trades (user_id, day, strategy, status, reason, detail, created_at) VALUES (?, ?, ?, 'skipped', ?, ?, ?)`)
        .run(uid, day, STRATEGY, d.skip, JSON.stringify({ sides: d.sides || null }), now);
      say(uid, 'info', `${STRATEGY}: no trade today`, `${u.label}: ${d.skip}.`);
      return { skipped: d.skip };
    }
    const symbol = `${u.symbol} ${d.expiry} ${d.contract.strike} ${d.direction}`;
    stmt(`INSERT OR IGNORE INTO paper_trades (user_id, day, strategy, direction, symbol, security_id, exchange_segment, status, reason, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'watching', ?, ?, ?)`).run(uid, day, STRATEGY, d.direction, symbol, d.contract.securityId, seg,
      `Waiting for NIFTY to wick ${d.direction === 'CE' ? 'below' : 'above'} its 09:15 open and turn back, by 09:15:59`, JSON.stringify({ gapPct: d.gapPct, sides: d.sides }), now);
    r = row(uid, day);
  }
  if (r.status === 'skipped' || r.status === 'closed') return { done: r.status };

  if (r.status === 'watching') {
    if (now >= open + P.exitAfterMs) {
      update(r.id, { status: 'skipped', reason: `No NIFTY wick ${r.direction === 'CE' ? 'below' : 'above'} the 09:15 open and turn back within the 09:15 minute`, closed_at: now });
      say(uid, 'info', `${STRATEGY}: no trade today`, `${r.symbol}: NIFTY did not wick against the ${r.direction} and turn back within the 09:15 minute.`);
      return { skipped: 'no wick' };
    }
    const m = indexMinute(uid, u, open, memo);
    if (!m) return { waiting: 'live NIFTY ticks' };
    const ce = r.direction === 'CE', wick = ce ? m.low < m.open : m.high > m.open, turned = wick && (ce ? m.ltp > m.open : m.ltp < m.open);
    if (!turned) return { waiting: wick ? 'the turn back across the open' : 'the wick' };
    const p = await priceOf(uid, adapter, r.exchange_segment || seg, r.security_id, now, memo);
    if (!(p?.ltp > 0)) return { waiting: 'an option price' };
    const meta = (await instruments(u)).get(String(r.security_id));
    const lotSize = meta?.lotSize || 65, tick = meta?.tickSize || TICK;
    const entry = p.ltp, optLow = Math.min(FEED.bar(uid, `${r.exchange_segment || seg}:${r.security_id}`, open)?.low ?? entry, entry);
    const stop = Math.max(tick, roundTick(Math.min(optLow, entry) - tick, tick));
    const { lots: byCapital, budget } = sizeAt(uid, entry, lotSize);
    // The stop risks at most the day's stop-loss left.
    const lots = Math.min(byCapital, budget > 0 ? Math.floor(budget / ((entry - stop) * lotSize) + 1e-9) : byCapital);
    if (lots < 1) {
      update(r.id, { status: 'skipped', reason: `1 lot at ${entry} is more than the capital per trade, the funds or the day's stop-loss left`, closed_at: now });
      return { skipped: 'size' };
    }
    const qty = lots * lotSize, wickAt = ce ? m.low : m.high;
    update(r.id, { status: 'open', level: wickAt, entry_price: entry, sl_price: stop, lots, qty, entered_at: now,
      reason: `NIFTY wicked to ${wickAt} (open ${m.open}) and turned back: bought at ${entry} (${clock(now)})`,
      detail: JSON.stringify({ ...JSON.parse(r.detail || '{}'), indexOpen: m.open, wick: wickAt, optionLow: optLow }) });
    audit(uid, 'paper.entered', { id: r.id, strategy: STRATEGY, symbol: r.symbol, entry, stop, qty });
    say(uid, 'ok', `bought ${lots} lot${lots > 1 ? 's' : ''} ${r.symbol}`, `${STRATEGY} ${r.direction}: NIFTY wicked to ${wickAt} against its 09:15 open ${m.open} and turned back. Entry ${entry}, stop ${stop} (below the option's low ${optLow}); exit at 09:16.`);
    return { entered: entry };
  }

  // Open: the stop, or the fixed exit at 09:16:00 (as the live Gap trade).
  const p = await priceOf(uid, adapter, r.exchange_segment || seg, r.security_id, now, memo);
  if (!(p?.ltp > 0)) return { open: null, waiting: 'a price' };
  const why = p.ltp <= r.sl_price ? 'Stop-loss' : now >= open + P.exitAfterMs ? 'Fixed exit at 09:16' : null;
  if (!why) return { open: p.ltp };
  const exit = p.ltp, charges = round2(optionCharges(day, r.entry_price * r.qty, exit * r.qty).total), pnl = round2((exit - r.entry_price) * r.qty - charges);
  update(r.id, { status: 'closed', exit_price: exit, charges, pnl, closed_at: now, reason: `${why} (${clock(now)})` });
  audit(uid, 'paper.closed', { id: r.id, strategy: STRATEGY, exit, pnl, why });
  say(uid, pnl >= 0 ? 'ok' : 'warn', `${r.symbol} closed ${pnl >= 0 ? '+' : '−'}₹${Math.abs(Math.round(pnl)).toLocaleString('en-IN')}`, `${why}: sold at ${exit} (bought ${r.entry_price}), after charges.`);
  return { closed: exit, pnl };
}

/** Run the paper strategy for every account with it on and Algo Trading started, through the morning. */
export function startPaperTrading() {
  const busy = new Set(), memos = new Map();
  let slowAt = 0;
  const timer = setInterval(() => {
    const now = Date.now(), t = ist(now), day = t.day, open = Date.parse(`${day}T09:15:00+05:30`);
    if (!isTradingDay(now) || t.minutes < 9 * 60 + 13 || t.minutes > 9 * 60 + 30) return;
    const fast = now >= open - 1_000 && now <= open + P.exitAfterMs + 5_000;
    if (!fast && now - slowAt < P.slowMs) return;
    slowAt = now;
    let accounts;
    try {
      accounts = stmt(`SELECT * FROM broker_accounts WHERE retest_paper_on = 1 AND algo_on = 1 AND agent_on = 1 AND (broker = 'paper' OR (broker = 'dhan' AND token_enc IS NOT NULL))
        AND status IN ('connected', 'delayed', 'degraded')`).all();
    } catch (e) { console.error('[paper]', e.message); return; }
    for (const acct of accounts) {
      if (busy.has(acct.user_id)) continue;
      const key = `${acct.user_id}:${day}`;
      if (!memos.has(key)) memos.set(key, {});
      busy.add(acct.user_id);
      paperStep(acct, { now, memo: memos.get(key) }).catch(e => console.error('[paper]', e.message)).finally(() => busy.delete(acct.user_id));
    }
  }, P.fastMs);
  return () => clearInterval(timer);
}
