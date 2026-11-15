/**
 * Hash router with lazily loaded page modules. A page module default-exports:
 *   title, sub (string | state => string), layout: 'app' | 'bare', auth?, guest?
 *   load(ctx)    → data (awaited before first paint)
 *   view(ctx)    → html
 *   draw(ctx)    → optional, after every paint and on resize (charts)
 *   mount(ctx)   → optional, once; bind delegated listeners with ctx.signal
 *   onStore(ctx, patch) → optional, react to live store changes
 *   live: [keys] → repaint when these store keys change
 */
import { store } from './store.js';
import { debounce } from './dom.js';
import { mountShell, unmountShell } from '../ui/shell.js';
import { errorView } from '../ui/parts.js';

const PAGES = {
  landing: () => import('../pages/landing.js'),
  login: () => import('../pages/login.js'),
  signup: () => import('../pages/login.js'),
  mfa: () => import('../pages/login.js'),
  forgot: () => import('../pages/login.js'),
  reset: () => import('../pages/login.js'),
  overview: () => import('../pages/overview.js'),
  rules: () => import('../pages/rules.js'),
  strategy: () => import('../pages/strategy.js'),
  backtest: () => import('../pages/backtest.js'),
  scalper: () => import('../pages/scalper.js?v=20261115-plus-hover1'),
  algo: () => import('../pages/algo.js'),
  positions: () => import('../pages/trades.js'),
  analytics: () => import('../pages/analytics.js'),
  calendar: () => import('../pages/calendar.js'),
  journal: () => import('../pages/journal.js'),
  brokers: () => import('../pages/brokers.js'),
  wallet: () => import('../pages/wallet.js'),
  affiliate: () => import('../pages/affiliate.js'),
  alerts: () => import('../pages/alerts.js'),
  settings: () => import('../pages/settings.js'),
  profile: () => import('../pages/profile.js'),
  billing: () => import('../pages/billing.js'),
  states: () => import('../pages/states.js'),
};

const root = document.getElementById('root');
let active = null;
let seq = 0;

// Clean URLs: tradelock.in/rules. The server answers every app path with index.html.
// Old page names that moved: their addresses keep working.
const ALIASES = { trades: 'positions', stop: 'overview', connect: 'brokers' };   // the kill switch now lives on Overview
const pathOf = name => (name === 'landing' ? '/' : `/${name}`);
export const currentRoute = () => location.pathname.replace(/^\/+|\/+$/g, '').split('/')[0] || 'landing';

export function navigate(name, { replace = false } = {}) {
  if (location.pathname !== pathOf(name)) history[replace ? 'replaceState' : 'pushState'](null, '', pathOf(name));
  return show(name);
}

let shown = null;
// Back/forward between pages. A history step that stays on the same page (e.g. closing the profile
// panel) does not re-render it.
window.addEventListener('popstate', () => { const r = ALIASES[currentRoute()] || currentRoute(); if (r !== shown) show(r); });
// An old /#page link opened while the app is already on screen (no reload): move to the clean address.
window.addEventListener('hashchange', () => {
  const name = location.hash.slice(1);
  if (name === 'admin' || ((PAGES[name] || ALIASES[name]) && location.pathname === '/')) { migrateHashUrl(); show(currentRoute()); }
});

// Old links (/#rules, bookmarks, the installed app, past emails) move to the clean address.
export function migrateHashUrl() {
  const name = location.hash.slice(1);
  if (name === 'admin') return location.replace('/admin');
  if (location.pathname === '/' && (PAGES[name] || ALIASES[name])) history.replaceState(null, '', `${pathOf(name)}${location.search}`);
}

// In-app links are plain <a href="/rules">: open them without a full page load.
document.addEventListener('click', e => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest('a[href]');
  if (!a || a.target || a.hasAttribute('download')) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || url.hash) return;
  const name = url.pathname.replace(/^\/+|\/+$/g, '') || 'landing';
  if (!PAGES[name] && !ALIASES[name]) return;   // /admin, /privacy... are separate pages
  e.preventDefault();
  navigate(name);
});

export async function show(requested) {
  const token = ++seq;
  active?.dispose();
  active = null;
  const user = store.get().user;
  requested = ALIASES[requested] || requested;
  // The page shown before this one in this visit (pages read it, e.g. Power Scalper's ✕ goes back to it).
  if (shown && shown !== requested) document.body.dataset.prevPage = shown;
  shown = requested;
  if (requested === 'landing' && window.TradeLockApp) requested = 'login';   // Android app: no marketing page
  let name = PAGES[requested] ? requested : user ? 'overview' : 'landing';
  shown = name;
  document.body.dataset.page = name;
  const mod = (await PAGES[name]()).default;
  if (token !== seq) return;
  // Automatic redirects replace the address, so Back never bounces between pages.
  if (mod.auth && !user) return navigate('login', { replace: true });
  if (mod.guest && user) return navigate(user.broker ? 'overview' : 'brokers', { replace: true });
  if (location.pathname !== pathOf(name) && location.pathname !== `${pathOf(name)}/`) history.replaceState(null, '', pathOf(name));   // alias or unknown address

  active?.dispose();
  active = null;
  const ac = new AbortController();
  let el;
  if (mod.layout === 'app') {
    const shell = mountShell(root);
    shell.activate(name, mod);
    el = shell.page;
    el.innerHTML = '<div class="loading">Loading…</div>';
  } else {
    unmountShell();
    el = root;
  }

  let painted = false;
  const ctx = {
    name, el, signal: ac.signal, data: null, ui: {},
    get state() { return store.get(); },
    paint() {
      if (ac.signal.aborted || token !== seq) return;
      el.innerHTML = `<div class="${painted ? '' : 'page'}">${mod.view(ctx)}</div>`;
      painted = true;
      mod.draw?.(ctx);
    },
    async reload() {
      if (ac.signal.aborted || token !== seq) return;
      ctx.data = mod.load ? await mod.load(ctx) : null;
      if (!ac.signal.aborted) ctx.paint();
    },
  };

  // Own pending loads as well as mounted pages so navigation cancels both.
  let off = () => {};
  active = { dispose() { ac.abort(); off(); } };

  try {
    await ctx.reload();
  } catch (e) {
    if (token === seq) el.innerHTML = String(errorView(e));
    return;
  }
  if (token !== seq) return ac.abort();

  mod.mount?.(ctx);
  off = store.on(patch => {
    if (ac.signal.aborted || token !== seq) return;
    mod.onStore?.(ctx, patch);
    if (mod.live?.some(k => k in patch)) ctx.paint();
  });
  window.addEventListener('resize', debounce(() => {
    if (!ac.signal.aborted && token === seq) mod.draw?.(ctx);
  }, 150), { signal: ac.signal });
  document.title = mod.title ? `${mod.title} · TradeLock` : 'TradeLock';
  window.scrollTo(0, 0);
}
