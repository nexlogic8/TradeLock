// StoxKart (Superr API) trading adapter: positions, orders, trades and funds, placing / modifying / cancelling
// orders and exits, in TradeLock's adapter shapes (see broker/registry.js). Market data stays with Dhan: the same
// NSE instrument tokens are used by both (StoxKart token 51334 = Dhan security id 51334), so contracts picked from
// Dhan's option chain are ordered on StoxKart as they are.
//
// Session: the TOTP login (broker/stoxkart.js) runs on demand and again whenever StoxKart refuses the token.
// Rate limits (StoxKart): order book, trade book, positions and funds 1 request/second each; orders 10/second.
// Order status reads one shared, briefly cached order book. Orders above the freeze quantity are split into legs
// here ("A,B" ids, like Dhan's sliced orders); StoxKart has no slicing API.
// MARKET orders are refused for the API platform ("MARKET order not allow for api platform"), so a market order goes
// as a LIMIT at the live price (Dhan LTP) ± MARKET_BAND, on the 0.05 tick: it fills at once like a market order but
// never further than the band. A stop-loss-market goes as a stop-loss-limit with the same band past the trigger.
// Not available through StoxKart's API: an account kill switch, static-IP status and trade history before today.
import { request } from '../../../lib/httpclient.js';
import { createStoxkartClient, STOXKART_BASE, DEFAULT_ALGO_ID } from '../stoxkart.js';

class BrokerError extends Error {
  constructor(message, code = 'BROKER') { super(message); this.code = code; }
}
const num = x => { const n = Number(String(x ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
const legs = id => String(id).split(',').filter(Boolean);
const EXCH_OUT = { NSE_FNO: 'NFO', NSE_EQ: 'NSE', BSE_EQ: 'BSE' }, EXCH_IN = { NFO: 'NSE_FNO', NSE: 'NSE_EQ', BSE: 'BSE_EQ' };
const PRODUCT_OUT = { INTRADAY: 'INTRADAY', MARGIN: 'CARRYFORWARD', CARRYFORWARD: 'CARRYFORWARD', CNC: 'DELIVERY', DELIVERY: 'DELIVERY' };
const PRODUCT_IN = { I: 'INTRADAY', INTRADAY: 'INTRADAY', M: 'MARGIN', CARRYFORWARD: 'MARGIN', D: 'CNC', DELIVERY: 'CNC' };
const DONE = new Set(['EXECUTED', 'COMPLETE', 'COMPLETED', 'TRADED', 'FILLED']), FAILED = new Set(['REJECTED', 'CANCELLED', 'CANCELED', 'EXPIRED']);
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
/** "26-10-2026 13:41:33" or "26-Oct-2026 13:41:33" (IST) → epoch ms. */
export function stoxkartTime(s) {
  const m = /^(\d{1,2})-([A-Za-z]{3}|\d{1,2})-(\d{4})[ T](\d{1,2}):(\d{2}):(\d{2})/.exec(String(s || ''));
  if (!m) return NaN;
  const mon = /\d/.test(m[2]) ? Number(m[2]) - 1 : MONTHS[m[2].toLowerCase()];
  return Date.UTC(Number(m[3]), mon, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])) - 330 * 60_000;
}

/**
 * `creds`: { clientId, password, apiKey, apiSecret, totpSecret, algoId }. algoId (SEBI algo tag, default 99999) goes on every call. `transport` swappable in tests.
 * `ltp(segment, securityId)` → last price (Dhan market data), used to price market orders as protected limits.
 * `freezeQty`: largest single order (NIFTY 3510 = 54 lots of 65); bigger orders go as several legs.
 */
export const MARKET_BAND = 0.05;
const TICK = 0.05;
/** A limit price `band` beyond `price` (above for a buy, below for a sell), on the tick. */
export function protectedPrice(side, price, band = MARKET_BAND) {
  const ticks = side === 'BUY' ? Math.ceil(price * (1 + band) / TICK - 1e-9) : Math.floor(price * (1 - band) / TICK + 1e-9);
  return Math.max(1, ticks) * TICK;
}
const tickStr = x => (Math.round(x / TICK) * TICK).toFixed(2);

export function createStoxkartAdapter({ creds, transport = request, freezeQty = 3510, now = () => Date.now(), ltp = null }) {
  const client = createStoxkartClient({ ...creds, transport });
  let token = null, loggingIn = null, bookAt = 0, bookPromise = null;
  const session = async (fresh = false) => {
    if (token && !fresh) return token;
    loggingIn ??= client.login().then(t => { token = t; return t; }).finally(() => { loggingIn = null; });
    return loggingIn;
  };
  async function call(method, path, body, { retry = true } = {}) {
    const t = await session();
    let res;
    try {
      res = await transport(method, STOXKART_BASE + path, { headers: { Accept: 'application/json', ...(body !== undefined && { 'Content-Type': 'application/json' }),
        'X-API-Key': creds.apiKey, 'X-API-Secret': creds.apiSecret, 'X-Platform': 'api', 'X-Access-Token': t, 'X-Client-Id': creds.clientId,
        'X-Algo-Id': creds.algoId || DEFAULT_ALGO_ID }, body, timeoutMs: 8_000 });
    } catch (e) { throw new BrokerError(e.code === 'TIMEOUT' ? 'StoxKart did not respond within 8 seconds' : 'Could not reach StoxKart', 'NETWORK'); }
    let data = null;
    try { data = res.text ? JSON.parse(res.text) : null; } catch { /* non-JSON */ }
    const msg = String(data?.message || data?.error || '');
    // An expired or replaced session: log in again once.
    if (retry && (res.status === 401 || /token|session|unauthori[sz]ed|login/i.test(msg) && data?.status !== 'success' && res.status !== 403)) {
      await session(true);
      return call(method, path, body, { retry: false });
    }
    if (res.status === 403) throw new BrokerError('StoxKart rate limit reached; trying again shortly', 'RATE_LIMIT');
    if (res.status < 200 || res.status >= 300 || (data?.status && data.status !== 'success')) throw new BrokerError(msg || `StoxKart returned HTTP ${res.status}`);
    return data || {};
  }
  /** The order book, shared by status checks for up to 900 ms (StoxKart allows one read a second). */
  const orderBook = () => {
    if (bookPromise && now() - bookAt < 900) return bookPromise;
    bookAt = now();
    bookPromise = call('GET', '/reports/order-book').then(r => Array.isArray(r.data) ? r.data : []);
    bookPromise.catch(() => { bookPromise = null; });
    return bookPromise;
  };
  const statusOf = o => {
    const s = String(o?.status || '').toUpperCase(), filledQty = num(o?.traded_quantity), price = num(o?.trade_average_price) || num(o?.price), qty = num(o?.quantity);
    if (DONE.has(s) || (qty > 0 && filledQty >= qty)) return { status: 'filled', price, filledQty, qty };
    if (FAILED.has(s)) return { status: 'failed', reason: o.reason ? String(o.reason).replace(/^RMS:\d+:/, '').slice(0, 300) : `Order ${s.toLowerCase()}`, filledQty, price, qty };
    return { status: 'pending', filledQty, price, qty };
  };
  const exchangeFor = seg => { const e = EXCH_OUT[seg] || (Object.values(EXCH_OUT).includes(seg) ? seg : null); if (!e) throw new BrokerError(`StoxKart does not trade ${seg} through its API`, 'VALIDATION'); return e; };
  // Split a quantity into legs of at most the freeze quantity.
  const pieces = (qty, max) => { const out = []; for (let left = qty; left > 0; left -= Math.min(left, max)) out.push(Math.min(left, max)); return out; };
  /** The broker order type and prices for TradeLock's order: MARKET becomes a protected LIMIT (see the header). */
  const priced = async o => {
    if (o.type === 'LIMIT') return { type: 'LIMIT', price: o.price, trigger: 0 };
    if (o.type === 'STOP_LOSS') return { type: 'STOPLOSS_LIMIT', price: o.price, trigger: o.triggerPrice };
    if (o.type === 'STOP_LOSS_MARKET') return { type: 'STOPLOSS_LIMIT', price: protectedPrice(o.side, Number(o.triggerPrice)), trigger: o.triggerPrice };
    // refPrice: the caller's own fresh price (the Gap entry's first tick), so no extra price request; marketBand: its band.
    const last = Number(o.refPrice) > 0 ? Number(o.refPrice) : ltp ? await ltp(o.exchangeSegment, o.securityId).catch(() => null) : null;
    if (!(Number(last) > 0)) throw new BrokerError('StoxKart does not take market orders from the API and no live price was available to place a protected limit order. Try again, or use the StoxKart app.');
    return { type: 'LIMIT', price: protectedPrice(o.side, Number(last), Number(o.marketBand) > 0 ? Number(o.marketBand) : MARKET_BAND), trigger: 0 };
  };
  const place = async (o, qty, p) => {
    const type = p.type;
    const r = await call('POST', '/orders/normal', {
      action: o.side, exchange: exchangeFor(o.exchangeSegment), token: String(o.securityId), order_type: type,
      product_type: PRODUCT_OUT[o.productType || 'INTRADAY'] || 'INTRADAY', quantity: String(qty), disclose_quantity: '0',
      price: tickStr(Number(p.price)), trigger_price: type === 'STOPLOSS_LIMIT' ? tickStr(Number(p.trigger)) : '0',
      validity: 'DAY', tag: 'TradeLock',
    });
    const id = r.data?.order_id ?? r.data?.orderId ?? r.order_id ?? (typeof r.data === 'string' ? r.data : null);
    if (!id) throw new BrokerError('StoxKart accepted the order but returned no order id; check the StoxKart app');
    return String(id);
  };
  return {
    label: 'StoxKart',
    alwaysOn: false,
    capabilities: { positions: 'available', squareOff: 'available', accountLock: 'unverified' },
    async verify() { await call('GET', '/funds'); },
    async snapshot({ funds: withFunds = true, orders: withOrders = true, prevPosSig, prevOrderSig } = {}) {
      const [pos, firstBook, fund] = await Promise.all([
        call('GET', '/portfolio/positions').then(r => r.data || []), withOrders ? orderBook() : null, withFunds ? call('GET', '/funds').then(r => r.data || {}) : null,
      ]);
      const posSig = pos.map(p => `${p.token}:${p.net_quantity}:${p.buy_quantity}:${p.sell_quantity}`).join('|');
      const book = withOrders ? firstBook : prevPosSig === undefined || posSig !== prevPosSig ? await orderBook() : null;
      const orderSig = book ? book.map(o => `${o.order_id}:${o.status}:${o.traded_quantity}`).join('|') : prevOrderSig;
      const trades = book && (prevOrderSig === undefined || orderSig !== prevOrderSig) ? await call('GET', '/reports/trade-book').then(r => r.data || []) : null;
      // Positions carry no trading symbol: take it from today's orders and fills for the same token.
      const symbolOf = new Map();
      for (const x of [...(trades || []), ...(book || [])]) if (x.token && x.symbol) symbolOf.set(String(x.token), x.symbol);
      return {
        posSig, orderSig,
        funds: withFunds ? fund && { available: num(fund.available_limit), used: Math.abs(num(fund.utilized_limit)), withdrawable: num(fund.available_limit),
          opening: num(fund.net) + Math.abs(num(fund.utilized_limit)), collateral: num(fund.collateral) } : undefined,
        positions: pos.filter(p => num(p.net_quantity) !== 0 || num(p.buy_quantity) || num(p.sell_quantity)).map(p => {
          const net = num(p.net_quantity), buyQ = num(p.buy_quantity), sellQ = num(p.sell_quantity), buyAvg = num(p.buy_average_price), sellAvg = num(p.sell_average_price), ltp = num(p.last_trade_price);
          const matched = Math.min(buyQ, sellQ), realized = Math.round((sellAvg - buyAvg) * matched * 100) / 100;
          const unrealized = net > 0 && ltp ? Math.round((ltp - buyAvg) * net * 100) / 100 : net < 0 && ltp ? Math.round((sellAvg - ltp) * -net * 100) / 100 : 0;
          return { symbol: symbolOf.get(String(p.token)) || `${p.exchange}:${p.token}`, securityId: String(p.token), exchangeSegment: EXCH_IN[p.exchange] || p.exchange,
            // Carried from an earlier day (StoxKart gives carry values, not quantities): count it all as carried.
            productType: PRODUCT_IN[p.product_type] || p.product_type, qty: net, carryQty: num(p.cf_buy_value) || num(p.cf_sell_value) ? net : 0,
            avg: net >= 0 ? buyAvg : sellAvg, ltp: ltp || null, realized, unrealized };
        }),
        orders: book ? book.filter(o => statusOf(o).status === 'pending').map(o => ({
          id: String(o.order_id), symbol: o.symbol, side: o.action, qty: num(o.quantity), price: num(o.price), type: o.order_type, status: 'PENDING' })) : undefined,
        trades: trades === null ? null : trades.map(t => ({
          id: `stoxkart:${t.trade_id || t.order_id}`, orderId: t.order_id ? String(t.order_id) : null, ts: stoxkartTime(t.order_date_time) || Date.now(),
          symbol: t.symbol, side: t.action, qty: num(t.quantity), price: num(t.price), pnl: null })),
      };
    },
    /** Fills between two days (inclusive) for the P&L calendar. StoxKart reports today's trades only (no charges). */
    async tradeHistory(from, to) {
      const today = new Date(now() + 19800000).toISOString().slice(0, 10);
      if (today < from || today > to) return [];
      const rows = (await call('GET', '/reports/trade-book')).data || [];
      return rows.map(t => {
        const ts = stoxkartTime(t.order_date_time), qty = num(t.quantity), price = num(t.price), side = String(t.action || '').toUpperCase();
        if (!Number.isFinite(ts) || !(qty > 0) || !Number.isFinite(price) || !['BUY', 'SELL'].includes(side) || !t.token) return null;
        const m = /-(\d{2})([A-Za-z]{3})(\d{4})-[\d.]+-(CE|PE)$/.exec(String(t.symbol || ''));
        const expiry = m ? `${m[3]}-${String('JanFebMarAprMayJunJulAugSepOctNovDec'.indexOf(m[2]) / 3 + 1).padStart(2, '0')}-${m[1]}` : null;
        return { id: `stoxkart:${t.trade_id || [t.order_id, ts, side, qty, price].join(':')}`, ts, side, qty, price, charges: 0, orderId: String(t.order_id || ''),
          inst: `${EXCH_IN[t.exchange] || 'NSE_FNO'}:${t.token}`, symbol: String(t.symbol || t.token), option: !!m, expiry };
      }).filter(Boolean);
    },
    async placeOrder(o) {
      if (!o.securityId || !o.exchangeSegment) throw new BrokerError('StoxKart orders need a security id and exchange segment', 'VALIDATION');
      exchangeFor(o.exchangeSegment);   // an unsupported segment fails before any price lookup
      const qty = Number(o.qty), parts = qty > freezeQty ? pieces(qty, freezeQty) : [qty], ids = [], p = await priced(o);
      for (const q of parts) ids.push(await place(o, q, p));
      bookPromise = null;   // the next status read sees the new order
      return { id: ids.join(','), status: 'pending' };
    },
    async orderStatus(orderId) {
      const book = await orderBook(), ids = legs(orderId), parts = ids.map(id => book.find(o => String(o.order_id) === id)).map(o => (o ? statusOf(o) : { status: 'pending', filledQty: 0, qty: 0 }));
      if (parts.length === 1) return parts[0];
      const filledQty = parts.reduce((a, p) => a + p.filledQty, 0), qty = parts.reduce((a, p) => a + p.qty, 0);
      const price = filledQty ? Math.round(parts.reduce((a, p) => a + (Number(p.price) || 0) * p.filledQty, 0) / filledQty * 100) / 100 : parts[0]?.price;
      if (parts.every(p => p.status === 'filled')) return { status: 'filled', price, filledQty, qty };
      if (parts.some(p => p.status === 'pending')) return { status: 'pending', price, filledQty, qty };
      return { status: 'failed', reason: parts.find(p => p.status === 'failed')?.reason, price, filledQty, qty };
    },
    async cancelOrder(orderId) {
      const out = await Promise.allSettled(legs(orderId).map(id => call('DELETE', `/orders/normal/${encodeURIComponent(id)}`)));
      bookPromise = null;
      if (!out.some(x => x.status === 'fulfilled')) throw out[0].reason;
      return { status: 'cancelled' };
    },
    async modifyStopLoss(orderId, { triggerPrice, price }) {
      const book = await orderBook();
      for (const id of legs(orderId)) {
        const o = book.find(x => String(x.order_id) === id);
        if (!o) throw new BrokerError(`StoxKart order ${id} not found`);
        await call('PUT', `/orders/normal/${encodeURIComponent(id)}`, { exchange: o.exchange, token: String(o.token), order_type: 'STOPLOSS_LIMIT', quantity: String(num(o.quantity)),
          disclose_quantity: '0', price: String(price), trigger_price: String(triggerPrice), stop_loss_price: '0', validity: 'DAY' });
      }
      bookPromise = null;
      return { id: orderId, status: 'pending' };
    },
    async exitPosition(p) {
      const qty = Math.abs(Number(p.qty));
      return this.placeOrder({ side: Number(p.qty) > 0 ? 'SELL' : 'BUY', qty, type: 'MARKET', securityId: p.securityId, exchangeSegment: p.exchangeSegment, productType: p.productType || 'INTRADAY' });
    },
  };
}
