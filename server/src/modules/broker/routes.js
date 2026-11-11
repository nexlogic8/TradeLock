import { stmt } from '../../db/index.js';
import { bad, notFound, HttpError } from '../../lib/errors.js';
import { v } from '../../lib/validate.js';
import { limit } from '../../lib/ratelimit.js';
import { config } from '../../config.js';
import { CATALOG, createAdapter, adapterFor, dropAdapter, accountFor, accountSummary, upsertAccount, accountsChanged, ensurePaperAccount } from './registry.js';
import { clearBook } from './book.js';
import { syncAccount } from '../risk/monitor.js';
import { dayState, getDashboard, agentLockReason, algoLocked, ALGO_LOCK_MESSAGE } from '../risk/service.js';
import { getPermissions, getKillStatus } from './book.js';
import { notify } from '../notifications/service.js';
import { emit } from '../../lib/bus.js';
import { conflict } from '../../lib/errors.js';
import { audit } from '../audit/service.js';
import { syncBrokerPnl } from '../analytics/brokerpnl.js';
import { guardBroker } from '../billing/trialguard.js';
import { algoReadiness } from '../scalper/algo-live.js';
import { stoxkartLink } from './stoxkart.js';
import { getBook } from './book.js';
import { brokerBusy, switchTradeVia, switchPaper } from './switch.js';
import { paperWallet, setPaperBalance, resetPaperWallet, PAPER_DEFAULT, PAPER_MIN, PAPER_MAX } from './adapters/paper.js';
import { staticIpView } from './static-ip.js';
import { isAdminEmail } from '../../lib/access.js';
import { algoGrid, slotCfg, legacyColumns, GRID_STRATEGIES, GRID_INDICES } from '../scalper/algo-grid.js';

/** CE + PE at a target price: its settings for one index, validated. `prev` = that index's saved settings (capital start). */
function strangleCfgFrom(c = {}, prev = {}) {
  const time = (x, label) => { const s = String(x || ''); if (!/^\d{2}:\d{2}$/.test(s) || s < '09:15' || s > '15:29') throw bad('VALIDATION', `${label} must be a time from 09:15 to 15:29.`); return s; };
  const cfg = { target: v.num(c.target, 'Option price', { min: 0.05, max: 5000 }), bandPct: v.num(c.bandPct, 'Price band %', { min: 1, max: 95 }),
    entry: time(c.entry, 'Entry'), waitMin: v.num(c.waitMin, 'Wait for a price (minutes)', { min: 0, max: 120, int: true }), exit: time(c.exit, 'Exit'),
    stopPct: v.num(c.stopPct, 'Stop %', { min: 1, max: 99 }), fundsPct: v.num(c.fundsPct, 'Funds used %', { min: 1, max: 100 }), maxVolPct: v.num(c.maxVolPct, 'Max % of volume', { min: 0, max: 100 }),
    expiryDay: String(c.expiryDay ?? 'next'), capital: v.num(c.capital ?? 0, 'Capital ₹', { min: 0, max: 1e9 }), compound: c.compound === undefined ? true : v.bool(c.compound, 'Add its profits'),
    capitalMode: String(c.capitalMode ?? 'amount'), capitalPct: v.num(c.capitalPct ?? 100, 'Capital %', { min: 1, max: 100 }) };
  if (!['amount', 'percent'].includes(cfg.capitalMode)) throw bad('VALIDATION', 'Capital: choose a ₹ amount or a % of the funds.');
  if (cfg.exit <= cfg.entry) throw bad('VALIDATION', 'The exit time must be after the entry time.');
  if (!['next', 'skip', 'next1'].includes(cfg.expiryDay)) throw bad('VALIDATION', 'On the expiry day: use the next expiry, skip the day, or use the next expiry from the day before.');
  // Its own capital (+ its profits) counts trades from when it was set; changing it starts again.
  cfg.capitalSince = cfg.capital > 0 && prev.capital === cfg.capital && prev.compound === cfg.compound && prev.capitalSince ? prev.capitalSince : cfg.capital > 0 ? Date.now() : 0;
  return cfg;
}

/** Gap open 09:15: its settings for one index, validated (0 capital = the Risk rules / the funds; 0 stop = the day's stop-loss left). */
function gapCfgFrom(c = {}, prev = {}) {
  const cfg = { capital: v.num(c.capital ?? 0, 'Capital ₹', { min: 0, max: 1e9 }), compound: c.compound === undefined ? true : v.bool(c.compound, 'Add its profits'),
    fundsPct: v.num(c.fundsPct ?? 80, 'Capital used %', { min: 1, max: 100 }), stopPct: v.num(c.stopPct ?? 0, 'Stop-loss % of capital', { min: 0, max: 100 }),
    costToCost: c.costToCost === undefined ? true : v.bool(c.costToCost, 'Cost to cost'), requireGreen: c.requireGreen === undefined ? false : v.bool(c.requireGreen, 'Green premium'),
    capitalMode: String(c.capitalMode ?? 'amount'), capitalPct: v.num(c.capitalPct ?? 80, 'Capital %', { min: 1, max: 100 }),
    autoExit: c.autoExit === undefined ? true : v.bool(c.autoExit, 'Exit at 09:16'), noEntryLock: c.noEntryLock === undefined ? true : v.bool(c.noEntryLock, 'Kill switch if no entry'),
    decide: String(c.decide ?? 'premium'), lots: Math.floor(v.num(c.lots ?? 0, 'Fixed lots', { min: 0, max: 500 })) };
  if (!['amount', 'percent'].includes(cfg.capitalMode)) throw bad('VALIDATION', 'Capital: choose a ₹ amount or a % of the funds.');
  if (!['premium', 'preopen'].includes(cfg.decide)) throw bad('VALIDATION', 'Decide the side: the premium at 09:15 or the index pre-open.');
  cfg.capitalSince = cfg.capital > 0 && prev.capital === cfg.capital && prev.compound === cfg.compound && prev.capitalSince ? prev.capitalSince : cfg.capital > 0 ? Date.now() : 0;
  return cfg;
}

function ownAccount(userId, id) {
  const acct = stmt('SELECT * FROM broker_accounts WHERE id = ? AND user_id = ?').get(Number(id), userId);
  if (!acct) throw notFound('Broker account not found');
  return acct;
}

async function verifyCreds(broker, clientId, accessToken) {
  try {
    await createAdapter(broker, { clientId, accessToken }).verify();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw bad('BROKER_AUTH_FAILED', `${e.message}. Check your client ID and access token.`);
  }
}

export function brokerRoutes(r) {
  // A Paper account (no broker) is not a broker connection: the page offers Connect, which replaces it.
  r.get('/api/brokers', ctx => ({
    catalog: CATALOG,
    account: accountSummary(accountFor(ctx.user.id)),
    links: { stoxkart: stoxkartLink(ctx.user.id) },
    staticIp: staticIpView(ctx.user.id),
  }));

  // Connect runs the same four checks the onboarding checklist shows.
  r.post('/api/brokers/connect', async ctx => {
    limit(`connect:${ctx.user.id}`, 10, 10 * 60e3);
    const broker = v.oneOf(ctx.body.broker, 'Broker', CATALOG.filter(b => b.status === 'available').map(b => b.id));
    const clientId = broker === 'mock' ? 'DEMO-2841' : v.str(ctx.body.clientId, 'Client ID', { min: 4, max: 40 });
    const accessToken = broker === 'mock' ? null : v.str(ctx.body.accessToken, 'Access token', { min: 20, max: 4000 });

    await verifyCreds(broker, clientId, accessToken);
    // Only one active broker per user for now.
    stmt(`UPDATE broker_accounts SET status = 'disconnected', token_enc = NULL WHERE user_id = ? AND broker != ?`).run(ctx.user.id, broker);
    const isNew = !stmt('SELECT 1 FROM broker_accounts WHERE user_id = ? AND broker = ?').get(ctx.user.id, broker);
    const acct = upsertAccount(ctx.user.id, { broker, clientId, accessToken });
    // A new account starts with the default strategy only, Gap open 09:15, on Paper (Algo Trading itself stays off until
    // switched on; Real is one switch away on the AI Algo Trading page).
    if (isNew) stmt('UPDATE broker_accounts SET gap_on = 1, orb_on = 0, cross_on = 0, ema915_on = 0, paper_mode = 1 WHERE id = ?').run(acct.id);
    guardBroker(ctx.user.id, broker, clientId);   // one free trial per broker account
    await syncAccount(acct, { force: true });
    const fresh = stmt('SELECT * FROM broker_accounts WHERE id = ?').get(acct.id);
    audit(ctx.user.id, 'broker.connected', { broker }, ctx.ip);
    syncBrokerPnl(ctx.user.id).catch(() => {});   // backfill the P&L calendar in the background
    const perms = getPermissions(ctx.user.id);
    return {
      account: accountSummary(fresh),
      checks: [
        { id: 'permissions', ok: true },
        { id: 'authorize', ok: true },
        // Orders need the server's IP registered as the static IP at the broker. Monitoring and the
        // kill switch work without it, so this is a warning, not a failure.
        { id: 'orders', ok: perms?.ordersAllowed !== false, warn: perms?.ordersAllowed === false },
        { id: 'monitor', ok: fresh.status === 'connected' || !adapterFor(fresh).alwaysOn },
      ],
    };
  });

  r.post('/api/brokers/:id/reconnect', async ctx => {
    const acct = ownAccount(ctx.user.id, ctx.params.id);
    if (acct.broker === 'mock') {
      upsertAccount(ctx.user.id, { broker: 'mock', clientId: acct.client_id });
    } else {
      const accessToken = v.str(ctx.body.accessToken, 'Access token', { min: 20, max: 4000 });
      await verifyCreds(acct.broker, acct.client_id, accessToken);
      upsertAccount(ctx.user.id, { broker: acct.broker, clientId: acct.client_id, accessToken });
    }
    audit(ctx.user.id, 'broker.reconnected', { broker: acct.broker }, ctx.ip);
    syncBrokerPnl(ctx.user.id).catch(() => {});
    await syncAccount(accountFor(ctx.user.id), { force: true });
    return { account: accountSummary(accountFor(ctx.user.id)) };
  });

  // Manual refresh, e.g. outside market hours when polling is slow.
  r.post('/api/brokers/:id/sync', async ctx => {
    const acct = ownAccount(ctx.user.id, ctx.params.id);
    limit(`sync:${ctx.user.id}`, 6, 60e3);
    await syncAccount(acct, { force: true });
    return { account: accountSummary(stmt('SELECT * FROM broker_accounts WHERE id = ?').get(acct.id)) };
  });

  // Start / stop the TradeLock agent for this broker account.
  r.post('/api/brokers/:id/agent', async ctx => {
    const acct = ownAccount(ctx.user.id, ctx.params.id);
    const on = v.bool(ctx.body.on, 'on');
    if (!on && algoLocked(acct)) throw conflict('ALGO_LOCKED', `Protection can't be stopped while Algo Trading is on. ${ALGO_LOCK_MESSAGE}`);
    if (!on) {
      // Stopping is refused once today's limits were hit: it must not be a way around your own rules.
      const why = agentLockReason(ctx.user.id);
      if (why) throw conflict('AGENT_LOCKED', `Today ${why}, so protection stays on until the next trading day.`);
    }
    // Auto entries never run unprotected: stopping protection also stops Algo Trading.
    stmt('UPDATE broker_accounts SET agent_on = ?, algo_on = CASE WHEN ? THEN algo_on ELSE 0 END WHERE id = ?').run(on ? 1 : 0, on ? 1 : 0, acct.id);
    accountsChanged();
    audit(ctx.user.id, on ? 'agent.started' : 'agent.stopped', { broker: acct.broker }, ctx.ip);
    const label = adapterFor(acct).label;
    if (on) {
      await syncAccount({ ...acct, agent_on: 1 }, { force: true });
      notify(ctx.user.id, { kind: 'broker', level: 'ok', title: 'TradeLock agent started', body: `Monitoring your ${label} account and enforcing your rules.` });
    } else {
      notify(ctx.user.id, { kind: 'broker', level: 'warn', title: 'TradeLock agent stopped', body: `Your ${label} account is not monitored. Rules, alerts and the kill switch are off until you start it again.` });
    }
    emit(ctx.user.id, 'snapshot', getDashboard(ctx.user.id));
    return { account: accountSummary(stmt('SELECT * FROM broker_accounts WHERE id = ?').get(acct.id)) };
  });

  // Algo Trading: live ORB 5m auto entries on NIFTY options (scalper/autotrade.js). Turning it on needs
  // everything an automatic order depends on; turning it off is always allowed (an open trade keeps its
  // stop-loss and is still squared off at the cutoff).
  r.post('/api/brokers/:id/algo', async ctx => {
    const acct = ownAccount(ctx.user.id, ctx.params.id);
    const on = v.bool(ctx.body.on, 'on');
    if (!on && algoLocked(acct)) throw conflict('ALGO_LOCKED', ALGO_LOCK_MESSAGE);
    if (on) {
      const missing = algoReadiness(ctx.user.id, acct).find(r => !r.ok);
      if (missing) throw conflict('ALGO_NOT_READY', missing.detail);
    }
    stmt('UPDATE broker_accounts SET algo_on = ? WHERE id = ?').run(on ? 1 : 0, acct.id);
    accountsChanged();
    audit(ctx.user.id, on ? 'algo.live_started' : 'algo.live_stopped', { broker: acct.broker }, ctx.ip);
    notify(ctx.user.id, on
      ? { kind: 'risk', level: 'warn', title: 'Algo Trading on', body: 'TradeLock will place live ORB 5m NIFTY option orders on your Dhan account, sized by your risk rules, with a stop-loss at Dhan.' }
      : { kind: 'risk', level: 'info', title: 'Algo Trading off', body: 'No new automatic entries. A trade already open keeps its stop-loss and is squared off at your cutoff.' });
    emit(ctx.user.id, 'snapshot', getDashboard(ctx.user.id));
    return { account: accountSummary(stmt('SELECT * FROM broker_accounts WHERE id = ?').get(acct.id)) };
  });

  // Algo Trading strategies that can be switched on their own. ORB 5m always runs while Algo Trading is on.
  r.post('/api/brokers/:id/strategies', async ctx => {
    const acct = ownAccount(ctx.user.id, ctx.params.id);
    const change = {};
    // ORB, EMA 5/9 and EMA 9/15 are admin-only (lib/access.js): other users have Gap open 09:15 only.
    if (!isAdminEmail(ctx.user.email) && (['emaCross', 'orb', 'ema915', 'strangle'].some(k => ctx.body[k] === true) || ctx.body.strangleCfg !== undefined)) {
      throw bad('VALIDATION', 'This strategy is not available on your account.');
    }
    if (ctx.body.emaCross !== undefined) change.cross_on = v.bool(ctx.body.emaCross, 'EMA 9/21 crossover') ? 1 : 0;
    if (ctx.body.orb !== undefined) change.orb_on = v.bool(ctx.body.orb, 'ORB 5m') ? 1 : 0;
    if (ctx.body.gap !== undefined) change.gap_on = v.bool(ctx.body.gap, 'Gap open 09:15') ? 1 : 0;
    if (ctx.body.ema915 !== undefined) change.ema915_on = v.bool(ctx.body.ema915, 'EMA 9/15 5m') ? 1 : 0;
    // CE + PE at a target price: on/off, and its settings (saved together).
    if (ctx.body.strangle !== undefined) change.strangle_on = v.bool(ctx.body.strangle, 'CE + PE at a target price') ? 1 : 0;
    if (ctx.body.strangleCfg !== undefined) {
      const cfg = strangleCfgFrom(ctx.body.strangleCfg, slotCfg(acct, 'strangle', 'NIFTY'));
      change.strangle_cfg = JSON.stringify(cfg);
      // Saved through the grid since: keep its NIFTY cell in step.
      if (acct.algo_grid) { const g = algoGrid(acct); g.strangle.NIFTY.cfg = cfg; change.algo_grid = JSON.stringify(g); }
    }
    // Manual trades while Algo Trading runs: on or off at any time, also during the session.
    if (ctx.body.manual !== undefined) change.manual_on = v.bool(ctx.body.manual, 'Manual trades') ? 1 : 0;
    // Kill switch on a day the Gap open 09:15 strategy has no entry.
    if (ctx.body.gapLock !== undefined) change.gap_lock = v.bool(ctx.body.gapLock, 'Kill switch if no Gap entry') ? 1 : 0;
    // Gap open 09:15's automatic exit at 09:16 (off: the stop-loss, a manual exit or the cutoff closes it).
    if (ctx.body.gapAutoExit !== undefined) change.gap_auto_exit = v.bool(ctx.body.gapAutoExit, 'Auto exit at 09:16') ? 1 : 0;
    // Gap retest 09:15 on paper (no orders): on or off, and its retest window and stop.
    if (ctx.body.gapRetest !== undefined) change.retest_paper_on = v.bool(ctx.body.gapRetest, 'Gap retest 09:15 (paper)') ? 1 : 0;
    if (ctx.body.retestCfg !== undefined) {
      const c = ctx.body.retestCfg || {};
      change.retest_cfg = JSON.stringify({ windowMin: v.num(c.windowMin, 'Retest window (minutes)', { min: 1, max: 60, int: true }), slPct: v.num(c.slPct, 'Retest stop-loss %', { min: 0.5, max: 50 }) });
    }
    // Indices to trade: any combination of NIFTY, BANKNIFTY and SENSEX, at least one.
    const picked = ctx.body.underlyings ?? (ctx.body.underlying !== undefined ? [ctx.body.underlying] : undefined);
    if (picked !== undefined) {
      if (!Array.isArray(picked)) throw bad('VALIDATION', 'Choose the indices to trade.');
      const keys = [...new Set(picked.map(k => v.oneOf(String(k).toUpperCase(), 'Index', ['NIFTY', 'BANKNIFTY', 'SENSEX'])))];
      if (!keys.length) throw bad('VALIDATION', 'Keep at least one index ticked.');
      change.algo_underlying = ['NIFTY', 'BANKNIFTY', 'SENSEX'].filter(k => keys.includes(k)).join(',');
    }
    if (!Object.keys(change).length) throw bad('VALIDATION', 'Choose a strategy to switch on or off.');
    // An older single switch or the index list changed: the grid is read from them again (its per-index settings are lost).
    if (['orb_on', 'cross_on', 'gap_on', 'ema915_on', 'strangle_on', 'algo_underlying'].some(k => k in change)) change.algo_grid = null;
    const orbAfter = change.orb_on ?? acct.orb_on, crossAfter = change.cross_on ?? acct.cross_on, gapAfter = change.gap_on ?? acct.gap_on, trendAfter = change.ema915_on ?? acct.ema915_on, strangleAfter = change.strangle_on ?? acct.strangle_on;
    if (algoLocked(acct) && !orbAfter && !crossAfter && !gapAfter && !trendAfter && !strangleAfter) throw conflict('ALGO_LOCKED', `At least one strategy stays on while Algo Trading runs. ${ALGO_LOCK_MESSAGE}`);
    for (const [col, val] of Object.entries(change)) stmt(`UPDATE broker_accounts SET ${col} = ? WHERE id = ?`).run(val, acct.id);
    accountsChanged();
    audit(ctx.user.id, 'algo.strategy_changed', change, ctx.ip);
    emit(ctx.user.id, 'snapshot', getDashboard(ctx.user.id));
    return { account: accountSummary(stmt('SELECT * FROM broker_accounts WHERE id = ?').get(acct.id)) };
  });

  // Algo Trading grid: one strategy on one index switched on or off, and/or its settings (CE + PE). Each strategy + index
  // holds its own trade; the older single switches and the watched indices follow (algo-grid.js legacyColumns).
  r.post('/api/brokers/:id/algo-grid', async ctx => {
    const acct = ownAccount(ctx.user.id, ctx.params.id);
    const key = v.oneOf(String(ctx.body.strategy || ''), 'Strategy', Object.keys(GRID_STRATEGIES));
    const U = v.oneOf(String(ctx.body.index || '').toUpperCase(), 'Index', [...GRID_INDICES]);
    if (!isAdminEmail(ctx.user.email) && key !== 'gap') throw bad('VALIDATION', 'This strategy is not available on your account.');
    if (ctx.body.on === undefined && ctx.body.cfg === undefined) throw bad('VALIDATION', 'Switch the strategy on or off, or change its settings.');
    const grid = algoGrid(acct), cell = grid[key][U];
    if (ctx.body.on !== undefined) cell.on = v.bool(ctx.body.on, `${GRID_STRATEGIES[key].label} on ${U}`);
    if (ctx.body.cfg !== undefined) {
      if (key === 'strangle') cell.cfg = strangleCfgFrom(ctx.body.cfg, cell.cfg || {});
      else if (key === 'gap') cell.cfg = gapCfgFrom(ctx.body.cfg, cell.cfg || {});
      else throw bad('VALIDATION', `${GRID_STRATEGIES[key].label} has no settings here.`);
    }
    const cols = legacyColumns(grid);
    if (algoLocked(acct) && !Object.values(GRID_STRATEGIES).some(s => cols[s.column])) throw conflict('ALGO_LOCKED', `At least one strategy stays on while Algo Trading runs. ${ALGO_LOCK_MESSAGE}`);
    const change = { ...cols, algo_grid: JSON.stringify(grid) };
    for (const [col, val] of Object.entries(change)) stmt(`UPDATE broker_accounts SET ${col} = ? WHERE id = ?`).run(val, acct.id);
    accountsChanged();
    audit(ctx.user.id, 'algo.grid_changed', { strategy: key, index: U, on: cell.on, cfg: ctx.body.cfg !== undefined }, ctx.ip);
    emit(ctx.user.id, 'snapshot', getDashboard(ctx.user.id));
    return { account: accountSummary(stmt('SELECT * FROM broker_accounts WHERE id = ?').get(acct.id)), grid };
  });

  // Which broker places the orders: the account's own (Dhan) or the linked StoxKart account (Dhan keeps the market
  // data). Switched only with nothing open, so no position or stop-loss order is left behind at the other broker.
  r.post('/api/brokers/links/stoxkart/trade-via', async ctx => {
    const on = v.bool(ctx.body.on, 'Trade through StoxKart');
    const acct = accountFor(ctx.user.id);
    if (!acct) throw bad('NO_BROKER', 'Connect Dhan first: it supplies the market data.');
    if (on && stoxkartLink(ctx.user.id).status !== 'verified') throw bad('STOXKART_NOT_VERIFIED', 'Test the StoxKart connection first: it must show "Connected".');
    if ((acct.trade_via === 'stoxkart') === on) return { link: stoxkartLink(ctx.user.id), account: accountSummary(acct) };
    const busy = brokerBusy(acct);
    if (busy.length)
      throw conflict('BROKER_BUSY', `Close everything first: ${busy.join(', ')} at ${on ? 'Dhan' : 'StoxKart'}. Switching with anything open would leave it without TradeLock's protection.`);
    // Each broker keeps its own Protection / Algo Trading switches and its own P&L: park this one's, bring the other's.
    const fresh = await switchTradeVia(acct, on, { ip: ctx.ip });
    emit(ctx.user.id, 'snapshot', getDashboard(ctx.user.id));
    return { link: stoxkartLink(ctx.user.id), account: accountSummary(fresh) };
  });

  // AI Algo Trading: Real (Dhan) or Paper (the paper wallet, simulated fills at live prices). Only with nothing open.
  r.post('/api/brokers/:id/paper', async ctx => {
    const on = v.bool(ctx.body.on, 'Paper trading');
    const acct = ownAccount(ctx.user.id, ctx.params.id);
    if ((acct.paper_mode === 1) === on) return { account: accountSummary(acct) };
    if (!on && acct.broker === 'paper') throw bad('NO_BROKER', 'Connect your Dhan account (Broker accounts) to trade with real money.');
    const busy = brokerBusy(acct);
    if (busy.length) throw conflict('BROKER_BUSY', `Close everything first: ${busy.join(', ')} ${on ? 'with real money' : 'on paper'}. Switching with anything open would leave it unmanaged.`);
    const fresh = await switchPaper(acct, on, { ip: ctx.ip });
    notify(ctx.user.id, on
      ? { kind: 'risk', level: 'warn', title: 'Paper trading on', body: `Algo Trading now trades the paper wallet (₹${Math.round(paperWallet(ctx.user.id).balance).toLocaleString('en-IN')}) at live prices: no orders go to Dhan, and your Dhan account is not watched by TradeLock until you switch back to Real.` }
      : { kind: 'risk', level: 'warn', title: 'Real trading on', body: 'Algo Trading trades your Dhan account with real money again, and TradeLock protects it.' });
    emit(ctx.user.id, 'snapshot', getDashboard(ctx.user.id));
    return { account: accountSummary(fresh) };
  });

  // Paper trading without a broker: a Paper account (prices from TradeLock's shared Dhan market data). Connecting a
  // broker later replaces it (the connect route disconnects other brokers).
  r.post('/api/paper/account', async ctx => {
    const cur = accountFor(ctx.user.id);
    if (cur) return { account: accountSummary(cur) };
    ensurePaperAccount(ctx.user.id);
    paperWallet(ctx.user.id);
    audit(ctx.user.id, 'paper.account', {}, ctx.ip);
    const acct = accountFor(ctx.user.id);
    await syncAccount(acct, { force: true }).catch(() => {});
    emit(ctx.user.id, 'snapshot', getDashboard(ctx.user.id));
    return { account: accountSummary(accountFor(ctx.user.id)) };
  });

  // The paper wallet: its balance, set to any amount from ₹10,000 to ₹1 crore, or reset to ₹10 lakh.
  const walletView = userId => { const w = paperWallet(userId); return { balance: w.balance, startBalance: w.start_balance, todayOpening: w.sod_balance, default: PAPER_DEFAULT, min: PAPER_MIN, max: PAPER_MAX }; };
  r.get('/api/paper/wallet', ctx => walletView(ctx.user.id));
  r.put('/api/paper/wallet', ctx => {
    try { setPaperBalance(ctx.user.id, v.num(ctx.body.balance, 'Paper balance', { min: PAPER_MIN, max: PAPER_MAX })); }
    catch (e) { if (e.code === 'PAPER_BUSY') throw conflict('PAPER_BUSY', e.message); throw e.code === 'VALIDATION' ? bad('VALIDATION', e.message) : e; }
    audit(ctx.user.id, 'paper.wallet_set', { balance: ctx.body.balance }, ctx.ip);
    return walletView(ctx.user.id);
  });
  r.post('/api/paper/wallet/reset', ctx => {
    try { resetPaperWallet(ctx.user.id); }
    catch (e) { if (e.code === 'PAPER_BUSY') throw conflict('PAPER_BUSY', e.message); throw e; }
    audit(ctx.user.id, 'paper.wallet_reset', {}, ctx.ip);
    return walletView(ctx.user.id);
  });

  r.delete('/api/brokers/:id', ctx => {
    const acct = ownAccount(ctx.user.id, ctx.params.id);
    stmt(`UPDATE broker_accounts SET status = 'disconnected', token_enc = NULL WHERE id = ?`).run(acct.id);
    dropAdapter(acct.id);
    clearBook(ctx.user.id);
    audit(ctx.user.id, 'broker.disconnected', { broker: acct.broker }, ctx.ip);
    emit(ctx.user.id, 'snapshot', getDashboard(ctx.user.id));   // every open screen drops the broker now
    return { ok: true };
  });

  // Development aid: make the demo broker stop answering so the degraded state can be seen.
  if (!config.isProd) {
    r.post('/api/dev/outage', ctx => {
      const acct = accountFor(ctx.user.id);
      if (acct?.broker !== 'mock') throw bad('MOCK_ONLY', 'Outage simulation only works with the demo broker.');
      const seconds = v.num(ctx.body.seconds ?? 45, 'Seconds', { min: 0, max: 600, int: true });
      adapterFor(acct).simulateOutage(seconds);
      return { ok: true, seconds };
    });
  }
}
