// What the AI Algo Trading page shows about live auto-trading (scalper/autotrade.js): whether it can
// start, the day's stop-loss budget, the two strategies' switches and today's automatic trades.
import { getPermissions } from '../broker/book.js';
import { stoxkartLink } from '../broker/stoxkart.js';
import { getSubscription } from '../billing/service.js';
import { getRules } from '../rules/service.js';
import { limitAmount } from '../rules/limits.js';
import { dayState, capitalFor } from '../risk/service.js';
import { marketOpen } from '../../lib/time.js';
import { autoTradesToday, autoTradeHistory, riskLeft, squareOffTime, algoIndices, strangleConfig, strangleCapital, gapConfig, gapCapital } from './autotrade.js';
import { paperTrades, retestConfig } from './paper-retest.js';
import { UNDERLYINGS } from './underlyings.js';
import { isAdminUser } from '../../lib/access.js';
import { algoGrid, GRID_INDICES, GRID_STRATEGIES } from './algo-grid.js';

/** The Algo Trading grid for the page: every cell's switch; CE + PE cells with their full settings and capital now. */
const gridForPage = acct => {
  const g = algoGrid(acct), paper = acct.paper_mode === 1 ? 1 : 0;
  for (const U of GRID_INDICES) {
    const cfg = strangleConfig(acct, U), gcfg = gapConfig(acct, U);
    g.strangle[U] = { ...g.strangle[U], cfg, capitalNow: strangleCapital(acct.user_id, cfg, paper, U) };
    g.gap[U] = { ...g.gap[U], cfg: gcfg, capitalNow: gapCapital(acct.user_id, gcfg, paper, U) };
  }
  return g;
};

/** Everything Algo Trading needs before it may place orders, as a checklist (all ok = may start). */
export function algoReadiness(userId, acct) {
  const rules = getRules(userId).active;
  const perms = getPermissions(userId);
  // Paper mode (a Paper account, or Dhan switched to Paper): no broker connection or static IP is needed to trade.
  if (acct?.paper_mode === 1) return [
    { id: 'paper', label: 'Paper trading', ok: true, detail: `Simulated fills at live prices with the paper wallet${acct.broker === 'paper' ? ' (no broker connected)' : ''}` },
    { id: 'protection', label: 'Protection on', ok: acct.agent_on !== 0, detail: acct.agent_on !== 0 ? 'Risk rules are enforced on every entry' : 'Turn protection on first: automatic entries only run with your risk rules enforced.' },
    { id: 'subscription', label: 'Subscription', ok: !!getSubscription(userId)?.active, detail: getSubscription(userId)?.active ? 'Active' : 'An active TradeLock subscription is needed.' },
    { id: 'lossLimit', label: 'Daily loss limit', ok: !!rules.maxLoss?.on || isAdminUser(userId), detail: rules.maxLoss?.on ? 'Sets how much each automatic trade may risk' : isAdminUser(userId) ? 'Off: each strategy sizes its trades and stops from its own settings' : 'Turn on the daily loss limit in Risk rules: it sets how much each automatic trade may risk.' },
  ];
  return [
    { id: 'dhan', label: 'Dhan account', ok: acct?.broker === 'dhan', detail: acct?.broker === 'dhan' ? 'Connected broker is Dhan' : 'Algo Trading needs a Dhan account.' },
    { id: 'connected', label: 'Dhan connection', ok: acct?.status === 'connected' && !!acct?.token_enc, detail: acct?.status === 'connected' ? 'Token valid, synced' : 'Reconnect Dhan first.' },
    { id: 'protection', label: 'Protection on', ok: !!acct && acct.agent_on !== 0, detail: acct && acct.agent_on !== 0 ? 'Risk rules are enforced on every entry' : 'Turn protection on first: automatic entries only run with your risk rules enforced.' },
    acct?.trade_via === 'stoxkart'
      ? { id: 'orders', label: 'Orders through StoxKart', ok: stoxkartLink(userId).status === 'verified', detail: stoxkartLink(userId).status === 'verified' ? 'StoxKart login verified; orders, stop-losses and exits go to StoxKart' : 'Test the StoxKart connection on Broker accounts: it must show "Connected".' }
      : { id: 'orders', label: 'Orders allowed from TradeLock', ok: perms?.ordersAllowed !== false, detail: perms?.ordersAllowed === false ? 'Dhan is blocking API orders from this server. Register the TradeLock server IP as your static IP in Dhan.' : 'Server IP accepted by Dhan' },
    { id: 'subscription', label: 'Subscription', ok: !!getSubscription(userId)?.active, detail: getSubscription(userId)?.active ? 'Active' : 'An active TradeLock subscription is needed to place orders.' },
    { id: 'lossLimit', label: 'Daily loss limit', ok: !!rules.maxLoss?.on || isAdminUser(userId), detail: rules.maxLoss?.on ? 'Sets how much each automatic trade may risk' : isAdminUser(userId) ? 'Off: each strategy sizes its trades and stops from its own settings' : 'Turn on the daily loss limit in Risk rules: it sets how much each automatic trade may risk.' },
  ];
}

export function algoLive(userId, acct) {
  const rules = getRules(userId).active, s = dayState(userId), capital = capitalFor(userId, s);
  const daily = rules.maxLoss?.on ? limitAmount(rules.maxLoss, capital) : null, pnl = s.realized + s.unrealized;
  const readiness = algoReadiness(userId, acct);
  return {
    account: acct ? { id: acct.id, broker: acct.broker, algoOn: acct.algo_on === 1, orbOn: acct.orb_on !== 0, emaCrossOn: acct.cross_on !== 0, gapOn: acct.gap_on === 1, ema915On: acct.ema915_on === 1, manualOn: acct.manual_on === 1, gapLockOn: acct.gap_lock !== 0, gapAutoExitOn: acct.gap_auto_exit !== 0, strangleOn: acct.strangle_on === 1, grid: gridForPage(acct), gridStrategies: Object.entries(GRID_STRATEGIES).map(([key, s]) => ({ key, label: s.label, name: s.name })), strangleCfg: strangleConfig(acct), strangleCapital: strangleCapital(acct.user_id, strangleConfig(acct), acct.paper_mode === 1 ? 1 : 0), retestPaperOn: acct.retest_paper_on === 1, retestCfg: retestConfig(acct), paperMode: acct.paper_mode === 1, underlyings: algoIndices(acct) } : null,
    underlyings: Object.values(UNDERLYINGS).map(({ key, label }) => ({ key, label })),
    ready: readiness.every(r => r.ok), readiness, marketOpen: marketOpen(),
    budget: { capital, daily, pnl, left: daily ? riskLeft(daily, pnl) : 0, lossLimitMode: rules.maxLoss?.mode, lossLimitValue: rules.maxLoss?.value },
    rules: { cutoff: rules.cutoff?.on ? rules.cutoff.value : null, squareOff: squareOffTime(rules), tradeCap: rules.maxTrades?.on ? rules.maxTrades.value : null,
      killSwitch: !!rules.killSwitch?.on, locked: !!(s.paused || s.ks_active_at) },
    trades: autoTradesToday(userId).filter(t => !String(t.symbol || '').startsWith('TEST')),
    history: autoTradeHistory(userId),
    paper: paperTrades(userId),
  };
}
