// Live updates over Server-Sent Events. The browser reconnects automatically.
import { store } from './store.js';
import { toast } from '../ui/toast.js';

let source = null;
let retry = null;

/** Restart the live connection if it is gone (closed by the OS in the background, a deploy, no network). */
export function ensureStream() {
  if (store.get().user && (!source || source.readyState === EventSource.CLOSED)) startStream();
}
const later = () => { clearTimeout(retry); retry = setTimeout(ensureStream, 3000); };
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') ensureStream(); });
window.addEventListener('pageshow', ensureStream);
window.addEventListener('online', ensureStream);

export function startStream() {
  stopStream();
  source = new EventSource('/api/stream');
  const json = e => JSON.parse(e.data);
  source.addEventListener('open', () => store.set({ live: true }));
  source.addEventListener('error', () => {
    store.set({ live: false });
    if (source?.readyState === EventSource.CLOSED) later();   // the browser gave up: retry ourselves
  });
  source.addEventListener('snapshot', e => store.set({ dash: json(e), live: true }));
  // Nothing changed since the last snapshot: just move the "synced" time forward.
  source.addEventListener('synced', e => {
    const d = store.get().dash;
    if (!d) return;
    const { at } = json(e);
    store.set({ dash: { ...d, syncedAt: at, broker: d.broker && { ...d.broker, lastSyncAt: at } }, live: true });
  });
  // Live P&L from market ticks (server live-pnl.js, up to 4 a second): update the dashboard's figures in place and
  // signal 'pnl' (not 'dash'), so pages refresh just their numbers instead of repainting.
  source.addEventListener('pnl', e => {
    const v = json(e), d = store.get().dash;
    if (d) {
      Object.assign(d, { pnl: v.pnl, realized: v.realized, unrealized: v.unrealized, livePnlAt: v.at, charges: v.charges ?? d.charges, netPnl: v.net ?? d.netPnl });
      for (const p of d.positions || []) { const r = v.positions?.[String(p.securityId)]; if (r) { p.unrealized = r.unrealized; if (r.ltp != null) p.ltp = r.ltp; } }
    }
    store.set({ pnl: v });
  });
  // A price alert fired: ring on this screen (ui/price-alarm.js via the shell).
  source.addEventListener('alert', e => store.set({ priceAlert: json(e) }));
  source.addEventListener('unread', e => store.set({ unread: json(e).count }));
  source.addEventListener('emergency', e => store.set({ emergency: json(e) }));
  source.addEventListener('wallet', e => store.set({ wallet: json(e) }));
  source.addEventListener('notification', e => {
    const n = json(e);
    store.set({ unread: store.get().unread + 1, notification: n });
    if (store.get().user?.prefs?.push !== false) {
      toast(n.title, n.level === 'critical' ? 'error' : n.level === 'warn' ? 'warn' : 'ok');
    }
  });
}

// Leaving or reloading the page: close the live connection at once, so an old page never keeps a
// browser connection slot busy (browsers allow only 6 per site over HTTP/1.1).
window.addEventListener('pagehide', () => source?.close());

export function stopStream() {
  clearTimeout(retry);
  source?.close();
  source = null;
  store.set({ live: null });
}
