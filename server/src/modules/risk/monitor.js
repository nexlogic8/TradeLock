// The heartbeat: poll each connected broker, update day state, evaluate rules, act, push to clients.
//
// Built to watch thousands of accounts from one small server:
//  - accounts in a trade (open position or working order) are synced every SYNC_MS (2 s); flat accounts
//    every FLAT_SYNC_MS (4 s). A new position is picked up on the next flat sync.
//  - each sync reads positions. Orders are read when the positions show a fill, else every 10 s in a
//    trade / 30 s flat; the trade list only when the order book changed; funds every 20 s in a trade /
//    60 s flat; the broker kill-switch state every 60 s (10 s while armed).
//  - rules and today's state are cached in memory; rows are written only when a value changed; sync
//    counters and last-sync time are flushed at least every 30 s.
//  - a full dashboard is pushed only to users with a live screen open, and only when something they see
//    changed (or once a minute); otherwise a tiny "synced" ping.
import { stmt } from '../../db/index.js';
import { config } from '../../config.js';
import { recordTick } from '../../lib/metrics.js';
import { ist, marketOpen, isTradingDay } from '../../lib/time.js';
import { emit, hasListeners } from '../../lib/bus.js';
import { adapterFor, getAccountsVersion } from '../broker/registry.js';
import { setBook, getBook, getKillStatus, setKillStatus, getPermissions, setPermissions, markDirty, takeDirty } from '../broker/book.js';
import { notify } from '../notifications/service.js';
import { getRules } from '../rules/service.js';
import { upsertFills, fillsForDay, logRiskEvent } from '../trades/service.js';
import { runEmergency, tryKillSwitch } from '../emergency/service.js';
import { evaluate, countEntries, closedTrades } from './engine.js';
import { dayState, patchDay, recordPoint, getDashboard, capitalFor, capitalFromFunds } from './service.js';

// Outside market hours brokers are polled slowly, read-only, so funds and positions stay visible.
const OFF_HOURS_SYNC_MS = 5 * 60e3;
// ...except the last minutes before the open on a trading day: polled as in market hours (still read-only), so Algo
// Trading's 09:15:00 entry sizes on funds and positions that are seconds old, not up to 5 minutes.
const PRE_OPEN_MIN = 7;
const KILL_RETRY_MS = 60e3;
const KILL_STATUS_REFRESH_MS = 60e3;    // the lock can be switched in the broker's own app
const KILL_STATUS_ARMED_MS = 10e3;      // ...read it more often while TradeLock is waiting to lock
const FUNDS_ACTIVE_MS = 20e3;
const FUNDS_FLAT_MS = 60e3;
const ORDERS_ACTIVE_MS = 10e3;          // fills are caught from positions; this refreshes the working-order list
const ORDERS_FLAT_MS = 30e3;
const ACCOUNTS_REFRESH_MS = 5e3;        // running-agent list; refreshed at once on connect/disconnect/start/stop
const PERSIST_MS = 30e3;                // last_sync_at and the sync counter are written at least this often
const CAPITAL_STEADY_MS = 60e3;         // a higher balance must hold this long (while flat) to count as a deposit
const PERMISSIONS_REFRESH_MS = 15 * 60e3;  // static IP / token validity rarely change (new problems also surface as failed orders)

// Per-account runtime state (memory only; rebuilt from the broker after a restart).
const runtime = new Map();
const rt = id => {
  let m = runtime.get(id);
  if (!m) runtime.set(id, (m = { adapter: null, status: undefined, lastError: undefined, dueAt: 0, posSig: undefined, orderSig: undefined, ordersAt: 0, fundsAt: 0, bookKey: null, pushMinute: null, lastOkAt: null, persistedAt: 0, day: null, syncOk: 0, flushedAt: 0, point: null, fills: null }));
  return m;
};
export const forgetAccount = id => runtime.delete(id);

const capitalCandidate = new Map();
const killBusy = new Set();
const killLastTry = new Map();

const inTrade = book => book.positions.some(p => p.qty !== 0) || book.orders.length > 0;

/** Static-IP order permission and token expiry from the broker. A newly blocked state raises an alert. */
async function refreshPermissions(uid, acct, adapter, force) {
  if (!adapter.permissions) return;
  const prev = getPermissions(uid);
  if (!force && prev && Date.now() - prev.checkedAt < PERMISSIONS_REFRESH_MS) return;
  try {
    const p = await adapter.permissions();
    setPermissions(uid, p);
    if (p.tokenValidUntil && p.tokenValidUntil !== acct.token_expires_at) stmt('UPDATE broker_accounts SET token_expires_at = ? WHERE id = ?').run(p.tokenValidUntil, acct.id);
    if (p.ordersAllowed === false && prev?.ordersAllowed !== false) {
      notify(uid, { kind: 'broker', level: 'critical', title: `${adapter.label} is blocking orders from TradeLock`,
        body: `${adapter.label} only accepts API orders from your registered static IP. Add ${p.serverIp || 'the TradeLock server IP'} in ${adapter.label}, or automatic exits will fail.` });
    }
  } catch { /* keep the last reading */ }
}

const setStatus = (id, status, syncedAt, error) =>
  stmt('UPDATE broker_accounts SET status = ?, last_sync_at = COALESCE(?, last_sync_at), last_error = ? WHERE id = ?').run(status, syncedAt, error, id);

/**
 * The monitor loop. Every SYNC_MS, each account that is due and not already syncing starts its own
 * sync, so one slow or hanging broker call never holds up anyone else's protection.
 */
let agentList = null, agentListAt = 0, agentListVersion = -1;
function runningAgents() {
  if (!agentList || agentListVersion !== getAccountsVersion() || Date.now() - agentListAt >= ACCOUNTS_REFRESH_MS) {
    agentListVersion = getAccountsVersion();
    agentList = stmt(`SELECT * FROM broker_accounts WHERE status != 'disconnected' AND agent_on = 1`).all();
    agentListAt = Date.now();
  }
  return agentList;
}

export function startMonitor({ accounts = runningAgents, onTick = recordTick } = {}) {
  const inflight = new Set();
  const timer = setInterval(() => {
    const started = Date.now();
    let due;
    try { due = accounts().filter(a => !inflight.has(a.id) && rt(a.id).dueAt <= started); }
    catch (e) { console.error('[monitor]', e.message); return; }
    for (const a of due) inflight.add(a.id);
    Promise.allSettled(due.map(a => syncAccount(a).finally(() => inflight.delete(a.id))))
      .then(() => onTick(Date.now() - started));
  }, config.syncMs);
  return () => clearInterval(timer);
}

/**
 * Market hours (or the always-on demo broker): full sync + rule checks.
 * Off hours: a read-only refresh every 5 minutes (or when forced), no rule actions.
 * Weekends only refresh positions/funds; they never create a trading session.
 */
export async function syncAccount(acct, { force = false } = {}) {
  const adapter = adapterFor(acct);
  const uid = acct.user_id;
  let m = rt(acct.id);
  // A reconnect creates a new adapter: start this account's runtime state afresh.
  if (m.adapter !== adapter) { runtime.delete(acct.id); m = rt(acct.id); m.adapter = adapter; }
  // The account row may come from the cached list (up to 5 s old); the live status is tracked here.
  const prevStatus = m.status ?? acct.status;
  const prevError = m.lastError !== undefined ? m.lastError : acct.last_error;
  const live = adapter.alwaysOn || marketOpen();
  const prevBook = getBook(uid), mins = ist().minutes;
  const preOpen = !live && isTradingDay() && mins >= config.market.open - PRE_OPEN_MIN && mins < config.market.open;
  // An empty in-memory book (e.g. right after a restart) is always refilled immediately.
  if (!live && !preOpen && !force && prevBook.at !== null && Date.now() - (m.lastOkAt ?? acct.last_sync_at ?? 0) < OFF_HOURS_SYNC_MS) return;
  const started = Date.now();
  const t = ist(started);
  let s = null;
  let status = prevStatus;
  try {
    const active = inTrade(prevBook);
    const wantFunds = force || !prevBook.funds || started - m.fundsAt >= (active ? FUNDS_ACTIVE_MS : FUNDS_FLAT_MS);
    const wantOrders = force || prevBook.at === null || started - m.ordersAt >= (active ? ORDERS_ACTIVE_MS : ORDERS_FLAT_MS);
    const snap = await adapter.snapshot({
      funds: wantFunds, orders: wantOrders,
      prevPosSig: force ? undefined : m.posSig, prevOrderSig: force ? undefined : m.orderSig,
    });
    if (snap.funds !== undefined) m.fundsAt = Date.now();
    if (snap.orders !== undefined) m.ordersAt = Date.now();
    snap.funds = snap.funds === undefined ? prevBook.funds : snap.funds ?? null;
    snap.orders = snap.orders ?? prevBook.orders;
    setBook(uid, { positions: snap.positions, orders: snap.orders, funds: snap.funds, at: Date.now() });
    if (snap.trades) { upsertFills(uid, snap.trades); m.fills = null; }
    m.posSig = snap.posSig;
    m.orderSig = snap.orderSig;
    // Anything on screen besides P&L (P&L changes go through patchDay): positions, working orders, funds.
    const bookKey = snap.posSig === undefined ? null : `${snap.posSig}#${snap.orderSig}#${snap.funds?.available}:${snap.funds?.used}`;
    if (bookKey === null || bookKey !== m.bookKey) { m.bookKey = bookKey; markDirty(uid); }
    if (live || isTradingDay()) s = applySnapshot(uid, t, snap, m);
    await refreshKillStatus(uid, adapter, live || isTradingDay(), s);
    await refreshPermissions(uid, acct, adapter, force);
    const now = Date.now();
    m.lastOkAt = now;
    status = 'connected';
    if (force || prevStatus !== 'connected' || prevError || now - m.persistedAt >= PERSIST_MS) {
      setStatus(acct.id, 'connected', now, null);
      m.persistedAt = now;
    }
    m.status = 'connected';
    m.lastError = null;
    if (prevStatus === 'degraded' || prevStatus === 'expired') {
      notify(uid, { kind: 'broker', level: 'ok', title: `${adapter.label} data sync restored`, body: 'Monitoring is active again.' });
    }
    // A stopped agent still answers a manual refresh, but never enforces anything.
    if (live && acct.agent_on !== 0) {
      if (await checkRules(uid, t, s, m)) s = dayState(uid, t.day);
      maybeActivateArmed(uid, acct, snap, s);
    }
  } catch (err) {
    if (live) {
      const d = dayState(uid, t.day);
      patchDay(uid, t.day, { sync_fail: d.sync_fail + 1 });
    }
    const stale = Date.now() - (m.lastOkAt ?? acct.last_sync_at ?? 0) > config.degradedAfterMs;
    status = err.code === 'TOKEN_EXPIRED' ? 'expired' : stale ? 'degraded' : 'delayed';
    const msg = String(err.message).slice(0, 200);
    if (status !== prevStatus || msg !== prevError) setStatus(acct.id, status, null, msg);
    m.status = status;
    m.lastError = msg;
    if (status !== prevStatus && (status === 'degraded' || status === 'expired')) {
      notify(uid, status === 'expired'
        ? { kind: 'broker', level: 'critical', title: `${adapter.label} session expired`, body: 'Reconnect your broker to resume monitoring.' }
        : { kind: 'broker', level: 'warn', title: `${adapter.label} data is delayed`, body: 'Risk rules cannot be checked until sync recovers. Do not rely on automatic protection.' });
    }
  }
  const armed = !!(s?.ks_armed && !s.ks_active_at);
  m.dueAt = started + (inTrade(getBook(uid)) || armed ? config.syncMs : config.flatSyncMs) - 250;
  if (status !== prevStatus) markDirty(uid);
  if (!hasListeners(uid)) return;
  // Full dashboard when something on it changed (and once a minute for the session clock); otherwise
  // just move the "synced" time forward. Most accounts are flat most of the day.
  const changed = takeDirty(uid);
  if (changed || force || m.pushMinute !== t.minutes) {
    m.pushMinute = t.minutes;
    emit(uid, 'snapshot', getDashboard(uid, { ...acct, status, last_error: m.lastError }));
  } else if (status === 'connected') {
    emit(uid, 'synced', { at: getBook(uid).at });
  }
}

function fillsFor(uid, m, day) {
  if (!m.fills || m.fills.day !== day) m.fills = { day, rows: fillsForDay(uid, day) };
  return m.fills.rows;
}

/** Update today's numbers from a broker snapshot. Writes only what changed; returns the day state. */
export function applySnapshot(uid, t, snap, m) {
  // Before the open the broker still reports the previous session's closed positions and their P&L (Dhan resets in
  // the morning; 5 Nov 00:01 read 4 Nov's −₹1,70,128): today counts only positions still open until 09:15.
  const preOpen = t.minutes < config.market.open;
  const counted = preOpen ? snap.positions.filter(p => p.qty !== 0) : snap.positions;
  const realized = counted.reduce((a, p) => a + (p.realized || 0), 0);
  const unrealized = counted.reduce((a, p) => a + (p.unrealized || 0), 0);
  const pnl = realized + unrealized;
  const s = dayState(uid, t.day);
  const fills = fillsFor(uid, m, t.day);
  const closed = closedTrades(fills);
  const next = {
    capital: nextCapital(uid, s, snap, realized),
    realized, unrealized,
    // Before the open the day has not started: its low and high are today's numbers only (clears an earlier reading).
    worst: preOpen ? Math.min(0, pnl) : Math.min(s.worst, pnl),
    peak: preOpen ? Math.max(0, pnl) : Math.max(s.peak, pnl),
    entries: countEntries(fills),
    wins: closed.filter(c => c.pnl > 0).length,
    losses: closed.filter(c => c.pnl < 0).length,
  };
  const patch = {};
  for (const k in next) if (next[k] !== s[k]) patch[k] = next[k];

  if (m.day !== t.day) { m.day = t.day; m.syncOk = 0; m.point = null; }
  const firstOfDay = s.sync_ok === 0 && m.syncOk === 0;
  m.syncOk++;
  if (firstOfDay || Object.keys(patch).length || Date.now() - m.flushedAt >= PERSIST_MS) {
    patch.sync_ok = s.sync_ok + m.syncOk;
    m.syncOk = 0;
    m.flushedAt = Date.now();
  }
  // Only P&L bookkeeping here: written in a batch. Rule state (fired, paused...) is written at once.
  patchDay(uid, t.day, patch, { defer: true });

  // Day P&L starts at zero, so anchor the curve at the open the first time we see this day.
  if (firstOfDay) recordPoint(uid, t.day, config.market.open, 0);
  // The intraday curve starts at the open: points from before it (the previous session's P&L) are dropped, once a day.
  if (preOpen) {
    if (m.clearedDay !== t.day) { m.clearedDay = t.day; stmt('DELETE FROM pnl_points WHERE user_id = ? AND day = ? AND minute < ?').run(uid, t.day, config.market.open); }
    return { ...s, ...patch };
  }
  if (!m.point || m.point.minute !== t.minutes || m.point.pnl !== pnl) {
    recordPoint(uid, t.day, t.minutes, pnl);
    m.point = { minute: t.minutes, pnl };
  }
  return { ...s, ...patch };
}

/**
 * Capital for the day (GROWCONTROL engine/monitor.py): the first reading is kept; it may only RISE
 * (a deposit), and only while flat and after holding steady for 60 s, so margin swings, P&L settling
 * late, or losses never shrink the limits.
 */
export function nextCapital(uid, s, snap, realized) {
  const value = capitalFromFunds(snap.funds, realized);
  if (!(value > 0)) return s.capital;
  if (s.capital == null) return value;
  const flat = !snap.positions.some(p => p.qty !== 0);
  // Until the first trade of the day the broker's figure is followed, down as well: an early reading can
  // still be yesterday's balance (before the broker's start-of-day roll-over, e.g. after a losing day) and
  // must not stay as today's capital. Once anything is traded, the "only rise" rule below protects it.
  if (flat && !s.entries && !realized && Math.abs(value - s.capital) > 1) { capitalCandidate.delete(uid); return value; }
  if (value <= s.capital + 1 || !flat) { capitalCandidate.delete(uid); return s.capital; }
  const c = capitalCandidate.get(uid);
  if (!c || Math.abs(c.value - value) > 1) { capitalCandidate.set(uid, { value, since: Date.now() }); return s.capital; }
  if (Date.now() - c.since < CAPITAL_STEADY_MS) return s.capital;
  capitalCandidate.delete(uid);
  return value;
}

/** Read the broker's kill switch (it can be switched in the broker app). An external lock is recorded. */
async function refreshKillStatus(uid, adapter, tradingDay, s) {
  if (!adapter.getKillSwitch) return;
  const prev = getKillStatus(uid);
  const every = s?.ks_armed && !s.ks_active_at ? KILL_STATUS_ARMED_MS : KILL_STATUS_REFRESH_MS;
  if (prev && Date.now() - prev.checkedAt < every) return;
  try {
    const active = await adapter.getKillSwitch();
    setKillStatus(uid, { active, checkedAt: Date.now() });
    const t = ist(), d = s ?? dayState(uid);
    // Before the session opens the broker still reports the previous day's lock (Dhan resets it in the
    // morning), so a lock read overnight is not today's. Record broker-side locks from market open only.
    if (active === true && tradingDay && t.minutes >= config.market.open) {
      if (!d.ks_active_at) patchDay(uid, t.day, { ks_armed: d.ks_armed || 'broker', ks_active_at: Date.now() });
    }
    // A lock TradeLock only copied from the broker follows the broker: switched off there, off here.
    if (active === false && d.ks_armed === 'broker' && d.ks_active_at) {
      patchDay(uid, t.day, { ks_armed: null, ks_active_at: null });
      markDirty(uid);
    }
  } catch { /* status unavailable: keep the last reading */ }
}

/** Evaluate the rules against today's state. Returns true when something fired (state changed). */
async function checkRules(uid, t, s, m) {
  const rules = getRules(uid).active;
  const triggers = evaluate(rules, {
    pnl: s.realized + s.unrealized, entries: s.entries, minutes: marketOpen() ? t.minutes : null, capital: capitalFor(uid, s),
    closed: closedTrades(fillsFor(uid, m, t.day)),
  });
  const fresh = triggers.filter(x => !s.fired.includes(x.id));
  if (!fresh.length) return false;

  // Record first so a slow broker action can never fire the same trigger twice.
  patchDay(uid, t.day, {
    fired: [...s.fired, ...fresh.map(x => x.id)],
    breaches: s.breaches + fresh.filter(x => x.level === 'breach').length,
  });
  for (const trig of fresh) {
    logRiskEvent(uid, t.day, trig);
    notify(uid, { kind: 'risk', level: trig.level === 'breach' ? 'critical' : 'warn', title: trig.title, body: trig.body });
    // The clock alone must not hard-lock an unused broker account. Still pause new
    // TradeLock entries at cutoff; retain broker protection for positions, orders,
    // and accounts that traded today (including trades already closed at break-even).
    const cutoffHasActivity = s.entries > 0 || fillsFor(uid, m, t.day).length > 0
      || s.realized !== 0 || s.unrealized !== 0 || inTrade(getBook(uid));
    const lock = rules.killSwitch?.on && trig.level === 'breach'
      && (trig.rule !== 'cutoff' || cutoffHasActivity);
    if (trig.action === 'pause' || trig.action === 'exit' || lock) patchDay(uid, t.day, { paused: 1, pause_reason: `rule:${trig.rule}` });
    // Loss limit and profit lock flatten the account, then lock it. Trade cap and cutoff leave the
    // open trade (and its stop-loss) alone and lock once the account is flat.
    // Kill rules (losing streak, give-back) always square off; with the kill switch on, so do the
    // daily loss limit and profit lock.
    const killRule = trig.rule === 'lossStreak' || trig.rule === 'giveback';
    const flatten = trig.action === 'exit' || killRule || (lock && (trig.rule === 'maxLoss' || trig.rule === 'profitLock'));
    const actions = [...(flatten ? ['pause', 'cancel', 'exit'] : lock ? ['pause'] : []), ...(lock ? ['killswitch'] : [])];
    if (actions.length > 1 || flatten) runEmergency(uid, actions, `rule:${trig.rule}`).catch(e => console.error('[emergency]', e));
  }
  return true;
}

// An armed kill switch fires on the first sync where the account is flat.
function maybeActivateArmed(uid, acct, snap, s = dayState(uid)) {
  if (!s.ks_armed || s.ks_active_at || snap.positions.some(p => p.qty !== 0) || killBusy.has(uid)) return;
  if (Date.now() - (killLastTry.get(uid) || 0) < KILL_RETRY_MS) return;
  killBusy.add(uid);
  killLastTry.set(uid, Date.now());
  tryKillSwitch(uid, acct, s.ks_armed).finally(() => killBusy.delete(uid));
}
