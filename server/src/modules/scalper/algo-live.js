// What the AI Algo Trading page shows about live auto-trading (scalper/autotrade.js): whether it can
// start, the day's stop-loss budget, the two strategies' switches and today's automatic trades.
import { getPermissions } from '../broker/book.js';
import { stoxkartLink } from '../broker/stoxkart.js';
import { getSubscription } from '../billing/service.js';
import { getRules } from '../rules/service.js';
import { limitAmount } from '../rules/limits.js';
import { dayState, capitalFor } from '../risk/service.js';
import { marketOpen } from '../../lib/time.js';
import { autoTradesToday, riskLeft, squareOffTime, algoIndices } from './autotrade.js';
import { UNDERLYINGS } from './underlyings.js';

/** Everything Algo Trading needs before it may place orders, as a checklist (all ok = may start). */
export function algoReadiness(userId, acct) {
  const rules = getRules(userId).active;
  const perms = getPermissions(userId);
  return [
    { id: 'dhan', label: 'Dhan account', ok: acct?.broker === 'dhan', detail: acct?.broker === 'dhan' ? 'Connected broker is Dhan' : 'Algo Trading needs a Dhan account.' },
    { id: 'connected', label: 'Dhan connection', ok: acct?.status === 'connected' && !!acct?.token_enc, detail: acct?.status === 'connected' ? 'Token valid, synced' : 'Reconnect Dhan first.' },
    { id: 'protection', label: 'Protection on', ok: !!acct && acct.agent_on !== 0, detail: acct && acct.agent_on !== 0 ? 'Risk rules are enforced on every entry' : 'Turn protection on first: automatic entries only run with your risk rules enforced.' },
    acct?.trade_via === 'stoxkart'
      ? { id: 'orders', label: 'Orders through StoxKart', ok: stoxkartLink(userId).status === 'verified', detail: stoxkartLink(userId).status === 'verified' ? 'StoxKart login verified; orders, stop-losses and exits go to StoxKart' : 'Test the StoxKart connection on Broker accounts: it must show "Connected".' }
      : { id: 'orders', label: 'Orders allowed from TradeLock', ok: perms?.ordersAllowed !== false, detail: perms?.ordersAllowed === false ? 'Dhan is blocking API orders from this server. Register the TradeLock server IP as your static IP in Dhan.' : 'Server IP accepted by Dhan' },
    { id: 'subscription', label: 'Subscription', ok: !!getSubscription(userId)?.active, detail: getSubscription(userId)?.active ? 'Active' : 'An active TradeLock subscription is needed to place orders.' },
    { id: 'lossLimit', label: 'Daily loss limit', ok: !!rules.maxLoss?.on, detail: rules.maxLoss?.on ? 'Sets how much each automatic trade may risk' : 'Turn on the daily loss limit in Risk rules: it sets how much each automatic trade may risk.' },
  ];
}

export function algoLive(userId, acct) {
  const rules = getRules(userId).active, s = dayState(userId), capital = capitalFor(userId, s);
  const daily = rules.maxLoss?.on ? limitAmount(rules.maxLoss, capital) : null, pnl = s.realized + s.unrealized;
  const readiness = algoReadiness(userId, acct);
  return {
    account: acct ? { id: acct.id, algoOn: acct.algo_on === 1, orbOn: acct.orb_on !== 0, emaCrossOn: acct.cross_on !== 0, gapOn: acct.gap_on === 1, ema915On: acct.ema915_on === 1, manualOn: acct.manual_on === 1, underlyings: algoIndices(acct) } : null,
    underlyings: Object.values(UNDERLYINGS).map(({ key, label }) => ({ key, label })),
    ready: readiness.every(r => r.ok), readiness, marketOpen: marketOpen(),
    budget: { capital, daily, pnl, left: daily ? riskLeft(daily, pnl) : 0, lossLimitMode: rules.maxLoss?.mode, lossLimitValue: rules.maxLoss?.value },
    rules: { cutoff: rules.cutoff?.on ? rules.cutoff.value : null, squareOff: squareOffTime(rules), tradeCap: rules.maxTrades?.on ? rules.maxTrades.value : null,
      killSwitch: !!rules.killSwitch?.on, locked: !!(s.paused || s.ks_active_at) },
    trades: autoTradesToday(userId).filter(t => !String(t.symbol || '').startsWith('TEST')),
  };
}
