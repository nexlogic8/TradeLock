import { WebSocket, WebSocketServer } from 'ws';
import { config } from '../../config.js';
import { parseCookies } from '../../lib/http.js';
import { userFromSession } from '../auth/session.js';
import { marketFeedCredentials } from '../broker/registry.js';
import { createTickBook } from './tick-book.js';

// Each user has a feed (their Power Scalper screens and Algo Trading's internal watcher: algoWatch). Feeds on the same
// Dhan login share one upstream socket, a hub: with a shared market-data account (MARKET_DATA_USER_ID) that is one
// socket for everyone, subscribed to the union of what they watch. Every tick goes into the hub's tick book: latest
// price and 1-minute candles that Algo Trading reads for entries and exits (REST stays the fallback when it is down).
const allowedByUser = new Map();
const feeds = new Map();   // userId -> feed
const hubs = new Map();    // credentials key -> hub
const minuteListeners = new Set();
const newFeed = userId => ({ userId, clients: new Set(), algo: null, hub: null });
const newHub = key => ({ key, feeds: new Set(), upstream: null, subscribed: new Set(), retryCount: 0, retry: null, book: createTickBook() });
const hubClients = function* (hub) { for (const f of hub.feeds) yield* f.clients; };
const hubBusy = hub => [...hub.feeds].some(f => f.clients.size);
const MAX_WATCH = 99; // one slot is reserved for NIFTY 50
const send = (socket, data) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data)); };

export function allowScalperContracts(userId, expiry, strikes, underlying = { securityId:'13', optionSegment:'NSE_FNO' }) {
  const ids = new Set(strikes.flatMap(row => [row.ce?.securityId, row.pe?.securityId]).filter(Boolean).map(String));
  // One entry per index, so loading (or preloading) another index keeps this one's contracts valid.
  const byIndex = allowedByUser.get(userId) || new Map();
  byIndex.set(String(underlying.securityId), { expiry, ids, indexId:underlying.securityId, segment:underlying.optionSegment, at: Date.now() });
  allowedByUser.set(userId, byIndex);
}

/** Dhan quote packet decoder (little-endian; layout per DhanHQ v2 Live Market Feed docs). */
export function decodeDhanQuotePacket(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 1) return null;
  if (buffer.readUInt8(0) === 50) return { type: 'feed-status', code: 50, message: 'Dhan market feed disconnected.' };
  if (buffer.length < 12) return null;
  const code = buffer.readUInt8(0), size = buffer.readUInt16LE(1), segmentCode = buffer.readUInt8(3);
  const securityId = String(buffer.readUInt32LE(4));
  if (![1, 2, 4, 5, 6, 7, 8].includes(code) || (size && size > buffer.length)) return null;
  const segment = ({ 0: 'IDX_I', 1: 'NSE_EQ', 2: 'NSE_FNO', 3: 'NSE_CURRENCY', 4: 'BSE_EQ', 5: 'MCX_COMM', 7: 'BSE_CURRENCY', 8: 'BSE_FNO' })[segmentCode];
  if (!segment || code === 5 || code === 6 || code === 7) return null;
  const out = { type: 'tick', securityId, exchangeSegment: segment, at: Date.now() };
  if (code === 1 || code === 2) {
    if (buffer.length < 16) return null;
    out.ltp = buffer.readFloatLE(8);
    out.timestamp = buffer.readUInt32LE(12) * 1000;
  } else if (code === 4 || code === 8) {
    const minLength = code === 8 ? 162 : 50;
    if (buffer.length < minLength) return null;
    out.ltp = buffer.readFloatLE(8);
    out.lastQty = buffer.readInt16LE(12);
    out.timestamp = buffer.readUInt32LE(14) * 1000;
    out.averagePrice = buffer.readFloatLE(18);
    out.volume = buffer.readUInt32LE(22);
    out.sellQuantity = buffer.readUInt32LE(26);
    out.buyQuantity = buffer.readUInt32LE(30);
    if (code === 4) {
      out.dayOpen = buffer.readFloatLE(34);
      out.dayClose = buffer.readFloatLE(38);
      out.dayHigh = buffer.readFloatLE(42);
      out.dayLow = buffer.readFloatLE(46);
    }
    if (code === 8) {
      out.oi = buffer.readUInt32LE(34);
      out.dayOpen = buffer.readFloatLE(46);
      out.dayClose = buffer.readFloatLE(50);
      out.dayHigh = buffer.readFloatLE(54);
      out.dayLow = buffer.readFloatLE(58);
      out.depth = Array.from({ length: 5 }, (_, i) => {
        const p = 62 + i * 20;
        return { bidQty: buffer.readUInt32LE(p), askQty: buffer.readUInt32LE(p + 4), bidOrders: buffer.readUInt16LE(p + 8), askOrders: buffer.readUInt16LE(p + 10), bid: buffer.readFloatLE(p + 12), ask: buffer.readFloatLE(p + 16) };
      });
    }
  } else return null;
  return Number.isFinite(out.ltp) && out.ltp > 0 ? out : null;
}

function watchUnion(hub) {
  const union = new Set(['IDX_I:13']);
  for (const client of hubClients(hub)) for (const key of client.watch || []) union.add(key);
  return union;
}

function sendSubscriptions(hub) {
  if (!hub || hub.upstream?.readyState !== WebSocket.OPEN) return;
  const next = watchUnion(hub);
  const sendBatches = (requestCode, keys) => {
    const items = [...keys].map(key => { const [ExchangeSegment, SecurityId] = key.split(':'); return { ExchangeSegment, SecurityId }; });
    for (let i=0; i<items.length; i+=100) {
      const batch = items.slice(i,i+100);
      if (batch.length) hub.upstream.send(JSON.stringify({ RequestCode:requestCode, InstrumentCount:batch.length, InstrumentList:batch }));
    }
  };
  sendBatches(18, [...hub.subscribed].filter(key => !next.has(key)));
  sendBatches(17, [...next].filter(key => !hub.subscribed.has(key)));
  hub.subscribed = next;
}

/** Put the user's feed on the hub of its Dhan login (moving it if the login changed) and make sure that hub streams. */
function join(feed) {
  const credentials = marketFeedCredentials(feed.userId);
  if (!credentials) { for (const c of feed.clients) send(c, { type: 'error', message: 'Reconnect Dhan to receive live quotes.' }); return null; }
  if (feed.hub && feed.hub.key !== credentials.key) leave(feed);
  let hub = hubs.get(credentials.key);
  if (!hub) { hub = newHub(credentials.key); hubs.set(hub.key, hub); }
  hub.feeds.add(feed); feed.hub = hub;
  connectUpstream(hub, credentials);
  return hub;
}

function leave(feed) {
  const hub = feed.hub;
  if (!hub) return;
  hub.feeds.delete(feed); feed.hub = null;
  if (hubBusy(hub)) return sendSubscriptions(hub);
  clearTimeout(hub.retry);
  hub.upstream?.close(1000, 'No one is watching');
  hub.upstream = null; hub.subscribed.clear();
  hubs.delete(hub.key);
}

function connectUpstream(hub, credentials) {
  if (hub.upstream || !hubBusy(hub)) return;
  const query = new URLSearchParams({ version: '2', token: credentials.accessToken, clientId: credentials.clientId, authType: '2' });
  const upstream = new WebSocket(`wss://api-feed.dhan.co?${query}`, { handshakeTimeout: 12_000, maxPayload: 64 * 1024 });
  hub.upstream = upstream;
  upstream.on('open', () => {
    hub.retryCount = 0;
    hub.book.connected(Date.now());
    for (const c of hubClients(hub)) send(c, { type: 'status', status: 'live', source: 'Dhan Data APIs' });
    sendSubscriptions(hub);
  });
  upstream.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const tick = decodeDhanQuotePacket(Buffer.from(data));
    if (!tick) return;
    if (tick.type === 'feed-status') {
      for (const c of hubClients(hub)) send(c, { type: 'status', status: 'reconnecting', message: tick.message });
      return;
    }
    const key = `${tick.exchangeSegment}:${tick.securityId}`;
    const closed = hub.book.add(key, tick);
    for (const f of hub.feeds) {
      let watching = false;
      for (const c of f.clients) if (c.watch?.has(key)) { watching = true; if (!c.internal) send(c, tick); }
      // A closed minute matters to the users watching this key (their Algo Trading), not to everyone on the socket.
      if (closed != null && watching) for (const fn of minuteListeners) { try { fn(f.userId, key, closed); } catch { /* a listener's problem stays its own */ } }
    }
  });
  upstream.on('error', () => {
    for (const c of hubClients(hub)) send(c, { type: 'status', status: 'unavailable', message: 'Dhan live feed could not be reached. Check Data APIs and the Dhan token.' });
  });
  upstream.on('close', () => {
    if (hub.upstream === upstream) hub.upstream = null;
    hub.subscribed.clear();
    hub.book.connected(null);   // candles from before a drop are no longer known complete
    if (hubBusy(hub)) {
      for (const c of hubClients(hub)) send(c, { type: 'status', status: 'reconnecting', message: 'Reconnecting to Dhan market feed…' });
      clearTimeout(hub.retry);
      hub.retry = setTimeout(() => {
        const first = [...hub.feeds][0], credentials = first && marketFeedCredentials(first.userId);
        if (credentials?.key === hub.key) connectUpstream(hub, credentials);
        else for (const f of [...hub.feeds]) { leave(f); if (f.clients.size) join(f); }   // the shared login changed
      }, Math.min(30_000, 1000 * 2 ** Math.min(hub.retryCount++, 5)));
      hub.retry.unref?.();
    }
  });
}

function acceptMessage(userId, feed, client, text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return send(client, { type: 'error', message: 'Invalid live-feed request.' }); }
  if (msg.type !== 'watch' || !Array.isArray(msg.instruments)) return;
  // The chain's contract ids stay valid for the session; a short window broke reconnects mid-day.
  const allowed = [...(allowedByUser.get(userId)?.values() || [])].filter(a => Date.now() - a.at <= 8 * 60 * 60_000);
  if (!allowed.length) return send(client, { type: 'error', message: 'Reload Power Scalper to refresh the allowed instruments.' });
  const watch = new Set(['IDX_I:13']);
  for (const item of msg.instruments.slice(0, MAX_WATCH)) {
    const segment = item?.exchangeSegment, id = String(item?.securityId || '');
    // Options of the loaded chain (NSE_FNO, or BSE_FNO for SENSEX) and that chain's index.
    if (allowed.some(a => segment === (a.segment || 'NSE_FNO') && a.ids.has(id))) watch.add(`${segment}:${id}`);
    else if (segment === 'IDX_I' && allowed.some(a => id === a.indexId)) watch.add(`${segment}:${id}`);
  }
  client.watch = watch;
  const hub = join(feed);
  sendSubscriptions(hub);
  // A tab joining a feed that is already streaming must hear it is live; 'open' fired before it joined.
  if (hub?.upstream?.readyState === WebSocket.OPEN) send(client, { type: 'status', status: 'live', source: 'Dhan Data APIs', instruments: watch.size });
  else send(client, { type: 'status', status: 'connecting', instruments: watch.size });
}

function closeFeed(userId, feed) {
  leave(feed);
  feeds.delete(userId);
}

// ---- Algo Trading on the server ----
/** Keep the user's feed subscribed to these keys ("IDX_I:13", "NSE_FNO:51334", …) for Algo Trading. */
export function algoWatch(userId, keys) {
  let feed = feeds.get(userId);
  if (!feed) { feed = newFeed(userId); feeds.set(userId, feed); }
  if (!feed.algo) { feed.algo = { internal: true, watch: new Set() }; feed.clients.add(feed.algo); }
  const next = new Set(keys), same = next.size === feed.algo.watch.size && [...next].every(k => feed.algo.watch.has(k));
  feed.algo.watch = next;
  const hub = join(feed);
  if (!same) sendSubscriptions(hub);
}
/** Algo Trading no longer needs the feed (market closed): it closes unless a Power Scalper screen still uses it. */
export function algoUnwatch(userId) {
  const feed = feeds.get(userId);
  if (!feed?.algo) return;
  feed.clients.delete(feed.algo); feed.algo = null;
  if (!feed.clients.size) closeFeed(userId, feed);
  else sendSubscriptions(feed.hub);
}
/** Latest tick for key received at or after `since` (ms), or null (no feed, not subscribed, or stale). */
export const liveTick = (userId, key, opts) => feeds.get(userId)?.hub?.book.tick(key, opts) || null;
/** The completed tick-built 1-minute candle starting at `minute` (ms), or null when the feed cannot vouch for it. */
export const liveMinute = (userId, key, minute, now) => feeds.get(userId)?.hub?.book.minute(key, minute, now) || null;
/** The 1-minute candle starting at `minute` (ms) as built so far from ticks (for the minute in progress), or null. */
export const liveBar = (userId, key, minute) => feeds.get(userId)?.hub?.book.partial?.(key, minute) || null;
/** fn(userId, key, minuteStart) when a key's 1-minute candle closes (its first tick of the next minute arrived). */
export function onMinuteClose(fn) { minuteListeners.add(fn); return () => minuteListeners.delete(fn); }
/** Feed status for a user: connected, since when, and how many keys Algo Trading watches. */
export function feedState(userId) {
  const feed = feeds.get(userId);
  return { connected: feed?.hub?.upstream?.readyState === WebSocket.OPEN, upSince: feed?.hub?.book.upSince ?? null, algoKeys: feed?.algo?.watch.size || 0, screens: feed ? [...feed.clients].filter(c => !c.internal).length : 0 };
}

export function attachScalperWebSocket(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });
  const originHost = (() => { try { return new URL(config.publicUrl).host; } catch { return null; } })();
  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, config.publicUrl); } catch { return socket.destroy(); }
    if (url.pathname !== '/api/scalper/live') return;
    if (req.headers.origin && originHost) {
      try { if (new URL(req.headers.origin).host !== originHost) return socket.destroy(); }
      catch { return socket.destroy(); }
    }
    const cookies = parseCookies(req.headers.cookie || '');
    const user = userFromSession(cookies);
    if (!user) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return socket.destroy(); }
    wss.handleUpgrade(req, socket, head, client => wss.emit('connection', client, req, user, cookies));
  });
  wss.on('connection', (client, _req, user, cookies) => {
    let feed = feeds.get(user.id);
    if (!feed) { feed = newFeed(user.id); feeds.set(user.id, feed); }
    feed.clients.add(client);
    send(client, { type: 'status', status: 'idle', message: 'Waiting for the option chain.' });
    client.on('message', data => acceptMessage(user.id, feed, client, data.toString()));
    client.on('close', () => {
      feed.clients.delete(client);
      if (!feed.clients.size) closeFeed(user.id, feed);
      else sendSubscriptions(feed.hub);
    });
    client.on('error', () => client.close());
    const authCheck = setInterval(() => {
      if (!userFromSession(cookies)) client.close(4001, 'Session expired');
    }, 60_000);
    authCheck.unref?.();
    client.once('close', () => clearInterval(authCheck));
  });
  return () => {
    for (const hub of hubs.values()) { clearTimeout(hub.retry); hub.upstream?.close(); }
    for (const feed of feeds.values()) for (const client of feed.clients) client.close?.();
    feeds.clear(); hubs.clear(); wss.close();
  };
}
