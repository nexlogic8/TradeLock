import { stmt } from '../../db/index.js';
import { bad, notFound, conflict } from '../../lib/errors.js';
import { emit } from '../../lib/bus.js';
import { ist } from '../../lib/time.js';
import { accountFor, adapterFor } from '../broker/registry.js';
import { getBook, setBook } from '../broker/book.js';
import { dayState, patchDay } from '../risk/service.js';
import { notify } from '../notifications/service.js';
import { audit } from '../audit/service.js';
import { RULE_NAMES } from '../rules/service.js';

export const ACTIONS = ['pause', 'cancel', 'exit', 'killswitch'];
const LABEL = {
  pause: 'Pause new orders sent through TradeLock',
  cancel: 'Cancel eligible open orders',
  exit: 'Exit eligible positions',
  killswitch: 'Activate broker kill switch',
};
const EXIT_WAIT_S = 15;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const toRecord = row => row && ({
  id: row.id,
  userId: row.user_id,
  actions: JSON.parse(row.actions),
  source: row.source,
  status: row.status,
  results: JSON.parse(row.results),
  createdAt: row.created_at,
  acknowledgedAt: row.acknowledged_at,
});

export const latestEmergency = userId =>
  toRecord(stmt('SELECT * FROM emergency_actions WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(userId));

/** Starts the actions in the background and returns the record plus a promise for completion. */
export function startEmergency(userId, actions, source) {
  const acct = accountFor(userId);
  if (!acct && actions.some(a => a !== 'pause')) throw bad('NO_BROKER', 'Connect a broker before cancelling orders or exiting positions.');
  const results = actions.map(action => ({ action, label: LABEL[action], status: 'pending', detail: 'Queued' }));
  const { lastInsertRowid } = stmt(`INSERT INTO emergency_actions (user_id, actions, source, status, results, created_at) VALUES (?, ?, ?, 'running', ?, ?)`)
    .run(userId, JSON.stringify(actions), source, JSON.stringify(results), Date.now());
  const record = toRecord(stmt('SELECT * FROM emergency_actions WHERE id = ?').get(lastInsertRowid));
  audit(userId, 'emergency.started', { id: record.id, actions, source });
  return { record, done: execute(record, acct) };
}

export const runEmergency = (userId, actions, source) => startEmergency(userId, actions, source).done;

async function execute(rec, acct) {
  const save = () => {
    stmt('UPDATE emergency_actions SET results = ?, status = ? WHERE id = ?').run(JSON.stringify(rec.results), rec.status, rec.id);
    emit(rec.userId, 'emergency', rec);
  };
  const set = (i, status, detail) => { rec.results[i] = { ...rec.results[i], status, detail }; save(); };
  const adapter = acct && adapterFor(acct);
  const day = ist().day;

  for (const [i, r] of rec.results.entries()) {
    try {
      if (r.action === 'pause') {
        const s = dayState(rec.userId, day);
        // A rule-driven pause keeps its reason so it cannot be lifted the same day.
        const reason = s.pause_reason?.startsWith('rule:') ? s.pause_reason : rec.source === 'manual' ? 'manual' : rec.source;
        patchDay(rec.userId, day, { paused: 1, pause_reason: reason });
        set(i, 'done', 'Orders placed in TradeLock are blocked. Exits are still allowed.');
      } else if (r.action === 'cancel') {
        // Rule-driven (the kill switch's flatten): the locked segments only, so commodity (MCX) orders stay.
        const orders = getBook(rec.userId).orders.filter(o => rec.source === 'manual' || lockedSegment(o));
        if (!orders.length) { set(i, 'done', 'No open orders to cancel.'); continue; }
        set(i, 'pending', `Cancelling ${orders.length} order(s)…`);
        const lines = await Promise.all(orders.map(o => adapter.cancelOrder(o.id)
          .then(() => ({ ok: true, text: `${o.symbol} ${o.side.toLowerCase()} cancelled` }))
          .catch(e => ({ ok: false, text: `${o.symbol}: ${e.message}` }))));
        const failed = lines.some(l => !l.ok);
        set(i, failed ? 'failed' : 'done', lines.map(l => l.text).join(' · ') + (failed ? '. Cancel the rest in your broker app.' : '.'));
      } else if (r.action === 'killswitch') {
        set(i, 'pending', 'Checking that the account is flat…');
        const res = await tryKillSwitch(rec.userId, acct, rec.source);
        set(i, res.status === 'failed' ? 'failed' : 'done', res.text);
      } else if (r.action === 'exit') {
        const positions = getBook(rec.userId).positions.filter(p => p.qty !== 0 && (rec.source === 'manual' || lockedSegment(p)));
        if (!positions.length) { set(i, 'done', 'No open positions.'); continue; }
        set(i, 'pending', `Exit orders sent for ${positions.length} position(s). Waiting for broker confirmation…`);
        const lines = await Promise.all(positions.map(p => exitOne(adapter, p)));
        const failed = lines.some(l => !l.ok);
        set(i, failed ? 'failed' : 'done', lines.map(l => l.text).join(' · ') + (failed ? '. Exit the rest manually in your broker app.' : '.'));
      }
    } catch (e) {
      set(i, 'failed', `${e.message}.`);
    }
  }

  rec.status = rec.results.some(r => r.status === 'failed') ? 'partial' : 'completed';
  save();
  const why = rec.source.startsWith('rule:') ? ` Triggered by your ${RULE_NAMES[rec.source.slice(5)]}.` : '';
  notify(rec.userId, rec.status === 'completed'
    ? { kind: 'risk', level: 'warn', title: 'Kill switch: all actions completed', body: `Positions closed and orders cancelled as requested.${why}` }
    : { kind: 'risk', level: 'critical', title: 'Kill switch: some actions failed', body: `Check Positions and close anything still open in your broker app.${why}` });
  audit(rec.userId, 'emergency.finished', { id: rec.id, status: rec.status });
  return rec;
}

/**
 * What the kill switch locks. 'indian' (the user's choice, 13 Nov 2026): only the Indian equity / F&O market (NSE, BSE);
 * commodity (MCX) stays open. Dhan's own kill switch locks the whole account and its API has no segment option, so
 * TradeLock holds this lock itself: Indian orders are cancelled, and any Indian position opened while it is on (also
 * from the broker's app) is closed at market on the next sync (enforceMarketLock). 'broker': the broker's account-wide
 * kill switch, as before. A mutable object so tests can choose.
 */
export const KILL_SCOPE = { mode: 'indian' };
/** Commodity segments (MCX / NCDEX) are outside the Indian-market lock. Unknown segment → Indian (locked). */
export const isCommodity = seg => /MCX|NCDEX|COMM/i.test(String(seg || ''));
export const lockedSegment = x => KILL_SCOPE.mode !== 'indian' || !isCommodity(x?.exchangeSegment);

/**
 * Activate the kill switch (KILL_SCOPE), or arm it until the account is flat in the locked segments.
 * Brokers (Dhan) refuse their kill switch while positions or pending orders exist.
 * @returns {{ status: 'active'|'armed'|'failed', text: string }}
 */
export async function tryKillSwitch(userId, acct, reason, adapter = acct && adapterFor(acct)) {
  const day = ist().day;
  const s = dayState(userId, day);
  const market = KILL_SCOPE.mode === 'indian';
  if (s.ks_active_at) return { status: 'active', text: 'Kill switch is already active today.' };
  if (!market && !adapter?.activateKillSwitch) return { status: 'failed', text: 'This broker does not offer a kill switch through its API. Lock trading in the broker app.' };
  if (market && !adapter?.snapshot) return { status: 'failed', text: 'No broker connection to lock the Indian market with.' };
  try {
    if (adapter.getKillSwitch && (await adapter.getKillSwitch()) === true) {
      patchDay(userId, day, { ks_armed: s.ks_armed || reason, ks_active_at: Date.now() });
      return { status: 'active', text: `${adapter.label} kill switch is already ON.` };
    }
    const snap = await adapter.snapshot();
    setBook(userId, { positions: snap.positions, orders: snap.orders, funds: snap.funds ?? null, at: Date.now() });
    if (snap.positions.some(p => p.qty !== 0 && lockedSegment(p))) {
      if (!s.ks_armed) patchDay(userId, day, { ks_armed: reason });
      return { status: 'armed', text: `Armed. The kill switch activates as soon as all ${market ? 'NSE / BSE ' : ''}positions are closed.` };
    }
    for (const o of snap.orders || []) if (lockedSegment(o)) await adapter.cancelOrder(o.id).catch(() => {});
    if (market) {
      patchDay(userId, day, { ks_armed: s.ks_armed || reason, ks_active_at: Date.now() });
      audit(userId, 'killswitch.market_lock', { reason });
      notify(userId, { kind: 'risk', level: 'critical', title: 'Kill switch on: Indian market locked',
        body: `NSE / BSE trading is locked for the rest of the day${reason?.startsWith('rule:') ? `, after your ${RULE_NAMES[reason.slice(5)]} was reached`
          : reason === 'gap:no-entry' ? ', as there was no Gap 09:15 entry today' : ''}. Any NSE / BSE position opened today, also from the ${adapter.label} app, is closed at market within seconds. Commodity (MCX) stays open.` });
      return { status: 'active', text: 'Indian market (NSE / BSE) locked for the rest of the day; commodity (MCX) stays open.' };
    }
    const { message } = await adapter.activateKillSwitch();
    patchDay(userId, day, { ks_armed: s.ks_armed || reason, ks_active_at: Date.now() });
    audit(userId, 'killswitch.activated', { reason });
    notify(userId, { kind: 'risk', level: 'critical', title: `${adapter.label} kill switch activated`,
      body: `Trading is locked on your ${adapter.label} account for the rest of the day${reason?.startsWith('rule:') ? `, after your ${RULE_NAMES[reason.slice(5)]} was reached`
        : reason === 'gap:no-entry' ? ', as there was no Gap 09:15 entry today' : ''}.` });
    return { status: 'active', text: message || `${adapter.label} kill switch activated. Trading is locked for the rest of the day.` };
  } catch (e) {
    if (!s.ks_armed) patchDay(userId, day, { ks_armed: reason });
    audit(userId, 'killswitch.failed', { reason, error: e.message });
    notify(userId, { kind: 'risk', level: 'critical', title: 'Kill switch could not be activated',
      body: `${e.message}. TradeLock will retry; to be safe, turn on the kill switch in your broker app now.` });
    return { status: 'failed', text: `${e.message}. Turn on the kill switch in your broker app.` };
  }
}

/**
 * The Indian-market lock (KILL_SCOPE 'indian'), on each sync while it is on today: NSE / BSE orders are cancelled and
 * NSE / BSE positions closed at market (once per position every RETRY_MS); commodity (MCX) is left alone.
 * Not for a lock the broker holds itself (ks_armed 'broker': the broker blocks everything already).
 */
const lockExits = new Map();   // `${userId}:${securityId}` -> last exit attempt
const LOCK_RETRY_MS = 15_000;
export async function enforceMarketLock(userId, adapter, snap, s) {
  if (KILL_SCOPE.mode !== 'indian' || !s?.ks_active_at || s.ks_armed === 'broker' || !adapter) return [];
  const done = [];
  for (const o of snap.orders || []) if (lockedSegment(o)) {
    const k = `${userId}:order:${o.id}`;
    if (Date.now() - (lockExits.get(k) || 0) < LOCK_RETRY_MS) continue;
    lockExits.set(k, Date.now());
    await adapter.cancelOrder(o.id).then(() => done.push(`${o.symbol} order cancelled`)).catch(() => {});
  }
  for (const p of snap.positions || []) if (p.qty !== 0 && lockedSegment(p) && adapter.exitPosition) {
    const k = `${userId}:${p.securityId}`;
    if (Date.now() - (lockExits.get(k) || 0) < LOCK_RETRY_MS) continue;
    lockExits.set(k, Date.now());
    try { await adapter.exitPosition(p); done.push(`${p.symbol} closed at market`); }
    catch (e) { notify(userId, { kind: 'risk', level: 'critical', title: `Could not close ${p.symbol}`, body: `The Indian market is locked today, but closing it failed: ${e.message}. Close it in the ${adapter.label} app now.` }); }
  }
  if (done.length) {
    audit(userId, 'killswitch.market_lock_enforced', { actions: done });
    notify(userId, { kind: 'risk', level: 'critical', title: 'Indian market is locked today', body: `${done.join(' · ')}. NSE / BSE trades are not allowed after the kill switch; commodity (MCX) stays open.` });
  }
  return done;
}

async function exitOne(adapter, p) {
  try {
    const o = await adapter.exitPosition(p);
    for (let k = 0; k < EXIT_WAIT_S; k++) {
      const s = await adapter.orderStatus(o.id);
      if (s.status === 'filled') return { ok: true, text: `${p.symbol} exited at ${Number(s.price).toFixed(2)}` };
      if (s.status === 'failed') return { ok: false, text: `${p.symbol}: ${s.reason}` };
      await sleep(1000);
    }
    return { ok: false, text: `${p.symbol}: no confirmation after ${EXIT_WAIT_S}s` };
  } catch (e) {
    return { ok: false, text: `${p.symbol}: ${e.message}` };
  }
}

export function acknowledge(userId, id) {
  const row = stmt('SELECT * FROM emergency_actions WHERE id = ? AND user_id = ?').get(Number(id), userId);
  if (!row) throw notFound('Emergency action not found');
  if (row.status === 'running') throw conflict('STILL_RUNNING', 'Wait for every action to finish before acknowledging.');
  stmt('UPDATE emergency_actions SET acknowledged_at = ? WHERE id = ?').run(Date.now(), row.id);
  audit(userId, 'emergency.acknowledged', { id: row.id });
  return latestEmergency(userId);
}

export function resumeOrders(userId) {
  const day = ist().day;
  const s = dayState(userId, day);
  if (!s.paused) return { paused: false };
  if (s.pause_reason?.startsWith('rule:')) {
    throw conflict('RULE_PAUSE', `Orders are paused by your ${RULE_NAMES[s.pause_reason.slice(5)]}. They resume automatically next session.`);
  }
  patchDay(userId, day, { paused: 0, pause_reason: null });
  audit(userId, 'emergency.resumed', {});
  return { paused: false };
}
