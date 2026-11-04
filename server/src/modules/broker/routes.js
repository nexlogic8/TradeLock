import { stmt } from '../../db/index.js';
import { bad, notFound, HttpError } from '../../lib/errors.js';
import { v } from '../../lib/validate.js';
import { limit } from '../../lib/ratelimit.js';
import { config } from '../../config.js';
import { CATALOG, createAdapter, adapterFor, dropAdapter, accountFor, accountSummary, upsertAccount, accountsChanged } from './registry.js';
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
    // A new account starts with the default strategy only: Gap open 09:15 (Algo Trading itself stays off until switched on).
    if (isNew) stmt('UPDATE broker_accounts SET gap_on = 1, orb_on = 0, cross_on = 0, ema915_on = 0 WHERE id = ?').run(acct.id);
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
    if (!isAdminEmail(ctx.user.email) && ['emaCross', 'orb', 'ema915', 'gapRetest'].some(k => ctx.body[k] === true)) {
      throw bad('VALIDATION', 'This strategy is not available on your account.');
    }
    if (ctx.body.emaCross !== undefined) change.cross_on = v.bool(ctx.body.emaCross, 'EMA 9/21 crossover') ? 1 : 0;
    if (ctx.body.orb !== undefined) change.orb_on = v.bool(ctx.body.orb, 'ORB 5m') ? 1 : 0;
    if (ctx.body.gap !== undefined) change.gap_on = v.bool(ctx.body.gap, 'Gap open 09:15') ? 1 : 0;
    if (ctx.body.ema915 !== undefined) change.ema915_on = v.bool(ctx.body.ema915, 'EMA 9/15 5m') ? 1 : 0;
    // Manual trades while Algo Trading runs: on or off at any time, also during the session.
    if (ctx.body.manual !== undefined) change.manual_on = v.bool(ctx.body.manual, 'Manual trades') ? 1 : 0;
    // Kill switch on a day the Gap open 09:15 strategy has no entry.
    if (ctx.body.gapLock !== undefined) change.gap_lock = v.bool(ctx.body.gapLock, 'Kill switch if no Gap entry') ? 1 : 0;
    // Gap retest 09:15 on paper (no orders): on or off, and its retest window and stop.
    if (ctx.body.gapRetest !== undefined) change.retest_paper_on = v.bool(ctx.body.gapRetest, 'Gap retest 09:15 (paper)') ? 1 : 0;
    if (ctx.body.retestCfg !== undefined) {
      if (!isAdminEmail(ctx.user.email)) throw bad('VALIDATION', 'This strategy is not available on your account.');
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
    const orbAfter = change.orb_on ?? acct.orb_on, crossAfter = change.cross_on ?? acct.cross_on, gapAfter = change.gap_on ?? acct.gap_on, trendAfter = change.ema915_on ?? acct.ema915_on;
    if (algoLocked(acct) && !orbAfter && !crossAfter && !gapAfter && !trendAfter) throw conflict('ALGO_LOCKED', `At least one strategy stays on while Algo Trading runs. ${ALGO_LOCK_MESSAGE}`);
    for (const [col, val] of Object.entries(change)) stmt(`UPDATE broker_accounts SET ${col} = ? WHERE id = ?`).run(val, acct.id);
    accountsChanged();
    audit(ctx.user.id, 'algo.strategy_changed', change, ctx.ip);
    emit(ctx.user.id, 'snapshot', getDashboard(ctx.user.id));
    return { account: accountSummary(stmt('SELECT * FROM broker_accounts WHERE id = ?').get(acct.id)) };
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
    const busy = brokerBusy(acct);
    if (busy.length) throw conflict('BROKER_BUSY', `Close everything first: ${busy.join(', ')} ${on ? 'with real money' : 'on paper'}. Switching with anything open would leave it unmanaged.`);
    const fresh = await switchPaper(acct, on, { ip: ctx.ip });
    notify(ctx.user.id, on
      ? { kind: 'risk', level: 'warn', title: 'Paper trading on', body: `Algo Trading now trades the paper wallet (₹${Math.round(paperWallet(ctx.user.id).balance).toLocaleString('en-IN')}) at live prices: no orders go to Dhan, and your Dhan account is not watched by TradeLock until you switch back to Real.` }
      : { kind: 'risk', level: 'warn', title: 'Real trading on', body: 'Algo Trading trades your Dhan account with real money again, and TradeLock protects it.' });
    emit(ctx.user.id, 'snapshot', getDashboard(ctx.user.id));
    return { account: accountSummary(fresh) };
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
