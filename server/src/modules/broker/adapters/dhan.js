// DhanHQ API v2 adapter. Endpoint paths and field names follow the public v2 docs
// (https://dhanhq.co/docs/v2/). Verify them against the current docs and a live
// account before relying on this in production.
import { config } from '../../../config.js';
import { request } from '../../../lib/httpclient.js';
import { workerRequest } from '../../../lib/httpworker.js';
import { serverIp, serverIpv6 } from '../../../lib/serverip.js';

class BrokerError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

const OPEN_ORDER = new Set(['PENDING', 'TRANSIT', 'PART_TRADED']);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const intradayQueues = new Map();
const lastIntradayAt = new Map();

function intradayRequest(clientId, fn) {
  const previous = intradayQueues.get(clientId) || Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    const elapsed = Date.now() - (lastIntradayAt.get(clientId) || 0);
    if (elapsed < 500) await sleep(500 - elapsed);
    for (let attempt = 0; ; attempt++) {
      lastIntradayAt.set(clientId, Date.now());
      try { return await fn(); }
      catch (error) {
        if (error?.code !== 'DH-904' || attempt >= 2) throw error;
        await sleep(1_000 * (attempt + 1));
      }
    }
  });
  intradayQueues.set(clientId, current);
  current.then(() => {
    if (intradayQueues.get(clientId) === current) intradayQueues.delete(clientId);
  }, () => {
    if (intradayQueues.get(clientId) === current) intradayQueues.delete(clientId);
  });
  return current;
}

// An order above the exchange freeze quantity goes through Dhan's slicing API, which places it as several orders.
// TradeLock keeps them as ONE order with the id "A,B,C": status, cancel and modify act on every leg.
const legs = id => String(id).split(',').filter(Boolean);
const slicedIds = r => (Array.isArray(r) ? r : Array.isArray(r?.data) ? r.data : [r]).map(x => x?.orderId).filter(Boolean).map(String);
const SLICE_ABOVE = 3510;  // exits above this (NIFTY's freeze) go straight to slicing; from 900 a refused plain order is retried sliced

/** `transport(method, url, { headers, body, timeoutMs })` → { status, text }; swappable in tests. */
export function createDhanAdapter({ clientId, accessToken, transport = config.httpWorker ? workerRequest : request, egress = () => null }) {
  const getHeaders = { 'access-token': accessToken, 'client-id': clientId, Accept: 'application/json' };
  const sendHeaders = { ...getHeaders, 'Content-Type': 'application/json' };
  // One static IP fits one Dhan account, so a second account registers the server's IPv6 instead of 34.93.19.54.
  // family: which of the two this account's calls leave from (null until its registered IPs are known).
  let family = null;
  const pickFamily = regs => {
    const v6 = serverIpv6(), r = regs.map(x => String(x).trim().toLowerCase());
    return v6 && r.includes(v6) && !r.includes(serverIp()) ? 6 : 4;
  };
  const registered = ip => (ip ? [ip.primaryIP, ip.secondaryIP].filter(Boolean) : []);
  const readIp = () => call('GET', '/ip/getIP').then(x => (Array.isArray(x) ? x[0] : x) || {});
  // Dhan splits a plain order above its own freeze quantity (NIFTY 1,755 on 4 Nov 2026) and then answers orderId "0":
  // the orders it made are read back from the order book (same contract and side, placed in the last minute, newest
  // first, adding up to the quantity). Not found: no ids (the caller treats the order as unknown).
  async function orderIds(ids, { securityId, side, qty }) {
    const real = ids.filter(id => id !== '0');
    if (real.length) return real;
    const book = await call('GET', '/orders').catch(() => null), since = Date.now() - 60_000, out = [];
    let sum = 0;
    for (const x of (Array.isArray(book) ? book : []).filter(x => String(x.securityId) === String(securityId) && x.transactionType === side && istTime(x.createTime) >= since)
      .sort((a, b) => istTime(b.createTime) - istTime(a.createTime))) {
      if (sum >= qty) break;
      out.push(String(x.orderId)); sum += Number(x.quantity) || 0;
    }
    return sum === qty ? out : [];
  }
  async function call(method, path, body, timeoutMs = 5000) {
    // Orders must leave from the registered IP: learn it before the first one.
    const own = egress();   // the user's own static IP: every call leaves from it
    if (!own && family === null && method !== 'GET' && serverIpv6()) { try { family = pickFamily(registered(await readIp())); } catch { family = 4; } }
    let res;
    try {
      res = await transport(method, config.dhanBaseUrl + path, { headers: method === 'GET' ? getHeaders : sendHeaders, body, timeoutMs, ...(own || { family: family ?? 4 }) });
    } catch (e) {
      throw new BrokerError(e.code === 'TIMEOUT' ? `Dhan did not respond within ${timeoutMs / 1000} seconds` : 'Could not reach Dhan', 'NETWORK');
    }
    let data = null;
    try { data = res.text ? JSON.parse(res.text) : null; } catch { /* non-JSON error page */ }
    // Dhan reports a dead token several ways (401, DH-901, or a 4xx "Invalid Token" message):
    // all of them mean "reconnect with a fresh token", not "data is delayed".
    const msg = String(data?.errorMessage || data?.message || '');
    if (res.status === 401 || data?.errorCode === 'DH-901' || /invalid[_ ]?token|token.*(expired|invalid)/i.test(msg)) {
      throw new BrokerError('Dhan access token is invalid or expired', 'TOKEN_EXPIRED');
    }
    if (res.status < 200 || res.status >= 300) throw new BrokerError(data?.errorMessage || `Dhan returned HTTP ${res.status}`, data?.errorCode || 'BROKER');
    return data;
  }

  return {
    label: 'Dhan',
    alwaysOn: false,
    // Square-off needs order placement enabled on the token. Account lock uses Dhan's kill switch.
    capabilities: { positions: 'available', squareOff: 'permission', accountLock: 'killswitch' },

    async verify() { await call('GET', '/fundlimit'); },

    // Dhan Option Chain API (documented limit: one request every 3 seconds).
    async optionExpiries({ underlyingScrip, underlyingSeg }) {
      const r = await call('POST', '/optionchain/expirylist', { UnderlyingScrip: underlyingScrip, UnderlyingSeg: underlyingSeg }, 10_000);
      return Array.isArray(r?.data) ? r.data : [];
    },
    async optionChain({ underlyingScrip, underlyingSeg, expiry }) {
      const r = await call('POST', '/optionchain', { UnderlyingScrip: underlyingScrip, UnderlyingSeg: underlyingSeg, Expiry: expiry }, 10_000);
      return r?.data || null;
    },
    // Dhan Market Quote API: last traded price of one instrument (documented limit: one request per second).
    async ltp(segment, securityId) {
      const r = await call('POST', '/marketfeed/ltp', { [segment]: [Number(securityId)] }, 4000);
      const v = Number(r?.data?.[segment]?.[String(securityId)]?.last_price);
      return Number.isFinite(v) && v > 0 ? v : null;
    },
    // Dhan Market Quote API (OHLC): last price with today's open / high / low (documented limit: one request per second).
    async quote(segment, securityId) {
      return (await this.quotes({ [segment]: [securityId] }))[segment]?.[String(securityId)] || null;
    },
    // The same for many instruments in ONE request: { segment: [ids] } -> { segment: { id: { ltp, open, ... } } }.
    async quotes(bySegment) {
      const body = Object.fromEntries(Object.entries(bySegment).map(([seg, ids]) => [seg, ids.map(Number)]));
      const r = await call('POST', '/marketfeed/ohlc', body, 4000), n = x => (Number.isFinite(Number(x)) && Number(x) > 0 ? Number(x) : null);
      return Object.fromEntries(Object.keys(body).map(seg => [seg, Object.fromEntries(Object.entries(r?.data?.[seg] || {})
        .map(([id, q]) => [id, { ltp: n(q.last_price), open: n(q.ohlc?.open), high: n(q.ohlc?.high), low: n(q.ohlc?.low), close: n(q.ohlc?.close) }]))]));
    },
    // Dhan Margin Calculator: funds an order would block (premium for a buy, SPAN + exposure for a sell).
    async marginRequired({ securityId, exchangeSegment, side, qty, price, productType = 'INTRADAY' }) {
      const r = await call('POST', '/margincalculator', { dhanClientId: clientId, exchangeSegment, transactionType: side,
        quantity: qty, productType, securityId: String(securityId), price: Number(price) || 0, triggerPrice: 0 }, 8_000);
      return { total: Number(r?.totalMargin), available: Number(r?.availableBalance), leverage: r?.leverage || null };
    },
    // Dhan expired-options data: 1m candles for NIFTY options by expiry slot and strike offset from ATM.
    // expiryCode 1 = nearest weekly expiry, 2 = the one after; strike 'ATM', 'ATM+1' (= ATM + 1 step) ... ±10.
    // Every row carries the actual strike, so callers can follow one fixed contract as the ATM rolls.
    // `full` also asks for volume, open interest and IV (the history backfill stores them).
    async rollingOption({ expiryFlag = 'WEEK', expiryCode, strike = 'ATM', option, fromDate, toDate, interval = '1', full = false, timeoutMs = 20_000, securityId = 13, exchangeSegment = 'NSE_FNO' }) {
      const r = await intradayRequest(clientId, () => call('POST', '/charts/rollingoption', { exchangeSegment, interval: String(interval),
        securityId: Number(securityId), instrument: 'OPTIDX', expiryFlag, expiryCode, strike, drvOptionType: option === 'CE' ? 'CALL' : 'PUT',
        requiredData: full ? ['open', 'high', 'low', 'close', 'strike', 'spot', 'volume', 'oi', 'iv'] : ['open', 'high', 'low', 'close', 'strike', 'spot'],
        fromDate, toDate }, timeoutMs));
      const d = r?.data?.[option === 'CE' ? 'ce' : 'pe'] || {};
      const num = (a, i) => (a == null || a[i] == null ? null : Number(a[i]));
      return (d.timestamp || []).map((time, i) => ({ time: Number(time), open: Number(d.open?.[i]), high: Number(d.high?.[i]),
        low: Number(d.low?.[i]), close: Number(d.close?.[i]), strike: Number(d.strike?.[i]), spot: Number(d.spot?.[i]),
        ...(full ? { volume: num(d.volume, i), oi: num(d.oi, i), iv: num(d.iv, i) } : {}) }))
        .filter(row => Number.isFinite(row.time) && [row.open, row.high, row.low, row.close, row.strike].every(Number.isFinite));
    },
    // Open interest only exists for derivatives; the index feed has none.
    async intradayCandles({ securityId, exchangeSegment, instrument, interval = '5', fromDate, toDate }) {
      return intradayRequest(clientId, () => call('POST', '/charts/intraday', { securityId: String(securityId), exchangeSegment, instrument, interval: String(interval), oi: exchangeSegment !== 'IDX_I', fromDate, toDate }, 10_000));
    },

    /**
     * Positions every time. Orders when `orders` is true, or when the positions show a fill since
     * `prevPosSig` (a fill changes a position's bought/sold quantity, even if it opened and closed
     * between two polls). Trades only when the order book changed since `prevOrderSig`.
     * Funds unless { funds: false }. Skipped parts come back as: orders/funds undefined, trades null.
     */
    async snapshot({ funds: withFunds = true, orders: withOrders = true, prevPosSig, prevOrderSig } = {}) {
      const [pos, firstOrd, fund] = await Promise.all([
        call('GET', '/positions'), withOrders ? call('GET', '/orders') : null, withFunds ? call('GET', '/fundlimit') : null,
      ]);
      const posSig = (pos || []).map(p => `${p.securityId}:${p.netQty}:${p.buyQty ?? ''}:${p.sellQty ?? ''}`).join('|');
      const ord = withOrders ? firstOrd : prevPosSig === undefined || posSig !== prevPosSig ? await call('GET', '/orders') : null;
      const orderSig = ord ? ord.map(o => `${o.orderId}:${o.orderStatus}:${o.filledQty ?? ''}`).join('|') : prevOrderSig;
      const trd = ord && (prevOrderSig === undefined || orderSig !== prevOrderSig) ? await call('GET', '/trades') : null;
      const num = (...vals) => { for (const v of vals) if (typeof v === 'number') return v; return null; };
      return {
        posSig,
        orderSig,
        // Dhan's API spells it "availabelBalance"; accept the corrected spelling too.
        funds: withFunds ? fund && {
          available: num(fund.availabelBalance, fund.availableBalance),
          used: num(fund.utilizedAmount),
          withdrawable: num(fund.withdrawableBalance),
          opening: num(fund.sodLimit),
          collateral: num(fund.collateralAmount),
        } : undefined,
        positions: (pos || [])
          .filter(p => p.netQty !== 0 || p.realizedProfit)
          .map(p => ({
            symbol: p.tradingSymbol,
            securityId: String(p.securityId),
            exchangeSegment: p.exchangeSegment,
            productType: p.productType,
            qty: p.netQty,
            carryQty: (Number(p.carryForwardBuyQty) || 0) - (Number(p.carryForwardSellQty) || 0),
            avg: p.netQty >= 0 ? p.buyAvg : p.sellAvg,
            ltp: null,
            realized: p.realizedProfit || 0,
            unrealized: p.unrealizedProfit || 0,
          })),
        orders: ord ? ord.filter(o => OPEN_ORDER.has(o.orderStatus)).map(o => ({
          id: o.orderId, symbol: o.tradingSymbol, side: o.transactionType, qty: o.quantity, price: o.price, type: o.orderType, status: 'PENDING',
        })) : undefined,
        trades: trd === null ? null : (trd || []).map(t => ({
          id: `dhan:${t.exchangeTradeId || t.orderId}`,
          orderId: t.orderId ? String(t.orderId) : null,
          // Dhan's times are IST without a zone ("2026-10-12 09:23:50"): read them as IST, not UTC.
          ts: [t.exchangeTime, t.updateTime, t.createTime].map(istTime).find(Number.isFinite) || Date.now(),
          symbol: t.tradingSymbol, side: t.transactionType, qty: t.tradedQuantity, price: t.tradedPrice, pnl: null,
        })),
      };
    },

    // o.slice: the quantity may be above the freeze limit; Dhan splits it (see legs above).
    async placeOrder(o) {
      if (!o.securityId || !o.exchangeSegment) throw new BrokerError('Dhan orders need a security ID and exchange segment', 'VALIDATION');
      const r = await call('POST', o.slice ? '/orders/slicing' : '/orders', {
        dhanClientId: clientId,
        transactionType: o.side,
        exchangeSegment: o.exchangeSegment,
        productType: o.productType || 'INTRADAY',
        orderType: o.type,
        validity: 'DAY',
        securityId: String(o.securityId),
        quantity: o.qty,
        price: o.type === 'LIMIT' || o.type === 'STOP_LOSS' ? o.price : 0,
        // STOP_LOSS = stop-loss limit: rests until LTP reaches the trigger, then works at `price`.
        // (Exchanges do not accept stop-loss market orders on index options.)
        ...(o.type === 'STOP_LOSS' ? { triggerPrice: o.triggerPrice } : {}),
      });
      const ids = await orderIds(o.slice ? slicedIds(r) : [r?.orderId].filter(Boolean).map(String), { securityId: o.securityId, side: o.side, qty: o.qty });
      if (!ids.length) throw new BrokerError('Dhan accepted the order but returned no order id; check the Dhan app', 'BROKER');
      return { id: ids.join(','), status: 'pending' };
    },

    // Move a resting stop-loss order (Dhan Modify Order): same order, new trigger / limit price.
    // A sliced stop (several legs): each leg keeps its own quantity.
    async modifyStopLoss(orderId, { triggerPrice, price, qty }) {
      const ids = legs(orderId);
      for (const id of ids) {
        const q = ids.length > 1 ? (await this.orderStatus(id)).qty : qty;
        await call('PUT', `/orders/${encodeURIComponent(id)}`, { dhanClientId: clientId, orderId: id, orderType: 'STOP_LOSS',
          legName: '', quantity: q, price, disclosedQuantity: 0, triggerPrice, validity: 'DAY' });
      }
      return { id: orderId, status: 'pending' };
    },

    // Every leg; fails only if no leg could be cancelled (a leg that already traded cannot be).
    async cancelOrder(orderId) {
      const out = await Promise.allSettled(legs(orderId).map(id => call('DELETE', `/orders/${encodeURIComponent(id)}`)));
      if (!out.some(x => x.status === 'fulfilled')) throw out[0].reason;
      return { status: 'cancelled' };
    },

    async exitPosition(p) {
      const send = async slice => {
        const r = await call('POST', slice ? '/orders/slicing' : '/orders', {
          dhanClientId: clientId,
          transactionType: p.qty > 0 ? 'SELL' : 'BUY',
          exchangeSegment: p.exchangeSegment,
          productType: p.productType,
          orderType: 'MARKET',
          validity: 'DAY',
          securityId: String(p.securityId),
          quantity: Math.abs(p.qty),
        });
        const ids = await orderIds(slice ? slicedIds(r) : [r?.orderId].filter(Boolean).map(String), { securityId: p.securityId, side: p.qty > 0 ? 'SELL' : 'BUY', qty: Math.abs(p.qty) });
        return { id: ids.join(','), status: 'pending' };
      };
      const qty = Math.abs(p.qty);
      if (qty > SLICE_ABOVE) return send(true);
      try { return await send(false); }
      // Only a clear refusal (e.g. above BANK NIFTY's freeze) is retried sliced: after a timeout the first order may
      // have gone through, and a second would sell twice.
      catch (e) { if (qty > 900 && !['TOKEN_EXPIRED', 'NETWORK'].includes(e?.code)) return send(true); throw e; }
    },

    // SEBI rule: Dhan accepts API orders only from the client's registered static IP (primary or secondary).
    // /ip/getIP reports the registered IPs, the IP Dhan sees for this server, and ordersAllowed.
    // /profile carries the real token expiry ("dd/mm/yyyy HH:mm", IST).
    async permissions() {
      const one = x => (Array.isArray(x) ? x[0] : x) || {};
      let [ip, prof] = await Promise.all([readIp().catch(() => null), call('GET', '/profile').then(one).catch(() => null)]);
      if (ip && !egress()) {
        const want = pickFamily(registered(ip));
        // Asked from the other IP: ask again from the one this account uses, so ordersAllowed is about that IP.
        if (want !== (family ?? 4)) { family = want; ip = await readIp().catch(() => ip); } else family = want;
      }
      const m = String(prof?.tokenValidity || '').match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})/);
      return {
        ordersAllowed: ip ? ip.ordersAllowed === true : null,
        serverIp: ip?.detectedIP || null,
        registeredIps: ip ? [ip.primaryIP, ip.secondaryIP].filter(Boolean) : [],
        ipChangedOn: ip ? [ip.modifyDatePrimary, ip.modifyDateSecondary].filter(Boolean) : [],
        tokenValidUntil: m ? Date.parse(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00+05:30`) : null,
        segments: prof?.activeSegment ? String(prof.activeSegment).split(',').map(x => x.trim()).filter(Boolean) : [],
        checkedAt: Date.now(),
      };
    },

    // Kill switch status. Docs show ACTIVATE / DEACTIVATE; the live API answers ACTIVE / INACTIVE.
    async getKillSwitch() {
      const raw = await call('GET', '/killswitch');
      const st = String((Array.isArray(raw) ? raw[0] : raw)?.killSwitchStatus || '').trim().toUpperCase();
      if (st.startsWith('INACTIVE') || st.startsWith('DEACTIVATE')) return false;
      if (st.startsWith('ACTIVE') || st.startsWith('ACTIVATE')) return true;
      return null;
    },

    // Hard lock. Dhan lets a kill switch be switched off the same day, unless it was activated TWICE that
    // day. So: ACTIVATE (unless already on), DEACTIVATE, ACTIVATE again, then read it back. A refused
    // DEACTIVATE while the switch reads ON means the account is already locked for the day.
    // Dhan only accepts the kill switch with no open positions and no pending orders.
    async activateKillSwitch() {
      const set = status => call('POST', `/killswitch?killSwitchStatus=${status}`);
      if ((await this.getKillSwitch()) !== true) { await set('ACTIVATE'); await sleep(300); }
      try {
        await set('DEACTIVATE');
      } catch (e) {
        if ((await this.getKillSwitch()) === true) return { message: 'Dhan kill switch is ON and locked for the rest of the day.' };
        throw e;
      }
      await sleep(300); // unlocked from here to the second ACTIVATE: keep it short
      let last = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await set('ACTIVATE'); last = null; break; } catch (e) { last = e; await sleep(500); }
      }
      if (last) throw new BrokerError(`Dhan kill switch is OFF: the second activation failed (${last.message})`, 'KILL_SWITCH');
      if ((await this.getKillSwitch()) !== true) throw new BrokerError('Dhan kill switch did not read back as ON after the second activation', 'KILL_SWITCH');
      return { message: 'Dhan kill switch activated twice: ON and locked until the next trading day.' };
    },

    /**
     * Executed trades between two days (YYYY-MM-DD, inclusive), all pages, from Dhan's statement API
     * (GET /trades/{from}/{to}/{page}, first page 0, an empty page ends the list).
     */
    async tradeHistory(from, to) {
      const out = [];
      const seen = new Set();
      for (let page = 0; page < 200; page++) {
        const rows = await call('GET', `/trades/${from}/${to}/${page}`, undefined, 20000);
        if (!Array.isArray(rows) || !rows.length) break;
        let fresh = 0;
        for (const t of rows) {
          const fill = historyFill(t);
          if (!fill || seen.has(fill.id)) continue;
          seen.add(fill.id); fresh++;
          out.push(fill);
        }
        if (!fresh) break;   // the same page again: stop rather than loop
      }
      return out;
    },

    // A sliced order ("A,B,C"): filled when every leg traded, pending while any works, else failed; filledQty and
    // the average price cover all legs.
    async orderStatus(orderId) {
      const ids = legs(orderId);
      const one = async id => {
        const raw = await call('GET', `/orders/${encodeURIComponent(id)}`);
        const o = Array.isArray(raw) ? raw[0] : raw;
        // filledQty: what traded so far (a PART_TRADED order, or one cancelled after part of it traded).
        const filledQty = Number(o?.filledQty) || (o?.orderStatus === 'TRADED' ? Number(o?.quantity) || 0 : 0), price = o?.averageTradedPrice || o?.price, qty = Number(o?.quantity) || 0;
        if (o?.orderStatus === 'TRADED') return { status: 'filled', price, filledQty, qty };
        if (['REJECTED', 'CANCELLED', 'EXPIRED'].includes(o?.orderStatus)) return { status: 'failed', reason: o.omsErrorDescription || `Order ${o.orderStatus.toLowerCase()}`, filledQty, price, qty };
        return { status: 'pending', filledQty, price, qty };
      };
      if (!ids.length) return { status: 'pending', filledQty: 0, qty: 0 };
      if (ids.length === 1) return one(ids[0]);
      const parts = await Promise.all(ids.map(one));
      const filledQty = parts.reduce((a, p) => a + p.filledQty, 0), qty = parts.reduce((a, p) => a + p.qty, 0);
      const price = filledQty ? Math.round(parts.reduce((a, p) => a + (Number(p.price) || 0) * p.filledQty, 0) / filledQty * 100) / 100 : parts[0].price;
      if (parts.every(p => p.status === 'filled')) return { status: 'filled', price, filledQty, qty };
      if (parts.some(p => p.status === 'pending')) return { status: 'pending', price, filledQty, qty };
      return { status: 'failed', reason: parts.find(p => p.status === 'failed')?.reason, price, filledQty, qty };
    },
  };
}

const money = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
/** Dhan times are IST without a zone, e.g. "2026-10-09 10:00:46". */
const istTime = s => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s) ? Date.parse(`${s.slice(0, 19).replace(' ', 'T')}+05:30`) : NaN);
/** Contract expiry as YYYY-MM-DD from whatever Dhan sends (date string, yyyymmdd, epoch), or null. */
function expiryDay(v) {
  if (v == null || v === 'NA' || v === '') return null;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  const n = Number(v);
  if (Number.isFinite(n) && n > 1e9) return new Date((n < 1e11 ? n * 1000 : n) + 330 * 60e3).toISOString().slice(0, 10);
  return null;
}

/** One trade-history row → a fill for the P&L calendar, or null when it can't be used. */
function historyFill(t) {
  const ts = [t.exchangeTime, t.updateTime, t.createTime].map(istTime).find(Number.isFinite);
  const qty = Number(t.tradedQuantity), price = Number(t.tradedPrice);
  const side = String(t.transactionType || '').toUpperCase();
  if (!Number.isFinite(ts) || !(qty > 0) || !Number.isFinite(price) || !['BUY', 'SELL'].includes(side) || !t.securityId) return null;
  const charges = money(t.sebiTax) + money(t.stt) + money(t.brokerageCharges) + money(t.serviceTax) + money(t.exchangeTransactionCharges) + money(t.stampDuty);
  return {
    id: [t.exchangeTradeId, t.orderId, ts, side, qty, price].join(':'),
    ts, side, qty, price, charges,
    orderId: String(t.orderId || ''),
    inst: `${t.exchangeSegment || ''}:${t.securityId}`,
    symbol: String(t.customSymbol || t.tradingSymbol || t.securityId),
    option: ['CALL', 'PUT'].includes(String(t.drvOptionType || '').toUpperCase()),
    expiry: expiryDay(t.drvExpiryDate),
  };
}

/** Expiry (ms) read from a Dhan access token (a JWT with an "exp" claim), or null. */
export function tokenExpiry(token) {
  try {
    const exp = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')).exp;
    return Number.isFinite(exp) ? exp * 1000 : null;
  } catch { return null; }
}

/**
 * Dhan RenewToken: swaps a still-active token for a new one valid 24 hours (the old one stops
 * working). Expired tokens cannot be renewed. Docs: https://dhanhq.co/docs/v2/authentication/
 */
export async function renewDhanToken({ clientId, accessToken, transport = request }) {
  let res;
  try {
    res = await transport('GET', `${config.dhanBaseUrl}/RenewToken`, {
      headers: { 'access-token': accessToken, dhanClientId: clientId, Accept: 'application/json' }, timeoutMs: 10000,
    });
  } catch (e) {
    throw new BrokerError(e.code === 'TIMEOUT' ? 'Dhan did not respond within 10 seconds' : 'Could not reach Dhan', 'NETWORK');
  }
  let data = null;
  try { data = res.text ? JSON.parse(res.text) : null; } catch { /* not JSON */ }
  const msg = String(data?.errorMessage || data?.message || '');
  if (res.status === 401 || data?.errorCode === 'DH-901' || /invalid[_ ]?token|token.*(expired|invalid)/i.test(msg)) {
    throw new BrokerError('Dhan access token is invalid or expired', 'TOKEN_EXPIRED');
  }
  if (res.status < 200 || res.status >= 300) throw new BrokerError(msg || `Dhan returned HTTP ${res.status}`, data?.errorCode || 'BROKER');
  const body = data?.data && typeof data.data === 'object' ? data.data : data || {};
  const token = body.accessToken || body.token || body.access_token || body.jwtToken;
  if (!token || String(token).length < 20) throw new BrokerError('Dhan did not return a new token', 'BROKER');
  // Dhan sends e.g. "2026-10-12T11:30:45.444" in IST without a zone marker.
  const raw = String(body.expiryTime || body.tokenExpiry || '');
  const parsed = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : raw ? `${raw}+05:30` : '');
  return { accessToken: String(token), expiresAt: tokenExpiry(token) ?? (Number.isFinite(parsed) ? parsed : Date.now() + 24 * 3600e3) };
}

