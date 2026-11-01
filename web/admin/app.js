// TradeLock admin console (/admin): its own sign-in, sidebar menus and pages. Admin accounts only.
import { html, $, on } from '/js/core/dom.js';
import { get, post } from '/js/core/api.js';
import { resolvedTheme, setThemePref } from '/js/core/theme.js';
import { icon, logoMark } from '/js/ui/icons.js';
import { formError } from '/js/ui/parts.js';
import { toastError } from '/js/ui/toast.js';

// [path, label, icon, module]
const MENU = [
  ['Overview', [['', 'Dashboard', 'grid', 'dashboard'], ['alerts', 'Alerts', 'bell', 'alerts']]],
  ['Business', [['users', 'Users', 'users', 'users'], ['payments', 'Payments & plans', 'card', 'payments'],
    ['withdrawals', 'Withdrawals', 'bank', 'withdrawals'], ['coupons', 'Coupons', 'tag', 'coupons'], ['affiliates', 'Affiliates', 'share', 'affiliates']]],
  ['Platform', [['brokers', 'Brokers & agents', 'link', 'brokers'], ['services', 'Microservices', 'radar', 'services'], ['server', 'Server & AWS', 'server', 'server'], ['audit', 'Audit log', 'list', 'audit']]],
];
const ROUTES = Object.fromEntries(MENU.flatMap(([, items]) => items.map(i => [i[0], i])));
const AUTH_ERRORS = {
  not_admin: 'That Google account is not an administrator.',
  google_cancelled: 'Google sign-in was cancelled.',
  google_state: 'Sign-in expired. Try again.',
  google_failed: 'Google sign-in failed. Try again.',
  google_unverified: 'That Google account has no verified email.',
  google_disabled: 'Google sign-in is not configured on this server.',
};

const root = document.getElementById('root');
const page = () => location.pathname.replace(/^\/admin\/?/, '').split('/')[0];
let me = null;
let active = null;

// ---------------- sign-in screens ----------------

function signInScreen({ error, mfa, dev }) {
  root.innerHTML = String(html`
    <div class="adm-auth"><div class="panel adm-auth-card">
      <span class="logo">${logoMark()}<span>TRADE<b>LOCK</b></span></span>
      <div class="ico-tile mt">${icon('shield')}</div>
      <h1>Admin console</h1>
      <p class="muted">Restricted area. Sign in with the authorised administrator account.</p>
      ${formError(error)}
      ${mfa ? html`
        <form id="mfa-form" class="auth-form">
          <div class="field"><label for="mfa-code">Authenticator code</label><input class="input num" id="mfa-code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" autofocus></div>
          <button class="btn btn-primary btn-block">Verify</button>
        </form>`
      : html`
        <a class="btn btn-block adm-google" href="/api/auth/google?next=admin">${googleGlyph()}Continue with Google</a>
        ${dev ? html`<form id="pw-form" class="auth-form">
          <p class="tiny dim" style="margin:0">Development only: email sign-in</p>
          <input class="input" id="pw-email" type="email" placeholder="Email" autocomplete="username">
          <input class="input" id="pw-pass" type="password" placeholder="Password" autocomplete="current-password">
          <button class="btn btn-block">Sign in</button></form>` : ''}`}
      <a class="tiny dim adm-back" href="/">← Back to tradelock.in</a>
    </div></div>`);
  $('#mfa-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    try { await post('/auth/mfa/complete', { code: $('#mfa-code').value.trim() }); location.replace('/admin'); }
    catch (err) { signInScreen({ error: err.message, mfa: true }); }
  });
  $('#pw-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    try { await post('/auth/login', { email: $('#pw-email').value, password: $('#pw-pass').value }); boot(); }
    catch (err) { signInScreen({ error: err.message, dev }); }
  });
}

function deniedScreen(email) {
  root.innerHTML = String(html`
    <div class="adm-auth"><div class="panel adm-auth-card">
      <span class="logo">${logoMark()}<span>TRADE<b>LOCK</b></span></span>
      <div class="ico-tile mt adm-denied">${icon('lock')}</div>
      <h1>No access</h1>
      <p class="muted">You are signed in as <b>${email}</b>, which is not an administrator account.</p>
      <button class="btn btn-block mt" id="switch">Sign out and use another account</button>
      <a class="tiny dim adm-back" href="/">← Back to tradelock.in</a>
    </div></div>`);
  $('#switch').addEventListener('click', async () => { await post('/auth/logout').catch(() => {}); boot(); });
}

const googleGlyph = () => html`<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
  <path fill="#4285F4" d="M23.5 12.27c0-.85-.07-1.48-.23-2.13H12v3.86h6.5c-.13 1.06-.84 2.66-2.42 3.73l3.54 2.85c2.24-2.05 3.88-5.07 3.88-8.31Z"/>
  <path fill="#34A853" d="M12 24c3.24 0 5.95-1.06 7.94-2.88l-3.78-2.9c-1.01.7-2.37 1.19-4.16 1.19-3.18 0-5.88-2.09-6.84-4.98L1.3 17.37C3.32 21.3 7.34 24 12 24Z"/>
  <path fill="#FBBC05" d="M5.16 14.42a7.4 7.4 0 0 1-.4-2.4c0-.84.15-1.65.39-2.4L1.3 6.65A11.96 11.96 0 0 0 0 12c0 1.93.47 3.76 1.32 5.35l3.84-2.93Z"/>
  <path fill="#EA4335" d="M12 4.76c2.25 0 3.77.97 4.64 1.78l3.38-3.3C17.94 1.2 15.24 0 12 0 7.34 0 3.32 2.7 1.32 6.65l3.84 2.97C6.12 6.85 8.82 4.76 12 4.76Z"/></svg>`;

// ---------------- shell ----------------

function mountShell() {
  root.innerHTML = String(html`
    <div class="app adm" id="app">
      <div class="scrim" id="scrim"></div>
      <aside class="side" aria-label="Admin navigation">
        <a class="logo" href="/admin" data-link>${logoMark()}<span>TRADE<b>LOCK</b></span></a>
        <span class="adm-tag">Admin console</span>
        ${MENU.map(([group, items]) => html`
          <div class="nav-group">${group}</div>
          ${items.map(([path, label, ic]) => html`<a class="nav-item" href="/admin${path ? `/${path}` : ''}" data-link data-page="${path}">${icon(ic)}${label}<span class="badge" data-badge="${path}" hidden></span></a>`)}`)}
        <div class="side-foot">
          <a class="nav-item" href="/" target="_blank" rel="noopener">${icon('arrow')}Open tradelock.in</a>
          <div class="user-row">
            <span class="avatar">${me.email[0].toUpperCase()}</span>
            <div class="who"><b>${me.name}</b><span>${me.email}</span></div>
            <button class="icon-btn" id="logout" title="Sign out" aria-label="Sign out">${icon('logout')}</button>
          </div>
        </div>
      </aside>
      <main class="main">
        <div class="topbar">
          <button class="icon-btn menu-btn" id="menu" aria-label="Open menu">${icon('menu')}</button>
          <div class="grow"><h1 id="pg-title"></h1><p class="t-sub" id="pg-sub"></p></div>
          <div class="top-right">
            <button class="icon-btn" id="refresh" title="Refresh" aria-label="Refresh">${icon('refresh')}</button>
            <button class="theme-btn" id="theme-btn" title="Switch theme" aria-label="Switch theme">${icon(resolvedTheme() === 'light' ? 'moon' : 'sun')}</button>
          </div>
        </div>
        <div id="page"></div>
      </main>
    </div>`);
  const app = $('#app');
  on(document, 'click', 'a[data-link]', (e, a) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    app.classList.remove('open');
    if (a.pathname !== location.pathname) history.pushState(null, '', a.pathname);
    show();
  });
  $('#menu').addEventListener('click', () => app.classList.add('open'));
  $('#scrim').addEventListener('click', () => app.classList.remove('open'));
  $('#refresh').addEventListener('click', () => active?.reload());
  $('#theme-btn').addEventListener('click', e => {
    setThemePref(resolvedTheme() === 'light' ? 'dark' : 'light');
    e.currentTarget.innerHTML = String(icon(resolvedTheme() === 'light' ? 'moon' : 'sun'));
  });
  $('#logout').addEventListener('click', async () => { await post('/auth/logout').catch(() => {}); location.replace('/admin'); });
  window.addEventListener('popstate', show);
}

/** Sidebar counters (open alerts, pending withdrawals), refreshed with the dashboard data. */
export function setBadges({ alerts, withdrawals }) {
  for (const [key, n] of [['alerts', alerts], ['withdrawals', withdrawals]]) {
    const b = document.querySelector(`[data-badge="${key}"]`);
    if (b && n != null) { b.hidden = !n; b.textContent = n; }
  }
}

async function show() {
  active?.dispose();
  const key = ROUTES[page()] ? page() : '';
  const [, label, , mod] = ROUTES[key];
  for (const a of document.querySelectorAll('[data-page]')) {
    if (a.dataset.page === key) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  document.title = `${label} · TradeLock Admin`;
  const el = $('#page');
  el.innerHTML = '<div class="loading">Loading…</div>';
  $('#pg-title').textContent = label;
  $('#pg-sub').textContent = '';
  const def = (await import(`./pages/${mod}.js`)).default;
  if (page() !== key && ROUTES[page()]) return; // navigated away while loading
  const ac = new AbortController();
  const ctx = {
    el, signal: ac.signal, ui: {}, data: null,
    paint() { el.innerHTML = String(html`<div class="page">${def.view(ctx)}</div>`); },
    async reload() {
      try { ctx.data = await def.load(ctx); }
      catch (e) {
        if (e.status === 401 || e.status === 403) return boot();
        if (!ctx.data) { el.innerHTML = `<div class="panel pad">${e.message}</div>`; return; }
        return toastError(e);
      }
      if (!ac.signal.aborted) ctx.paint();
    },
  };
  $('#pg-sub').textContent = def.sub || '';
  active = { dispose: () => ac.abort(), reload: () => ctx.reload() };
  await ctx.reload();
  def.mount?.(ctx);
  if (def.refreshMs) {
    const t = setInterval(() => { if (!document.hidden && !el.querySelector('input:focus')) ctx.reload(); }, def.refreshMs);
    ac.signal.addEventListener('abort', () => clearInterval(t));
  }
  window.scrollTo(0, 0);
}

async function boot() {
  const params = new URLSearchParams(location.search);
  try {
    me = await get('/admin/me');
  } catch (e) {
    if (e.status === 403) return deniedScreen((await get('/auth/me').catch(() => ({}))).user?.email || 'this account');
    const meta = await get('/meta').catch(() => ({}));
    return signInScreen({ error: AUTH_ERRORS[params.get('auth_error')] || (e.status === 401 ? null : e.message), mfa: params.has('mfa'), dev: meta.dev });
  }
  if (params.toString()) history.replaceState(null, '', location.pathname);
  mountShell();
  show();
  get('/admin/overview').then(o => setBadges({ alerts: o.alerts.length, withdrawals: o.withdrawals })).catch(() => {});
}

boot();
