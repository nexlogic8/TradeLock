// Pure rule evaluation. No I/O, so it is easy to test and reason about.
// Kill rules (losing streak, profit give-back, drawdown) follow GROWCONTROL's engine/kill_rules.py.
import { toMinutes } from '../../lib/time.js';
import { limitsFor, givebackArmAt } from '../rules/limits.js';

const inr = v => `${v < 0 ? '−' : ''}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`;
export const LOSS_WARN_AT = 0.8;

/**
 * @param rules  active rule config
 * @param s      { pnl, entries, minutes, capital, closed } — day P&L (realized + open), entries used,
 *               IST minutes during the session (null outside market hours: cutoff is skipped),
 *               starting capital for percentage rules (null: those rules cannot be checked yet),
 *               today's closed round-trip trades in close order (see closedTrades)
 * @returns triggers: { id, rule, level: 'warn'|'breach', action, title, body }
 */
export function evaluate(rules, s) {
  const out = [];
  const { maxLoss, maxTrades, profitLock, cutoff, lossStreak, giveback } = rules;
  const lim = limitsFor(rules, s.capital);
  const of = r => (r.mode === 'percent' ? ` (${r.value}% of ${inr(s.capital)} capital)` : '');
  const closed = s.closed || [];

  if (maxLoss.on && lim.maxLoss) {
    const loss = Math.max(0, -s.pnl);
    if (loss >= lim.maxLoss) {
      out.push({ id: 'maxLoss.breach', rule: 'maxLoss', level: 'breach', action: maxLoss.action,
        title: 'Daily loss limit reached', body: `Day P&L ${inr(s.pnl)} crossed your ${inr(-lim.maxLoss)} limit${of(maxLoss)}.` });
    } else if (loss >= lim.maxLoss * LOSS_WARN_AT) {
      out.push({ id: 'maxLoss.warn', rule: 'maxLoss', level: 'warn', action: 'alert',
        title: 'Daily loss limit approaching', body: `Day P&L ${inr(s.pnl)} is ${Math.round((loss / lim.maxLoss) * 100)}% of your ${inr(-lim.maxLoss)} limit${of(maxLoss)}.` });
    }
  }

  // Losing streak: N closed trades in a row with a loss, counted back from the latest close.
  if (lossStreak?.on && lossStreak.value > 0) {
    const streak = consecutiveLosses(closed);
    if (streak >= lossStreak.value) {
      out.push({ id: 'lossStreak.breach', rule: 'lossStreak', level: 'breach', action: 'exit',
        title: `${streak} losing trades in a row`, body: `Your last ${streak} closed trades were all losses. Stop for the day.` });
    }
  }

  // Profit give-back: protects profit already booked. The peak only moves when a trade closes, so a
  // trade's own swings never trigger it; it arms once the booked peak reaches the stop-loss amount.
  const armAt = givebackArmAt(rules, s.capital);
  if (giveback?.on && giveback.value > 0 && armAt != null) {
    const peak = closedPeak(closed);
    if (peak > 0 && peak >= armAt && s.pnl <= peak * (1 - giveback.value / 100)) {
      const pct = Math.round(((peak - s.pnl) / peak) * 1000) / 10;
      out.push({ id: 'giveback.breach', rule: 'giveback', level: 'breach', action: 'exit',
        title: `Gave back ${pct}% of today's booked profit`, body: `Booked profit peaked at ${inr(peak)}; day P&L is now ${inr(s.pnl)} (limit: ${giveback.value}% give-back).` });
    }
  }

  if (maxTrades.on) {
    if (s.entries >= maxTrades.value) {
      out.push({ id: 'maxTrades.breach', rule: 'maxTrades', level: 'breach', action: maxTrades.action,
        title: 'Trade cap reached', body: `${s.entries} of ${maxTrades.value} entries used. Only exits are allowed for the rest of the day.` });
    } else if (maxTrades.value > 1 && s.entries === maxTrades.value - 1) {
      out.push({ id: 'maxTrades.warn', rule: 'maxTrades', level: 'warn', action: 'alert',
        title: `${s.entries} of ${maxTrades.value} trades used today`, body: 'One more entry allowed before new orders pause.' });
    }
  }

  if (profitLock.on && lim.profitLock && s.pnl >= lim.profitLock) {
    out.push({ id: 'profitLock.breach', rule: 'profitLock', level: 'breach', action: profitLock.action,
      title: 'Profit target reached', body: `Day P&L ${inr(s.pnl)} reached your ${inr(lim.profitLock)} profit lock${of(profitLock)}.` });
  }

  if (cutoff.on && s.minutes != null && s.minutes >= toMinutes(cutoff.value)) {
    out.push({ id: 'cutoff.breach', rule: 'cutoff', level: 'breach', action: cutoff.action,
      title: 'Trading cutoff reached', body: `It is past ${cutoff.value} IST. New orders through TradeLock are stopped.` });
  }

  return out;
}

/**
 * Counts entries: orders that open or add to a position. Exits do not count; a reversal counts once.
 * One order often fills in several pieces (exchange freeze quantity, liquidity), so fills of the same
 * order count once. Fills saved before order ids were kept are grouped by symbol, side and second.
 */
export function countEntries(fills) {
  const net = new Map();
  const counted = new Set();
  let n = 0;
  for (const f of fills) {
    const cur = net.get(f.symbol) || 0;
    const d = f.side === 'BUY' ? f.qty : -f.qty;
    const next = cur + d;
    const opens = cur === 0 || Math.sign(d) === Math.sign(cur) || (next !== 0 && Math.sign(next) !== Math.sign(cur));
    const order = f.orderId ? `o:${f.orderId}` : `t:${f.symbol}|${f.side}|${Math.floor((f.ts || 0) / 1000)}`;
    if (opens && !counted.has(order)) { counted.add(order); n++; }
    net.set(f.symbol, next);
  }
  return n;
}

/**
 * Rebuild today's round-trip trades from fills (average-cost). A trade starts when a symbol goes from
 * flat to a position and closes when it is flat again; its P&L is the realized P&L in between.
 * Computed from fills, so it works for brokers whose trade book carries no P&L (Dhan).
 * @returns [{ symbol, pnl, closedAt }] in close order
 */
export function closedTrades(fills) {
  const pos = new Map();
  const out = [];
  for (const f of fills) {
    const p = pos.get(f.symbol) || { qty: 0, avg: 0, realized: 0 };
    const d = f.side === 'BUY' ? f.qty : -f.qty;
    if (p.qty === 0 || Math.sign(d) === Math.sign(p.qty)) {
      p.avg = (p.avg * Math.abs(p.qty) + f.price * f.qty) / (Math.abs(p.qty) + f.qty);
      p.qty += d;
    } else {
      const closing = Math.min(f.qty, Math.abs(p.qty));
      p.realized += closing * (f.price - p.avg) * Math.sign(p.qty);
      const before = p.qty;
      p.qty += d;
      if (p.qty === 0 || Math.sign(p.qty) !== Math.sign(before)) {
        out.push({ symbol: f.symbol, pnl: Math.round(p.realized * 100) / 100, closedAt: f.ts });
        p.realized = 0;
        p.avg = p.qty === 0 ? 0 : f.price; // a reversal opens the next trade at this price
      }
    }
    pos.set(f.symbol, p);
  }
  return out;
}

/** Losing closed trades in a row, counting back from the most recent close. */
export function consecutiveLosses(closed) {
  let n = 0;
  for (let i = closed.length - 1; i >= 0 && closed[i].pnl < 0; i--) n++;
  return n;
}

/** Highest cumulative realized P&L after any close today (never below 0). */
export function closedPeak(closed) {
  let running = 0, peak = 0;
  for (const t of closed) { running += t.pnl; peak = Math.max(peak, running); }
  return Math.round(peak * 100) / 100;
}
