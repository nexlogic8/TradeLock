// Persistent app chrome: sidebar, top bar, protection banner. Pages render into #page.
import { html, $ } from '../core/dom.js';
import { store } from '../core/store.js';
import { get, post } from '../core/api.js';
import { istNow, paise, inr, ago } from '../core/format.js';
import { signOut } from '../core/session.js';
import { resolvedTheme, setThemePref } from '../core/theme.js';
import { icon, logoMark } from './icons.js';
import { statusOf, toneColor, brokerMark, avatar } from './parts.js';
import { toast, toastError } from './toast.js';
import { confirmDialog, noticeDialog, confirmAlgoStart } from './dialog.js';

const NAV = [
  ['Session', [['overview', 'Overview', 'grid'], ['scalper', 'Power Scalper', 'chart'], ['algo', 'AI Algo Trading', 'spark'], ['strategy', 'Strategy', 'radar'], ['backtest', 'Backtest', 'chart'], ['rules', 'Risk rules', 'sliders'], ['calendar', 'P&L calendar', 'calendar'], ['journal', 'Journal', 'book'], ['analytics', 'Analytics', 'chart']]],
  ['Account', [['profile', 'Profile', 'user'], ['wallet', 'Wallet', 'wallet'], ['brokers', 'Broker accounts', 'link'], ['billing', 'Subscription', 'card'], ['affiliate', 'Affiliate hub', 'share'], ['settings', 'Settings', 'gear']]],
];

// Right-hand profile panel (tap the profile picture).
const PROFILE_LINKS = [
  ['profile', 'My profile', 'user', 'Name, mobile, two-step sign-in'],
  ['wallet', 'Wallet', 'wallet', 'Balance, add money, withdraw'],
  ['billing', 'Subscription', 'card', 'Plan, validity and payment'],
  ['brokers', 'Broker accounts', 'link', 'Dhan connection and kill switch'],
  ['affiliate', 'Refer & earn', 'share', 'Invite traders, earn every month'],
  ['settings', 'Settings', 'gear', 'Theme, notifications and alerts'],
];

// Phone-width bottom bar, shared by the Android WebView and mobile web app.
// Keep AI Algo one tap away on phones (including the Android WebView). The complete
// navigation remains in the drawer; Profile stays available as the avatar tab.
// The Menu tab (avatar) opens the panel with every page, so nothing is out of reach on a phone.
// Phone tab bar; Power Scalper is the raised round button in the middle.
const TABS = [['overview', 'Home', 'grid'], ['algo', 'Algo', 'spark'], ['scalper', 'Scalper', 'chart', 'tab-bubble'], ['rules', 'Rules', 'sliders'], ['profile', 'Menu', 'menu']];

let shell = null;

export function mountShell(root) {
  if (shell) return shell;
  root.innerHTML = String(html`
    <div class="app" id="app">
      <div class="scrim" id="scrim"></div>
      <aside class="side" aria-label="Main navigation">
        <a class="logo" href="/overview">${logoMark()}<span>TRADE<b>LOCK</b></span></a>
        ${NAV.map(([group, items]) => html`
          <div class="nav-group">${group}</div>
          ${items.map(([id, label, ic, cls]) => html`
            <a class="nav-item ${cls || ''}" href="/${id}" data-nav="${id}">${icon(ic)}${label}</a>`)}`)}
        <div class="side-foot">
          <div class="status-card" id="side-status"></div>
          <div class="user-row">
            <a class="who-link" href="/profile" title="Your profile">
              <span class="av-slot" id="side-avatar"></span>
              <div class="who"><b id="side-name"></b><span id="side-email"></span></div>
            </a>
            <button class="icon-btn" id="logout" title="Sign out" aria-label="Sign out">${icon('logout')}</button>
          </div>
        </div>
      </aside>
      <main class="main">
        <div class="topbar">
          <button class="icon-btn menu-btn" id="menu" aria-label="Open menu">${icon('menu')}</button>
          <div class="grow"><h1 id="pg-title"></h1><p class="t-sub" id="pg-sub"></p></div>
          <div class="top-right">
            <span class="chip-btn market-chip" id="clock" role="status"></span>
            <div class="wallet-wrap">
              <button class="agent-btn" id="agent-btn" type="button" hidden></button>
            </div>
            <button class="agent-btn algo-btn" id="algo-btn" type="button" hidden></button>
            <a class="chip-btn" id="conn-chip" href="/brokers"></a>
            <button class="theme-btn" id="theme-btn" type="button"></button>
          </div>
          <div class="header-actions"><div class="wallet-wrap">
              <button class="chip-btn wallet-btn" id="wallet-btn" aria-haspopup="dialog" aria-expanded="false" aria-controls="wallet-pop" title="Today's P&L">${icon('chart')}<span class="num" id="wallet-total">₹–</span></button>
              <div class="panel wallet-pop" id="wallet-pop" role="dialog" aria-label="Wallet" hidden></div>
            </div>
<a class="icon-btn notification-btn" href="/alerts" aria-label="Notifications">${icon('bell')}<span class="badge" id="notification-badge" hidden></span></a></div>
        </div>
        <div id="banner-slot" role="status"></div>
        <div id="page"></div>
      </main>
      <div class="pdrawer-scrim" id="pdrawer-scrim" hidden></div>
      <aside class="pdrawer" id="pdrawer" role="dialog" aria-modal="true" aria-label="Your profile" aria-hidden="true">
        <div class="pd-head" id="pd-head"></div>
        <div class="pd-section pd-phone">Trading</div>
        <nav class="pd-grid pd-phone" aria-label="All trading pages">
          ${NAV[0][1].map(([id, label, ic]) => html`<a class="pd-tile" href="/${id}" data-pd data-pd-page="${id}">${icon(ic)}<span>${label}</span></a>`)}
        </nav>
        <div class="pd-section pd-phone">Account</div>
        <nav class="pd-grid pd-phone" aria-label="Account pages">
          ${PROFILE_LINKS.map(([id, label, ic]) => html`<a class="pd-tile" href="/${id}" data-pd data-pd-page="${id}">${icon(ic)}<span>${label}</span></a>`)}
        </nav>
        <nav class="pd-links pd-desktop">
          ${PROFILE_LINKS.map(([id, label, ic, sub]) => html`<a class="pd-link" href="/${id}" data-pd data-pd-page="${id}">${icon(ic)}<span><b>${label}</b><small>${sub}</small></span>${icon('arrow')}</a>`)}
        </nav>
        <button class="pd-logout" id="pd-logout" type="button">${icon('logout')}Sign out</button>
      </aside>
      <nav class="tabbar" aria-label="Quick navigation">
        ${TABS.map(([id, label, ic, cls]) => id === 'profile' ? html`<button class="tab" id="top-avatar" type="button" aria-label="Open the menu: all pages and your profile" aria-haspopup="dialog" aria-controls="pdrawer" aria-expanded="false"><span id="tab-avatar"></span><span>${label}</span></button>` : html`<a class="tab ${cls || ''}" href="/${id}" data-nav="${id}">${icon(ic)}<span>${label}</span></a>`)}
      </nav>
    </div>`);

  const app = $('#app');
  const ac = new AbortController();
  const { signal } = ac;
  $('#menu').addEventListener('click', () => app.classList.add('open'), { signal });
  const drawer = $('#pdrawer'), dScrim = $('#pdrawer-scrim');
  const setDrawer = (open, fromBack = false) => {
    if (open === drawer.classList.contains('open')) return;
    // Phone back button closes the panel: opening adds a history entry, closing removes it.
    if (open) history.pushState({ pd: 1 }, '');
    else if (!fromBack && history.state?.pd) history.back();
    dScrim.hidden = !open;
    drawer.classList.toggle('open', open);
    drawer.setAttribute('aria-hidden', String(!open));
    $('#top-avatar').setAttribute('aria-expanded', String(open));
    document.documentElement.classList.toggle('pd-open', open);
    if (open) drawer.scrollTop = 0;
    paintBars();
  };
  // Android app: the strip behind the status bar takes the colour of what is on top.
  const paintBars = () => {
    if (!window.TradeLockApp?.setBarColor) return;
    const css = getComputedStyle(document.documentElement);
    const open = drawer.classList.contains('open');
    const color = (open ? css.getPropertyValue('--raise') : css.getPropertyValue('--bg')).trim();
    window.TradeLockApp.setBarColor(color, document.documentElement.dataset.theme === 'light');
  };
  paintBars();
  window.addEventListener('popstate', () => { if (drawer.classList.contains('open')) setDrawer(false, true); }, { signal });
  $('#top-avatar').addEventListener('click', () => setDrawer(true), { signal });
  dScrim.addEventListener('click', () => setDrawer(false), { signal });
  drawer.addEventListener('click', e => {
    if (e.target.closest('[data-pd-close]')) setDrawer(false);
    else if (e.target.closest('[data-pd]')) {
      // Leaving via a link: drop the panel's history entry first, then navigate (router handles the link).
      if (history.state?.pd) history.replaceState(null, '');
      dScrim.hidden = true; drawer.classList.remove('open'); drawer.setAttribute('aria-hidden', 'true');
      document.documentElement.classList.remove('pd-open');
      paintBars();
    }
  }, { signal });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && drawer.classList.contains('open')) setDrawer(false); }, { signal });
  $('#pd-logout').addEventListener('click', () => { setDrawer(false); signOut(); }, { signal });
  // Swipe right to close.
  let sx = null;
  drawer.addEventListener('touchstart', e => { sx = e.touches[0].clientX; }, { passive: true, signal });
  drawer.addEventListener('touchend', e => { if (sx != null && e.changedTouches[0].clientX - sx > 70) setDrawer(false); sx = null; }, { passive: true, signal });
  $('#scrim').addEventListener('click', () => app.classList.remove('open'), { signal });
  app.addEventListener('click', e => { if (e.target.closest('.nav-item')) app.classList.remove('open'); }, { signal });
  $('#logout').addEventListener('click', signOut, { signal });

  // Protection switch. The server refuses disabling it on a day a limit was hit.
  // Flip at once (this switch and the Rules page's Start / Stop Protection repaint from the store), then
  // confirm with the server; a refusal flips both back.
  const setAgent = async on => {
    const id = store.get().dash?.broker?.id;
    if (!id) return;
    const setOn = v => { const d = store.get().dash; if (d?.broker) store.set({ dash: { ...d, broker: { ...d.broker, agentOn: v } } }); };
    setOn(on);
    try {
      const result = await post(`/brokers/${id}/agent`, { on });
      const current = store.get().dash;
      if (current && result.account) store.set({ dash: { ...current, broker: result.account } });
    } catch (err) { setOn(!on); toastError(err); }
  };
  // Protection switch (also behind Start / Stop Protection on the Rules page): stopping asks first, and on a
  // day it is locked it says why instead of flipping and flipping back.
  $('#agent-btn').addEventListener('click', async e => {
    e.stopPropagation();
    const dash = store.get().dash, on = dash?.broker?.agentOn === false, label = dash?.broker?.label || 'broker';
    if (!on && dash?.algoLocked) {
      await noticeDialog({ ic: 'lock', tone: 'warn', title: 'Protection stays on in market hours', confirm: 'Got it',
        body: 'Algo Trading is on, and it stays on during market hours (09:15–15:30 IST), so Protection, which it needs, stays on too. You can stop them after 15:30.' });
      return;
    }
    if (!on && dash?.agentLock) {
      await noticeDialog({ ic: 'lock', tone: 'warn', title: 'Protection stays on today', confirm: 'Got it',
        body: `Today ${dash.agentLock}, so protection can't be stopped until the next trading day. That way it can never be used to get around your own limits.` });
      return;
    }
    if (!on && !(await confirmDialog({ ic: 'shield', tone: 'danger', title: 'Stop Protection?', confirm: 'Stop Protection', cancel: 'Keep it on',
      points: [html`Your ${label} account is <b>not watched</b> any more.`, html`Limits are <b>not enforced</b> and nothing is exited automatically.`, html`<b>Algo Trading stops</b> too.`] }))) return;
    setAgent(on);
  }, { signal });
  // Android app: the phone rings for every Algo Trading entry (TradeAlertService in the app). It runs
  // while Algo Trading is on; the banner lists the phone permissions it still needs.
  let alarmWanted = null;
  const tradeAlarm = broker => {
    const app = window.TradeLockApp;
    if (!app?.startTradeAlerts || !broker) return { missing: [] };
    const want = !!broker.algoOn;
    if (want !== alarmWanted) { alarmWanted = want; try { want ? app.startTradeAlerts() : app.stopTradeAlerts(); } catch { /* older app */ } }
    if (!want) return { missing: [] };
    let st = {};
    try { st = JSON.parse(app.tradeAlertStatus() || '{}'); } catch { /* older app */ }
    const missing = [['notifications', 'notifications'], ['fullScreen', 'full-screen alert'], ['overlay', 'display over other apps'], ['dnd', 'Do Not Disturb access'], ['battery', 'no battery limit']]
      .filter(([k]) => st[k] === false).map(([, label]) => label);
    return { missing };
  };
  window.__tlAlertsChanged = () => update();
  app.addEventListener('click', e => {
    if (e.target.closest('[data-alarm-setup]')) window.TradeLockApp?.setupTradeAlerts?.();
    else if (e.target.closest('[data-alarm-test]')) window.TradeLockApp?.testTradeAlarm?.();
  }, { signal });

  // Algo Trading switch: live ORB 5m auto entries. Turning it on places real orders, so it asks first.
  $('#algo-btn').addEventListener('click', async e => {
    e.stopPropagation();
    const broker = store.get().dash?.broker;
    if (!broker?.id) return;
    const on = !broker.algoOn;
    if (!on && store.get().dash?.algoLocked) {
      await noticeDialog({ ic: 'lock', tone: 'warn', title: 'Algo Trading stays on until 15:30', confirm: 'Got it',
        body: 'Algo Trading can’t be switched off during market hours (09:15–15:30 IST). Exits are always allowed: you can close an Algo trade yourself at any time.' });
      return;
    }
    if (on && !(await confirmAlgoStart())) return;
    // Flip at once (this switch and the AI Algo Trading page repaint from the store), then confirm with the server.
    const setOn = v => { const d = store.get().dash; if (d?.broker) store.set({ dash: { ...d, broker: { ...d.broker, algoOn: v } } }); };
    setOn(on);
    try {
      const result = await post(`/brokers/${broker.id}/algo`, { on });
      const current = store.get().dash;
      if (current && result.account) store.set({ dash: { ...current, broker: result.account } });
      toast(on ? 'Algo Trading is on. Live orders will be placed automatically.' : 'Algo Trading is off.', on ? 'warn' : 'ok');
    } catch (err) { setOn(!on); toastError(err); }
  }, { signal });
  app.addEventListener('click', e => {
    const b = e.target.closest('[data-agent]');
    if (b) { b.disabled = true; setAgent(b.dataset.agent === 'start').finally(() => { b.disabled = false; }); }
  }, { signal });

  // Light / dark toggle (Settings also offers "follow the system").
  const themeBtn = $('#theme-btn');
  const paintThemeBtn = () => {
    const light = resolvedTheme() === 'light';
    themeBtn.innerHTML = String(icon(light ? 'moon' : 'sun'));
    themeBtn.setAttribute('aria-label', light ? 'Switch to dark theme' : 'Switch to light theme');
    themeBtn.title = themeBtn.getAttribute('aria-label');
  };
  themeBtn.addEventListener('click', () => { setThemePref(resolvedTheme() === 'light' ? 'dark' : 'light'); paintThemeBtn(); }, { signal });
  paintThemeBtn();

  // Today's P&L chip; its popover: the day's P&L, broker margin and the TradeLock wallet at a glance.
  const pop = $('#wallet-pop'), wbtn = $('#wallet-btn');
  const setOpen = open => { pop.hidden = !open; wbtn.setAttribute('aria-expanded', open); if (open) renderWallet(); };
  wbtn.addEventListener('click', e => { e.stopPropagation(); setOpen(pop.hidden); }, { signal });
  document.addEventListener('click', e => { if (!pop.hidden && !e.target.closest('.wallet-wrap')) setOpen(false); }, { signal });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !pop.hidden) { setOpen(false); wbtn.focus(); } }, { signal });
  pop.addEventListener('click', e => {
    const a = e.target.closest('[data-section]');
    if (!a) return;
    window.__walletSection = a.dataset.section;
    setOpen(false);
    if (location.pathname === '/wallet') document.getElementById(`sec-${a.dataset.section}`)?.scrollIntoView({ behavior: 'smooth' });
  }, { signal });
  get('/wallet').then(w => store.set({ wallet: w.balances })).catch(() => {});
  $('#side-status').addEventListener('click', async e => {
    if (!e.target.closest('#sim-outage')) return;
    try { await post('/dev/outage', { seconds: 45 }); toast('Demo broker will stop answering for 45 seconds.', 'warn'); } catch (err) { toastError(err); }
  }, { signal });

  let mod = null;
  const renderWallet = () => {
    const s = store.get(), w = s.wallet, f = s.dash?.funds, b = s.dash?.broker, d = s.dash;
    const pnl = b && Number.isFinite(d?.pnl) ? d.pnl : null;
    const signed = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${inr(Math.abs(v), { dp: 0 })}`;
    const chip = $('#wallet-total');
    chip.textContent = pnl == null ? '₹–' : signed(pnl);
    chip.className = `num ${pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : ''}`;
    wbtn.title = pnl == null ? "Today's P&L (connect a broker)" : `Today's P&L ${signed(pnl)} · realized ${signed(d.realized)} · open ${signed(d.unrealized)}`;
    if (pop.hidden) return;
    pop.innerHTML = String(html`
      <div class="wp-sec">
        <div class="eyebrow">Today's P&L${b ? ` · ${b.label}` : ''}</div>
        <div class="wp-row"><span>Day P&L</span><b class="num ${pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : ''}">${pnl == null ? '–' : signed(pnl)}</b></div>
        <div class="wp-row"><span>Realized</span><span class="num">${pnl == null ? '–' : signed(d.realized)}</span></div>
        <div class="wp-row"><span>Open positions</span><span class="num">${pnl == null ? '–' : signed(d.unrealized)}</span></div>
      </div>
      <div class="wp-sec">
        <div class="eyebrow">${b?.label || 'Broker'} · trading account</div>
        <div class="wp-row"><span>Available margin</span><b class="num">${f?.available != null ? inr(f.available, { dp: 2 }) : '–'}</b></div>
        <div class="wp-row"><span>Used margin</span><span class="num">${f?.used != null ? inr(f.used, { dp: 2 }) : '–'}</span></div>
        <span class="tiny dim">${b?.lastSyncAt ? `Updated ${ago(b.lastSyncAt)} · stays with ${b.label}` : 'Connect a broker to see your margin'}</span>
      </div>
      <div class="wp-sec">
        <div class="eyebrow">TradeLock wallet</div>
        <div class="wp-row"><span>Balance</span><b class="num">${w ? paise(w.total) : '–'}</b></div>
        <div class="wp-row"><span>Added funds</span><span class="num">${w ? paise(w.funds) : '–'}</span></div>
        <div class="wp-row"><span>Earnings</span><span class="num pos">${w ? paise(w.earnings) : '–'}</span></div>
      </div>
      <div class="wp-actions">
        <a class="btn btn-primary btn-sm" href="/wallet" data-section="add">${icon('plus')}Add balance</a>
        <a class="btn btn-sm" href="/billing">${icon('card')}Pay subscription</a>
        <a class="btn btn-sm" href="/wallet" data-section="withdraw">${icon('bank')}Withdraw</a>
      </div>
      <a class="wp-link" href="/wallet">View wallet and activity ${icon('arrow')}</a>`);
  };

  const update = () => {
    const s = store.get();
    const st = statusOf(s);
    const u = s.user;
    if (u) {
      // Re-render the pictures only when the user (or their photo) changes, not on every live update.
      const key = `${u.initials}|${u.avatar}`;
      for (const slot of [$('#side-avatar'), $('#tab-avatar')]) {
        if (slot.dataset.for !== key) { slot.dataset.for = key; slot.innerHTML = String(avatar(u)); }
      }
      const sub = u.subscription;
      const plan = !sub ? '' : sub.status === 'active' ? 'TradeLock Pro' : sub.status === 'trial' ? 'Free trial' : 'Plan ended';
      const head = `${key}|${u.name}|${u.email}|${plan}`;
      const pd = $('#pd-head');
      if (pd.dataset.for !== head) {
        pd.dataset.for = head;
        pd.innerHTML = String(html`
          <button class="pd-close icon-btn" type="button" data-pd-close aria-label="Close">${icon('x')}</button>
          ${avatar(u, 'pd-avatar')}
          <b class="pd-name">${u.name}</b><span class="pd-email">${u.email}</span>
          ${plan ? html`<span class="pill sm ${sub.status === 'active' ? '' : 'ice'}"><span class="dot"></span>${plan}</span>` : ''}`);
      }
      $('#side-name').textContent = u.name;
      $('#side-email').textContent = u.email;
    }
    // Broker box: green dot when the broker session is connected, red otherwise (details on hover).
    const chip = $('#conn-chip');
    const bk = s.dash?.broker;
    const connected = !!bk && bk.status === 'connected' && s.live !== false;
    chip.className = `chip-btn broker-chip ${connected ? 'ok' : 'bad'}`;
    const via = bk && bk.tradeVia && bk.tradeVia !== bk.broker ? ' · orders via ' + bk.label + ', market data from Dhan' : '';
    chip.title = !bk ? 'No broker connected' : connected ? `${bk.label} connected${via}` : `${bk.label} not connected: ${st.label}${via}`;
    chip.setAttribute('aria-label', chip.title);
    chip.innerHTML = String(html`<span class="dot ${connected ? 'pulse' : ''}"></span>${bk ? brokerMark(bk.tradeVia || bk.broker, bk.label) : ''}<span>${bk?.label || 'Broker'}</span>`);
    const dev = s.meta?.dev && s.dash?.broker?.broker === 'mock';
    $('#side-status').innerHTML = String(html`
      <div class="head" style="color:${toneColor(st.tone)}"><span class="dot ${st.tone === 'ok' ? 'pulse' : ''}"></span>${st.label}</div>
      <p>${st.detail}</p>
      ${dev ? html`<button class="btn btn-sm btn-block" id="sim-outage">${icon('plug')}Simulate 45s outage</button>` : ''}`);
    const b = st.banner;
    const alarm = tradeAlarm(s.dash?.broker);
    $('#banner-slot').innerHTML = (b ? String(html`
      <div class="banner ${b.tone}">${icon(b.tone === 'info' ? 'info' : 'alert')}
        <div class="grow"><b>${b.title}</b></div>
        ${b.action ? html`<a class="btn btn-sm" href="/${b.action[0]}">${b.action[1]}</a>` : ''}
        ${b.agentStart ? html`<button class="btn btn-sm btn-primary" data-agent="start">Turn on protection</button>` : ''}
      </div>`) : '') + (alarm.missing.length ? String(html`
      <div class="banner amber alarm-banner">${icon('alert')}
        <div class="grow"><b>Trade alarm: ${alarm.missing.length} permission${alarm.missing.length > 1 ? 's' : ''} left</b>
          <span class="alarm-need">Allow ${alarm.missing.join(', ')} so entries ring with the app closed, on silent and in DND.</span></div>
        <div class="alarm-actions">
          <button class="btn btn-sm btn-primary" type="button" data-alarm-setup>Allow</button>
          <button class="btn btn-sm" type="button" data-alarm-test>Test</button>
        </div>
      </div>`) : '');
    const broker = s.dash?.broker;
    const agentBtn = $('#agent-btn');
    agentBtn.hidden = !broker;
    if (broker) {
      const on = broker.agentOn !== false;
      agentBtn.className = `agent-btn ${on ? 'on' : 'off'}`;
      agentBtn.innerHTML = String(html`<span class="protection-lock" aria-hidden="true"><span></span></span><span class="agent-label">Protection ${on ? 'On' : 'Off'}</span><span class="agent-switch" aria-hidden="true"><span></span></span>`);
      agentBtn.title = on ? 'TradeLock protection is on. Click to turn it off.' : 'TradeLock protection is off. Click to turn it on.';
      agentBtn.setAttribute('aria-label', agentBtn.title);
      agentBtn.setAttribute('aria-pressed', String(on));
    }
    const algoBtn = $('#algo-btn');
    algoBtn.hidden = broker?.broker !== 'dhan';
    if (!algoBtn.hidden) {
      const on = !!broker.algoOn;
      algoBtn.className = `agent-btn algo-btn ${on ? 'on' : 'off'}`;
      algoBtn.innerHTML = String(html`${icon('spark')}<span class="agent-label"><span class="long">Algo Trading</span><span class="short">Algo</span> ${on ? 'On' : 'Off'}</span><span class="agent-switch" aria-hidden="true"><span></span></span>`);
      algoBtn.title = on ? 'Live ORB 5m auto-trading is on. Click to stop new automatic entries.' : 'Live ORB 5m auto-trading is off. Click to turn it on.';
      algoBtn.setAttribute('aria-label', algoBtn.title);
      algoBtn.setAttribute('aria-pressed', String(on));
    }
    const badge = $('#notification-badge');
    badge.hidden = !s.unread;
    badge.textContent = s.unread > 99 ? '99+' : s.unread;
    if (mod && typeof mod.sub === 'function') $('#pg-sub').textContent = mod.sub(s);
  };
  const tickClock = () => {
    const n = istNow();
    // Market box: NSE session state (09:15–15:30 IST, weekdays) and the IST time.
    const el = $('#clock');
    el.className = `chip-btn market-chip ${n.open ? 'ok' : 'closed'}`;
    el.innerHTML = String(html`<span class="market-board-face"><span class="dot ${n.open ? 'pulse' : ''}"></span><span>Market ${n.open ? 'Open' : 'Closed'}</span><span class="num long">${n.hhmm} IST</span></span>`);
  };

  const off = store.on(patch => {
    if (['dash', 'live', 'unread', 'user', 'meta'].some(k => k in patch)) update();
    if ('wallet' in patch || 'dash' in patch) renderWallet();
    if ('theme' in patch) { paintThemeBtn(); paintBars(); }
  });
  const clock = setInterval(tickClock, 10_000);
  tickClock();
  update();

  shell = {
    page: $('#page'),
    activate(name, m) {
      mod = m;
      const navName = name;
      for (const a of document.querySelectorAll('[data-pd-page]')) a.toggleAttribute('aria-current', a.dataset.pdPage === navName);
      for (const a of document.querySelectorAll('[data-nav]')) {
        if (a.dataset.nav === navName) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
      }
      // Keep the TradeLock mark on every screen; away from Overview it is also a Home shortcut.
      const t = $('#pg-title');
      t.classList.toggle('brand', name === 'overview');
      t.classList.toggle('screen-title', name !== 'overview');
      if (name === 'overview') t.innerHTML = String(html`${logoMark()}<span>TRADE<b>LOCK</b></span>`);
      else t.innerHTML = String(html`<a class="header-home" href="/overview" aria-label="Go to Overview" title="Overview">${logoMark()}</a><span>${m.title}</span>`);
      $('#pg-sub').textContent = typeof m.sub === 'function' ? m.sub(store.get()) : m.sub || '';
    },
    destroy() { ac.abort(); off(); clearInterval(clock); },
  };
  return shell;
}

export function unmountShell() {
  if (!shell) return;
  shell.destroy();
  shell = null;
}
