// Gap retest 09:15, on paper: the live Gap open 09:15 decision (same ATM gap rule, same ITM2 contract), but instead of
// buying at 09:15 it waits for the option to come back to its 09:15 open (within WINDOW_MIN minutes, from 09:16) and
// "buys" there. Stop SL_PCT below the entry (closer if the day's stop-loss allows less); exit on the first NIFTY
// 1-minute candle of the other colour, the stop, or the square-off. Prices are live (feed ticks, Dhan quotes as the
// fallback); nothing is ever sent to the broker. Each step is kept in paper_trades, so a restart resumes the day.
import { stmt } from '../../db/index.js';
import { ist, marketOpen, isTradingDay } from '../../lib/time.js';
import { adapterFor } from '../broker/registry.js';
import { getBook } from '../broker/book.js';
import { getRules } from '../rules/service.js';
import { capitalLimit } from '../rules/limits.js';
import { dayState, capitalFor } from '../risk/service.js';
import { notify } from '../notifications/service.js';
import { audit } from '../audit/service.js';
import { underlyingFor } from './underlyings.js';
import { optionCharges } from './orb5-options.js';
import { AUTO, FEED, GAP_LIVE, algoIndices, atmContract, gapPick, gapPrefetch, nearIds, optionMeta, riskLeft, squareOffTime, strikeFrom } from './autotrade.js';

export const STRATEGY = 'Gap retest 09:15';
export const RETEST_DEFAULTS = Object.freeze({ windowMin: 15, slPct: 3 });
// QUOTE_AFTER_MS: its own quote request only after the live Gap trade has decided (Dhan: one quote request a second).
const P = { tickMs: 1_000, decideAfterMs: 500, quoteAfterMs: 5_000, decideUntilMs: 20_000, quoteEveryMs: 2_000, prefetchLeadMs: 70_000 };
const TICK_FRESH_MS = 3_000, TICK = 0.05;
const round2 = n => Math.round(n * 100) / 100;
const roundTick = (n, t = TICK) => Math.round(Math.round(n / t) * t * 10_000) / 10_000;

/** The account's paper settings: retest window (minutes) and stop % below the entry. */
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
 * The 09:15 decision on paper: the ATM CE / PE opening premiums (first ticks since 09:15:00, else one quote request
 * from QUOTE_AFTER_MS) against their previous session's last trade, and the gap side's ITM2 contract with its 09:15 open.
 */
async function decide(acct, adapter, u, day, open, now, memo) {
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
    if (q?.ltp > 0) { spot = q.ltp; atm = atmAt(spot); }
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
  // The level the retest waits for: this contract's own 09:15 open.
  const own = opt[c.securityId] || await priceOf(uid, adapter, seg, c.securityId, now, memo);
  if (!(own?.open > 0)) return now > open + P.decideUntilMs ? { skip: `no 09:15 open for ${c.strike} ${g.direction}` } : null;
  return { direction: g.direction, gapPct: g.gapPct, contract: c, expiry: prep.expiry, level: own.open, sides };
}

/** Lots for an entry at `entry`: Capital per trade (Risk rules) when on, else 80% of the funds, as the live Gap trade. */
function sizeAt(uid, entry, lotSize) {
  const s = dayState(uid), rules = getRules(uid).active, capital = capitalFor(uid, s), funds = Number(getBook(uid).funds?.available) || capital || 0;
  const cap = capitalLimit(rules, capital), fits = funds * 0.98 / (1 + AUTO.gap.blockPad);
  const spend = Math.min(cap != null ? cap : funds * AUTO.gap.fundsUse, fits);
  const daily = rules.maxLoss?.on ? (rules.maxLoss.mode === 'percent' ? capital * rules.maxLoss.value / 100 : rules.maxLoss.value) : null;
  return { lots: Math.floor(spend / (entry * lotSize) + 1e-9), budget: riskLeft(daily, s.realized + s.unrealized) };
}

/** One step of the day for one account (every TICK_MS). */
export async function paperStep(acct, { now = Date.now(), adapter = adapterFor(acct), memo = {}, instruments = optionMeta } = {}) {
  const uid = acct.user_id, day = ist(now).day, open = Date.parse(`${day}T09:15:00+05:30`), cfg = retestConfig(acct);
  const u = underlyingFor(algoIndices(acct)[0]), seg = u.optionSegment;
  let r = row(uid, day);
  if (!r) {
    if (now < open + P.decideAfterMs) { if (now >= open - P.prefetchLeadMs) gapPrefetch(acct, adapter, u, now).catch(() => {}); return { waiting: 'the open' }; }
    if (now > open + 5 * 60_000) return { skipped: 'started after 09:20' };   // switched on late: the decision time has passed
    const d = await decide(acct, adapter, u, day, open, now, memo);
    if (!d) return { waiting: 'opening prices' };
    const base = { user_id: uid, day, strategy: STRATEGY, created_at: now };
    if (d.skip) {
      stmt(`INSERT OR IGNORE INTO paper_trades (user_id, day, strategy, status, reason, detail, created_at) VALUES (?, ?, ?, 'skipped', ?, ?, ?)`)
        .run(base.user_id, day, STRATEGY, d.skip, JSON.stringify({ sides: d.sides || null }), now);
      say(uid, 'info', `${STRATEGY}: no trade today`, `${u.label}: ${d.skip}.`);
      return { skipped: d.skip };
    }
    const symbol = `${u.symbol} ${d.expiry} ${d.contract.strike} ${d.direction}`;
    stmt(`INSERT OR IGNORE INTO paper_trades (user_id, day, strategy, direction, symbol, security_id, exchange_segment, level, status, reason, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'watching', ?, ?, ?)`).run(uid, day, STRATEGY, d.direction, symbol, d.contract.securityId, seg, d.level,
      `Waiting for ${symbol} to come back to its 09:15 open ${d.level} by ${new Date(open + cfg.windowMin * 60_000 + 19_800_000).toISOString().slice(11, 16)}`,
      JSON.stringify({ gapPct: d.gapPct, sides: d.sides, cfg }), now);
    say(uid, 'info', `${STRATEGY} ${d.direction}: waiting for the retest`, `${symbol} opened ${d.level}. Buying on paper if it comes back to ${d.level} within ${cfg.windowMin} minutes, stop ${cfg.slPct}% below.`);
    return { watching: d.level };
  }
  if (r.status === 'skipped' || r.status === 'closed') return { done: r.status };
  const live = () => priceOf(uid, adapter, r.exchange_segment || seg, r.security_id, now, memo);

  if (r.status === 'watching') {
    if (now < open + 60_000) return { waiting: '09:16' };   // the retest counts from 09:16, after the opening minute
    if (now > open + cfg.windowMin * 60_000) {
      update(r.id, { status: 'skipped', reason: `No retest of the 09:15 open ${r.level} within ${cfg.windowMin} minutes`, closed_at: now });
      say(uid, 'info', `${STRATEGY}: no trade today`, `${r.symbol} did not come back to ${r.level} within ${cfg.windowMin} minutes.`);
      return { skipped: 'no retest' };
    }
    const p = await live();
    if (!(p?.ltp > 0) || p.ltp > r.level) return { waiting: 'the retest' };
    const meta = (await instruments(u)).get(String(r.security_id));
    const lotSize = meta?.lotSize || 65, tick = meta?.tickSize || TICK;
    const entry = r.level, { lots, budget } = sizeAt(uid, entry, lotSize);
    if (lots < 1) {
      update(r.id, { status: 'skipped', reason: `1 lot at ${entry} is more than the capital per trade or the funds`, closed_at: now });
      return { skipped: 'size' };
    }
    const qty = lots * lotSize, fixed = entry * (1 - cfg.slPct / 100), byBudget = budget > 0 ? entry - budget / qty : -Infinity;
    const stop = Math.max(tick, roundTick(Math.ceil(Math.max(fixed, byBudget) / tick - 1e-9) * tick, tick));
    update(r.id, { status: 'open', entry_price: entry, sl_price: stop, lots, qty, entered_at: now, reason: `Bought on the retest at ${entry} (${new Date(now + 19_800_000).toISOString().slice(11, 19)})` });
    audit(uid, 'paper.entered', { id: r.id, strategy: STRATEGY, symbol: r.symbol, entry, stop, qty });
    say(uid, 'ok', `bought ${lots} lot${lots > 1 ? 's' : ''} ${r.symbol}`, `${STRATEGY} ${r.direction}: back to its 09:15 open ${entry}. Stop ${stop}; exit on the first ${r.direction === 'CE' ? 'red' : 'green'} 1-minute NIFTY candle.`);
    return { entered: entry };
  }

  // Open: stop, the first opposite-colour NIFTY 1-minute candle after the entry minute, or the square-off.
  const p = await live();
  const exitAt = squareOffTime(getRules(uid).active), hhmm = new Date(now + 19_800_000).toISOString().slice(11, 16);
  let why = null;
  if (p?.ltp > 0 && p.ltp <= r.sl_price) why = 'Stop-loss';
  else if (hhmm >= exitAt) why = `Square-off ${exitAt}`;
  else {
    const det = JSON.parse(r.detail || '{}'), from = Math.floor(r.entered_at / 60_000) * 60_000 + 60_000;
    for (let m = Math.max(from, det.checkedMinute ?? from); m + 60_000 <= now; m += 60_000) {
      const bar = FEED.minute(uid, `IDX_I:${u.securityId}`, m, now);
      if (!bar) break;   // not built from ticks yet: next pass
      det.checkedMinute = m + 60_000;
      if (r.direction === 'CE' ? bar.close < bar.open : bar.close > bar.open) { why = `First ${r.direction === 'CE' ? 'red' : 'green'} 1-minute NIFTY candle ${new Date(m + 19_800_000).toISOString().slice(11, 16)}`; break; }
    }
    update(r.id, { detail: JSON.stringify(det) });
  }
  if (!why) return { open: p?.ltp ?? null };
  if (!(p?.ltp > 0)) return { open: null, waiting: 'a price to exit at' };
  const exit = p.ltp, charges = round2(optionCharges(day, r.entry_price * r.qty, exit * r.qty).total), pnl = round2((exit - r.entry_price) * r.qty - charges);
  update(r.id, { status: 'closed', exit_price: exit, charges, pnl, closed_at: now, reason: why });
  audit(uid, 'paper.closed', { id: r.id, strategy: STRATEGY, exit, pnl, why });
  say(uid, pnl >= 0 ? 'ok' : 'warn', `${r.symbol} closed ${pnl >= 0 ? '+' : '−'}₹${Math.abs(Math.round(pnl)).toLocaleString('en-IN')}`, `${why}: sold at ${exit} (bought ${r.entry_price}), after charges.`);
  return { closed: exit, pnl };
}

/** Run the paper strategy for every account that has it on, once a second through the session. */
export function startPaperTrading({ tickMs = P.tickMs } = {}) {
  const busy = new Set(), memos = new Map();
  const timer = setInterval(() => {
    const now = Date.now(), t = ist(now);
    if (!isTradingDay(now) || t.minutes < 9 * 60 + 13 || (!marketOpen(now) && t.minutes > 9 * 60 + 30)) return;
    let accounts;
    try { accounts = stmt(`SELECT * FROM broker_accounts WHERE retest_paper_on = 1 AND (broker = 'paper' OR (broker = 'dhan' AND token_enc IS NOT NULL)) AND status IN ('connected', 'delayed', 'degraded')`).all(); }
    catch (e) { console.error('[paper]', e.message); return; }
    for (const acct of accounts) {
      if (busy.has(acct.user_id)) continue;
      const key = `${acct.user_id}:${t.day}`;
      if (!memos.has(key)) memos.set(key, {});
      busy.add(acct.user_id);
      paperStep(acct, { now, memo: memos.get(key) }).catch(e => console.error('[paper]', e.message)).finally(() => busy.delete(acct.user_id));
    }
  }, tickMs);
  return () => clearInterval(timer);
}
