// Pure pre-trade check for orders routed through TradeLock.
import { toMinutes } from '../../lib/time.js';
import { RULE_NAMES } from '../rules/service.js';
import { limitAmount, capitalLimit } from '../rules/limits.js';

const block = (code, reason) => ({ ok: false, code, reason });

/**
 * @param order { symbol, side: 'BUY'|'SELL', qty }
 * @param s     { rules, positions, orders, entryInFlight, entries, pnl, minutes, capital, price (premium the order was sized at), paused, pauseReason, killSwitchActive, subscriptionActive }
 */
export function checkOrder(order, s) {
  const pos = s.positions.find(p => p.symbol === order.symbol && p.qty !== 0);
  const signed = order.side === 'BUY' ? order.qty : -order.qty;
  // Reducing an open position is always allowed: blocking exits makes risk worse, not better.
  if (pos && Math.sign(signed) !== Math.sign(pos.qty) && Math.abs(signed) <= Math.abs(pos.qty)) {
    return { ok: true, reducing: true };
  }
  if (s.killSwitchActive) {
    const label = s.killSwitchLabel || 'broker';
    return block('KILL_SWITCH', label === 'Paper'
      ? 'Your Paper kill switch is on, so paper trading is locked for today. Switch it off on the Overview page to paper trade again.'
      : `Your ${label} kill switch is on, so trading is locked for today. Switch it off on the Overview page to trade again.`);
  }
  if (!s.subscriptionActive) return block('SUBSCRIPTION_REQUIRED', 'Your trial has ended. Subscribe to place orders through TradeLock.');
  if (s.algoOnly) return block('ALGO_ONLY', 'Algo Trading is on, so only automatic entries are placed. Exits are allowed; to trade by hand, allow manual trades on the AI Algo Trading page.');
  // The trading cutoff is an NSE / BSE session time (it must fall within 09:15–15:30): MCX trades until 23:30, so a
  // commodity order is not held back by the cutoff or by the pause the cutoff left. Every other rule still applies.
  const mcx = /^MCX/.test(String(order.exchangeSegment || ''));
  if (s.paused && !(mcx && s.pauseReason === 'rule:cutoff')) {
    const rule = s.pauseReason?.startsWith('rule:') ? RULE_NAMES[s.pauseReason.slice(5)] : null;
    return block('PAUSED', rule
      ? `New orders are paused by your ${rule} until the next session. Exits are still allowed.`
      : 'New orders are paused by the kill switch. Exits are still allowed.');
  }
  const { rules } = s;
  if (!mcx && rules.cutoff.on && s.minutes != null && s.minutes >= toMinutes(rules.cutoff.value)) {
    return block('CUTOFF', `Your ${rules.cutoff.value} IST cutoff has passed. Only exits are allowed.`);
  }
  if (rules.maxTrades.on && s.entries >= rules.maxTrades.value) {
    return block('TRADE_CAP', `You have used all ${rules.maxTrades.value} entries for today. Only exits are allowed.`);
  }
  const lossLimit = limitAmount(rules.maxLoss, s.capital);
  if (rules.maxLoss.on && lossLimit && -s.pnl >= lossLimit) {
    return block('LOSS_LIMIT', 'Your daily loss limit is reached. Only exits are allowed.');
  }
  // Capital per trade: a buy's value (its limit price, else the premium it was sized at) within the limit.
  const cap = capitalLimit(rules, s.capital), px = Number(order.price ?? s.price);
  const value = order.qty * px * (Number(order.multiplier) || 1);   // MCX: qty in lots × rupees per point per lot
  if (cap != null && order.side === 'BUY' && px > 0 && value > cap + 0.01) {
    return block('CAPITAL_LIMIT', `This order uses ₹${Math.round(value).toLocaleString('en-IN')}, more than your ₹${Math.round(cap).toLocaleString('en-IN')} capital per trade. Use fewer lots.`);
  }
  // One trade at a time: no new entry while a position is open, an order is pending, or one is being placed.
  // Algo Trading (s.concurrent): each strategy + index holds its own trade, so only an order being placed blocks.
  const open = !s.concurrent && s.positions.find(p => p.qty !== 0);
  if (open) return block('TRADE_RUNNING', `A trade is already running (${open.symbol}). Exit it before taking the next one.`);
  if (!s.concurrent && (s.orders || []).length) return block('ORDER_PENDING', 'An order is pending at the broker. Cancel it or let it fill before the next trade.');
  if (s.entryInFlight) return block('ORDER_IN_FLIGHT', 'Your previous order is still being placed. Wait for it to confirm.');
  return { ok: true, reducing: false };
}
