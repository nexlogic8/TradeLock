// Simulated NIFTY options book so the whole product can be tried without a broker account.
// Implements the same adapter contract as dhan.js (see ../registry.js).
import { ist } from '../../../lib/time.js';

const LOT = 75;
const tick = p => Math.max(0.05, Math.round(p * 20) / 20);
const r2 = n => Math.round(n * 100) / 100;

export function createMockAdapter() {
  let day = null;
  let seq = 0;
  let failUntil = 0;
  let killedDay = null;
  let prices = {};
  const positions = new Map();
  const exits = new Map();
  let orders = [];
  let trades = [];
  const nextId = prefix => `${prefix}-${day}-${++seq}`;
  const ltp = s => (prices[s] ??= 100);

  function fill(symbol, side, qty, price, ts) {
    const p = positions.get(symbol) || { symbol, qty: 0, avg: 0, realized: 0 };
    const d = side === 'BUY' ? qty : -qty;
    let pnl = null;
    if (p.qty === 0 || Math.sign(d) === Math.sign(p.qty)) {
      p.avg = (p.avg * Math.abs(p.qty) + price * qty) / (Math.abs(p.qty) + qty);
      p.qty += d;
    } else {
      const closing = Math.min(qty, Math.abs(p.qty));
      pnl = closing * (price - p.avg) * Math.sign(p.qty);
      p.realized += pnl;
      p.qty += d;
      if (qty > closing) p.avg = price;
    }
    positions.set(symbol, p);
    trades.push({ id: nextId('T'), ts, symbol, side, qty, price, pnl: pnl === null ? null : r2(pnl) });
  }

  // Each new IST day starts from the same morning: one round trip, one open put, one resting order.
  function ensureDay() {
    const d = ist().day;
    if (d === day) return;
    day = d; seq = 0;
    positions.clear(); exits.clear(); orders = []; trades = [];
    prices = { 'NIFTY 25000 CE': 158.8, 'NIFTY 24950 PE': 95.8, 'NIFTY 25100 CE': 84.1 };
    const now = Date.now(), m = 60e3;
    fill('NIFTY 25000 CE', 'BUY', LOT, 112.4, now - 145 * m);
    fill('NIFTY 25000 CE', 'SELL', LOT, 158.8, now - 100 * m);
    fill('NIFTY 24950 PE', 'BUY', LOT, 96.2, now - 33 * m);
    orders.push({ id: nextId('O'), symbol: 'NIFTY 25100 CE', side: 'BUY', qty: LOT, price: 80, type: 'LIMIT', status: 'PENDING' });
  }

  function walk() {
    for (const k in prices) prices[k] = tick(prices[k] * (1 + (Math.random() - 0.5) * 0.006));
    for (const o of [...orders]) {
      const hit = o.side === 'BUY' ? ltp(o.symbol) <= o.price : ltp(o.symbol) >= o.price;
      if (hit) { orders = orders.filter(x => x !== o); fill(o.symbol, o.side, o.qty, o.price, Date.now()); }
    }
  }

  return {
    label: 'Demo broker',
    alwaysOn: true, // keeps syncing outside market hours so the demo is always live
    capabilities: { positions: 'available', squareOff: 'available', accountLock: 'killswitch' },

    async verify() { return true; },

    async snapshot() {
      if (Date.now() < failUntil) throw Object.assign(new Error('Demo broker is not responding'), { code: 'TIMEOUT' });
      ensureDay();
      walk();
      return {
        positions: [...positions.values()].map(p => ({
          symbol: p.symbol, qty: p.qty, avg: r2(p.avg), ltp: ltp(p.symbol),
          realized: r2(p.realized), unrealized: r2(p.qty * (ltp(p.symbol) - p.avg)),
        })),
        orders: orders.map(o => ({ ...o })),
        trades: trades.map(t => ({ ...t })),
        funds: (() => {
          const realized = [...positions.values()].reduce((a, p) => a + p.realized, 0);
          const used = r2([...positions.values()].reduce((a, p) => a + Math.abs(p.qty) * p.avg, 0));
          const opening = 250000;
          return { opening, used, available: r2(opening + realized - used), withdrawable: r2(opening - used), collateral: 0 };
        })(),
      };
    },

    async placeOrder(o) {
      ensureDay();
      if (killedDay === day) throw new Error('Kill switch is active on this account');
      if (o.type === 'LIMIT') {
        const ord = { id: nextId('O'), symbol: o.symbol, side: o.side, qty: o.qty, price: o.price, type: 'LIMIT', status: 'PENDING' };
        orders.push(ord);
        return { id: ord.id, status: 'pending' };
      }
      const px = ltp(o.symbol);
      fill(o.symbol, o.side, o.qty, px, Date.now());
      return { id: nextId('O'), status: 'filled', price: px };
    },

    async cancelOrder(orderId) {
      if (!orders.some(o => o.id === orderId)) throw new Error('Order is no longer open');
      orders = orders.filter(o => o.id !== orderId);
      return { status: 'cancelled' };
    },

    async exitPosition(p) {
      const id = nextId('X');
      exits.set(id, { readyAt: Date.now() + 1500, symbol: p.symbol, failing: process.env.MOCK_EXIT_FAIL === '1' });
      return { id, status: 'pending' };
    },

    async orderStatus(id) {
      const x = exits.get(id);
      if (!x) return { status: 'failed', reason: 'Unknown order' };
      if (Date.now() < x.readyAt) return { status: 'pending' };
      if (x.failing) return { status: 'failed', reason: 'Rejected by exchange: freeze quantity exceeded' };
      if (!x.done) {
        const pos = positions.get(x.symbol);
        x.price = ltp(x.symbol);
        if (pos?.qty) fill(x.symbol, pos.qty > 0 ? 'SELL' : 'BUY', Math.abs(pos.qty), x.price, Date.now());
        x.done = true;
      }
      return { status: 'filled', price: x.price };
    },

    async getKillSwitch() { ensureDay(); return killedDay === day; },

    async permissions() {
      return { ordersAllowed: true, serverIp: '127.0.0.1', registeredIps: ['127.0.0.1'], ipChangedOn: [], tokenValidUntil: null, segments: ['E', 'D'], checkedAt: Date.now() };
    },

    async activateKillSwitch() {
      ensureDay();
      if ([...positions.values()].some(p => p.qty !== 0) || orders.length) throw new Error('Close all positions and cancel pending orders first');
      killedDay = day;
      return { message: 'Kill switch activated' };
    },

    async deactivateKillSwitch() { killedDay = null; return { message: 'Kill switch deactivated' }; },

    // Dev-only hook used by the "simulate outage" control.
    simulateOutage(seconds) { failUntil = Date.now() + seconds * 1000; },
  };
}
