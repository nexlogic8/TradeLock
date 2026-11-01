// Switching the trading broker: the account's own (Dhan) or the linked StoxKart (Dhan keeps the market data). Used by
// the Trade-via switch on the Brokers page and by Algo Trading's pre-open fallback (autotrade.js preopenRoute).
import { stmt } from '../../db/index.js';
import { dropAdapter } from './registry.js';
import { clearBook, getBook } from './book.js';
import { FLAGS, swapBrokerState, tradingBroker } from './per-broker.js';
import { forgetDays } from '../risk/service.js';
import { syncAccount } from '../risk/monitor.js';
import { audit } from '../audit/service.js';

/** What is open now (positions, pending orders, an Algo Trading trade): a switch must wait until it is all closed. */
export function brokerBusy(acct) {
  const book = getBook(acct.user_id), openPos = (book.positions || []).filter(p => Number(p.qty) !== 0), pending = book.orders || [];
  const openAuto = stmt(`SELECT COUNT(*) AS n FROM auto_trades WHERE user_id = ? AND status IN ('placing', 'open', 'closing')`).get(acct.user_id).n;
  return [openPos.length && `${openPos.length} open position${openPos.length > 1 ? 's' : ''}`, pending.length && `${pending.length} pending order${pending.length > 1 ? 's' : ''}`,
    openAuto && 'an Algo Trading trade'].filter(Boolean);
}

/**
 * Trade through StoxKart (on) or the account's own broker. Each broker keeps its own switches and P&L: this one's are
 * parked and the other's brought back, unless carryFlags (the fallback): then the switches in use now come along, so
 * Algo Trading keeps running as set. Returns the fresh account row, synced with the new broker.
 */
export async function switchTradeVia(acct, on, { carryFlags = false, ip = null, reason, sync = syncAccount } = {}) {
  const to = on ? 'stoxkart' : acct.broker;
  swapBrokerState(acct, tradingBroker(acct), to);
  if (carryFlags) stmt(`UPDATE broker_accounts SET ${FLAGS.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...FLAGS.map(k => acct[k]), acct.id);
  stmt('UPDATE broker_accounts SET trade_via = ? WHERE id = ?').run(on ? 'stoxkart' : 'own', acct.id);
  forgetDays(acct.user_id); clearBook(acct.user_id);
  dropAdapter(acct.id);
  audit(acct.user_id, 'broker.trade_via', { to, ...(reason ? { reason } : {}) }, ip);
  await sync(stmt('SELECT * FROM broker_accounts WHERE id = ?').get(acct.id), { force: true }).catch(() => {});
  return stmt('SELECT * FROM broker_accounts WHERE id = ?').get(acct.id);
}
