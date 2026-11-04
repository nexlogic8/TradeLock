// Paper trading broker. With Paper selected on the AI Algo Trading page the account trades through this adapter
// instead of Dhan: orders fill on paper at the live price (feed tick, else Dhan's LTP), with the paper wallet's money;
// stop-loss and limit orders rest until the live price reaches them. Dhan still supplies every price (option chain,
// quotes, candles, the feed). Positions, fills, funds and a day kill switch behave like a broker's, so Algo Trading,
// the risk rules and the P&L pages run unchanged. No order ever reaches a broker.
import { stmt, tx } from '../../../db/index.js';
import { ist } from '../../../lib/time.js';
import { optionCharges } from '../../scalper/orb5-options.js';

export const PAPER_DEFAULT = 1_000_000;          // ₹10 lakh: a new wallet, and Reset
export const PAPER_MIN = 10_000, PAPER_MAX = 10_000_000;   // ₹10,000 – ₹1 crore
const TICK_FRESH_MS = 3_000, MATCH_EVERY_MS = 1_000;
const round2 = n => Math.round(n * 100) / 100;
const today = () => ist().day;
const pid = n => `P${n}`, rowId = id => Number(String(id).replace(/^P/, ''));

class PaperError extends Error { constructor(message, code = 'BROKER') { super(message); this.code = code; } }

/** The paper wallet: cash (moves with each closed trade, after charges), its start-of-day figure, the day lock. */
export function paperWallet(userId) {
  stmt('INSERT OR IGNORE INTO paper_wallet (user_id, balance, start_balance, updated_at) VALUES (?, ?, ?, ?)').run(userId, PAPER_DEFAULT, PAPER_DEFAULT, Date.now());
  const w = stmt('SELECT * FROM paper_wallet WHERE user_id = ?').get(userId), day = today();
  if (w.sod_day !== day) {   // first look today: today's opening balance
    stmt('UPDATE paper_wallet SET sod_day = ?, sod_balance = ? WHERE user_id = ?').run(day, w.balance, userId);
    return { ...w, sod_day: day, sod_balance: w.balance };
  }
  return w;
}
const openPaper = userId => stmt(`SELECT COUNT(*) AS n FROM paper_orders WHERE user_id = ? AND day = ? AND status = 'pending'`).get(userId, today()).n
  + positionsOf(userId).filter(p => p.qty !== 0).length;

/** Set the wallet to `amount` (₹10,000 – ₹1 crore). Not while a paper position or order is open. */
export function setPaperBalance(userId, amount) {
  const v = round2(Number(amount));
  if (!(v >= PAPER_MIN && v <= PAPER_MAX)) throw new PaperError('Paper balance must be between ₹10,000 and ₹1,00,00,000.', 'VALIDATION');
  if (openPaper(userId)) throw new PaperError('Close the open paper trade first.', 'PAPER_BUSY');
  paperWallet(userId);
  stmt('UPDATE paper_wallet SET balance = ?, start_balance = ?, sod_day = ?, sod_balance = ?, updated_at = ? WHERE user_id = ?').run(v, v, today(), v, Date.now(), userId);
  return paperWallet(userId);
}
export const resetPaperWallet = userId => setPaperBalance(userId, PAPER_DEFAULT);

/** Today's positions from today's paper fills (buys and sells of options), average cost. */
function positionsOf(userId, day = today()) {
  const by = new Map();
  for (const f of stmt('SELECT * FROM paper_fills WHERE user_id = ? AND day = ? ORDER BY id').all(userId, day)) {
    const p = by.get(f.security_id) || { symbol: f.symbol, securityId: f.security_id, exchangeSegment: f.segment, qty: 0, cost: 0, realized: 0 };
    if (f.side === 'BUY') { p.qty += f.qty; p.cost += f.qty * f.price; }
    else { const avg = p.qty > 0 ? p.cost / p.qty : f.price; p.realized += (f.price - avg) * f.qty; p.cost -= avg * f.qty; p.qty -= f.qty; }
    by.set(f.security_id, p);
  }
  return [...by.values()].map(p => ({ ...p, avg: p.qty > 0 ? round2(p.cost / p.qty) : 0, realized: round2(p.realized) }));
}

/** The paper broker for one account; `data` is the Dhan adapter that supplies prices (shared market data). */
export function createPaperAdapter({ userId, data }) {
  const ltpOf = async (seg, id) => {
    const { liveTick } = await import('../../scalper/live.js');   // lazily: live.js imports the broker registry
    const t = liveTick(userId, `${seg}:${id}`, { since: Date.now() - TICK_FRESH_MS });
    if (t?.ltp > 0) return t.ltp;
    return Number(await data.ltp?.(seg, id).catch(() => null)) || null;
  };
  const funds = () => {
    const w = paperWallet(userId), open = positionsOf(userId).filter(p => p.qty > 0).reduce((a, p) => a + p.qty * p.avg, 0);
    return { available: round2(w.balance - open), used: round2(open), opening: w.sod_balance, withdrawable: null, collateral: 0 };
  };
  const fill = (o, price) => tx(() => {
    const qty = o.qty - (o.filled_qty || 0), now = Date.now();
    if (o.side === 'SELL') {   // closing: the wallet takes the P&L after charges
      const pos = positionsOf(userId, o.day).find(p => p.securityId === o.security_id), avg = pos?.qty > 0 ? pos.cost / pos.qty : price;
      const charges = optionCharges(o.day, avg * qty, price * qty).total;
      stmt('UPDATE paper_wallet SET balance = balance + ?, updated_at = ? WHERE user_id = ?').run(round2((price - avg) * qty - charges), now, userId);
      stmt('INSERT INTO paper_fills (user_id, day, order_id, security_id, segment, symbol, side, qty, price, charges, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(userId, o.day, o.id, o.security_id, o.segment, o.symbol, 'SELL', qty, price, round2(charges), now);
    } else {
      stmt('INSERT INTO paper_fills (user_id, day, order_id, security_id, segment, symbol, side, qty, price, charges, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(userId, o.day, o.id, o.security_id, o.segment, o.symbol, 'BUY', qty, price, 0, now);
    }
    stmt(`UPDATE paper_orders SET status = 'filled', filled_qty = qty, avg_price = ?, updated_at = ? WHERE id = ?`).run(price, now, o.id);
  })();
  const reject = (o, reason) => stmt(`UPDATE paper_orders SET status = 'rejected', reason = ?, updated_at = ? WHERE id = ?`).run(reason, Date.now(), o.id);
  /** A pending order against the live price: market fills now; limit / stop-loss when the price reaches it. */
  async function match(o) {
    if (o.status !== 'pending') return o;
    const px = await ltpOf(o.segment, o.security_id) ?? (o.type === 'MARKET' ? o.ref_price : null);
    if (!(px > 0)) { if (o.type === 'MARKET') reject(o, 'No live price for the paper fill'); return stmt('SELECT * FROM paper_orders WHERE id = ?').get(o.id); }
    const hit = o.type === 'MARKET' || (o.type === 'STOP_LOSS' ? (o.side === 'SELL' ? px <= o.trigger_price : px >= o.trigger_price)
      : (o.side === 'BUY' ? px <= o.limit_price : px >= o.limit_price));
    if (hit) {
      if (o.side === 'BUY' && px * o.qty > funds().available + 0.01) reject(o, `Insufficient funds: ₹${round2(px * o.qty)} needed, ₹${funds().available} available in the paper wallet`);
      else if (o.side === 'SELL' && !(positionsOf(userId, o.day).find(p => p.securityId === o.security_id)?.qty >= o.qty)) reject(o, 'Paper trading sells only what it holds');
      else fill(o, round2(px));
    }
    return stmt('SELECT * FROM paper_orders WHERE id = ?').get(o.id);
  }
  const statusOf = o => (o.status === 'filled' ? { status: 'filled', price: o.avg_price, filledQty: o.filled_qty, qty: o.qty }
    : o.status === 'pending' ? { status: 'pending', filledQty: 0, qty: o.qty }
    : { status: 'failed', reason: o.reason || `Order ${o.status}`, filledQty: 0, qty: o.qty });
  const place = async o => {
    if (!o.securityId || !o.exchangeSegment) throw new PaperError('Orders need a security ID and exchange segment', 'VALIDATION');
    const r = stmt(`INSERT INTO paper_orders (user_id, day, security_id, segment, symbol, side, type, qty, trigger_price, limit_price, ref_price, status, filled_qty, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',0,?,?)`).run(userId, today(), String(o.securityId), o.exchangeSegment, o.symbol || String(o.securityId), o.side, o.type, o.qty,
      o.triggerPrice ?? null, o.price ?? null, o.refPrice ?? null, Date.now(), Date.now());
    const row = await match(stmt('SELECT * FROM paper_orders WHERE id = ?').get(r.lastInsertRowid));
    adapters.set(userId, adapter);
    return { id: pid(row.id), status: 'pending' };
  };

  const adapter = {
    ...data,
    label: 'Paper', tradingBroker: 'paper', paper: true,
    capabilities: { positions: 'available', squareOff: 'available', accountLock: 'killswitch' },   // paper fills, exits and the paper day lock
    permissions: undefined, tradeHistory: undefined,   // no static-IP check or broker trade book on paper
    async verify() { return { ok: true }; },
    placeOrder: place,
    async orderStatus(id) {
      const rows = String(id).split(',').filter(Boolean).map(x => stmt('SELECT * FROM paper_orders WHERE id = ? AND user_id = ?').get(rowId(x), userId)).filter(Boolean);
      if (!rows.length) return { status: 'pending', filledQty: 0, qty: 0 };
      const parts = await Promise.all(rows.map(async o => statusOf(await match(o))));
      return parts.length === 1 ? parts[0] : { ...parts[0], filledQty: parts.reduce((a, p) => a + p.filledQty, 0), qty: parts.reduce((a, p) => a + p.qty, 0) };
    },
    async cancelOrder(id) {
      for (const x of String(id).split(',').filter(Boolean)) {
        const o = stmt('SELECT * FROM paper_orders WHERE id = ? AND user_id = ?').get(rowId(x), userId);
        if (!o) throw new PaperError(`Order ${x} not found`);
        if (o.status === 'filled') throw new PaperError('Order already traded');
        if (o.status === 'pending') stmt(`UPDATE paper_orders SET status = 'cancelled', updated_at = ? WHERE id = ?`).run(Date.now(), o.id);
      }
      return { status: 'cancelled' };
    },
    async modifyStopLoss(id, { triggerPrice, price }) {
      for (const x of String(id).split(',').filter(Boolean)) stmt(`UPDATE paper_orders SET trigger_price = ?, limit_price = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = 'pending'`)
        .run(triggerPrice, price ?? null, Date.now(), rowId(x), userId);
      return { id, status: 'pending' };
    },
    exitPosition: p => place({ symbol: p.symbol, side: p.qty > 0 ? 'SELL' : 'BUY', qty: Math.abs(p.qty), type: 'MARKET', securityId: p.securityId, exchangeSegment: p.exchangeSegment, productType: 'INTRADAY' }),
    // The day lock (as Dhan's kill switch): no new paper entries until the next trading day.
    async getKillSwitch() { return paperWallet(userId).ks_day === today(); },
    async activateKillSwitch() { stmt('UPDATE paper_wallet SET ks_day = ? WHERE user_id = ?').run(today(), userId); return { message: 'Paper kill switch on: paper trading is locked for the rest of the day.' }; },
    async snapshot() {
      for (const o of stmt(`SELECT * FROM paper_orders WHERE user_id = ? AND day = ? AND status = 'pending'`).all(userId, today())) await match(o);
      const pos = positionsOf(userId), open = stmt(`SELECT * FROM paper_orders WHERE user_id = ? AND day = ? AND status = 'pending'`).all(userId, today());
      const positions = await Promise.all(pos.map(async p => {
        const ltp = p.qty !== 0 ? await ltpOf(p.exchangeSegment, p.securityId) : null;
        return { symbol: p.symbol, securityId: p.securityId, exchangeSegment: p.exchangeSegment, productType: 'INTRADAY', qty: p.qty, carryQty: 0, avg: p.avg, ltp,
          realized: p.realized, unrealized: p.qty !== 0 && ltp > 0 ? round2((ltp - p.avg) * p.qty) : 0 };
      }));
      const fills = stmt('SELECT * FROM paper_fills WHERE user_id = ? AND day = ? ORDER BY id').all(userId, today());
      return {
        posSig: positions.map(p => `${p.securityId}:${p.qty}`).join('|'), orderSig: open.map(o => `${o.id}:${o.status}`).join('|') + `#${fills.length}`,
        funds: funds(), positions,
        orders: open.map(o => ({ id: pid(o.id), symbol: o.symbol, side: o.side, qty: o.qty, price: o.limit_price ?? o.trigger_price, type: o.type, status: 'PENDING' })),
        trades: fills.map(f => ({ id: `paper:${f.id}`, orderId: pid(f.order_id), ts: f.created_at, symbol: f.symbol, side: f.side, qty: f.qty, price: f.price, pnl: null })),
      };
    },
  };
  adapters.set(userId, adapter);
  return adapter;
}

// Resting paper stop-loss and limit orders are checked against the live price every second, as an exchange would.
const adapters = new Map();
const matcher = setInterval(() => {
  for (const [userId, a] of adapters) {
    let pending;
    try { pending = stmt(`SELECT COUNT(*) AS n FROM paper_orders WHERE user_id = ? AND day = ? AND status = 'pending'`).get(userId, today()).n; } catch { continue; }
    if (pending) a.orderStatus(stmt(`SELECT GROUP_CONCAT('P' || id) AS ids FROM paper_orders WHERE user_id = ? AND day = ? AND status = 'pending'`).get(userId, today()).ids).catch(() => {});
  }
}, MATCH_EVERY_MS);
matcher.unref?.();
