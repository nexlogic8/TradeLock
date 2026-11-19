// Broker connection flow (choose broker, static IP step, access token, live checks). Shown on Broker accounts.
import { html, $, $$, on } from '../core/dom.js';
import { get, post } from '../core/api.js';
import { store } from '../core/store.js';
import { refreshUser } from '../core/session.js';
import { icon } from './icons.js';
import { pill, formError, brokerLogo } from './parts.js';
import { toast, toastError } from './toast.js';

/** The static IP this user registers at Dhan: their own when the server has an IPv6 block, else the shared one. */
export const myIp = ctx => ctx.data?.staticIp || { ip: ctx.state?.meta?.serverIp || '34.93.19.54', alt: ctx.state?.meta?.serverIpv6, own: false };

const DHAN_JOIN = 'https://join.dhan.co/?invite=LEPRP96225';

const STEPS = ['Review requested permissions', 'Authorize with your broker credentials', 'Check order access (static IP)', 'Test the monitoring connection'];

/** One segmented strip of brokers; the selected one carries the sliding highlight. */
// With orders going through StoxKart, the tabs say which broker trades and which supplies the market data.
const account = ctx => ctx.data.account ?? ctx.state?.dash?.broker;
const tradingVia = a => (a?.tradeVia === 'stoxkart' ? 'stoxkart' : a?.broker);
const role = (ctx, id) => {
  const a = account(ctx);
  if (!a || !ctx.data.links?.stoxkart?.linked) return '';
  const via = tradingVia(a);
  return id === via ? html`<small class="broker-role on">Trading</small>` : '';
};

export function brokerTabs(ctx) {
  const ui = ctx.ui;
  return html`
          <div class="broker-tabs" role="tablist" aria-label="Broker">
            <span class="broker-ind" aria-hidden="true"></span>
            ${ctx.data.catalog.map(b => html`
              <button class="broker-tab ${b.status === 'available' || b.link ? '' : 'soon'}" type="button" role="tab" data-broker="${b.id}" aria-selected="${ui.broker === b.id}" ${ui.running || ui.viaBusy ? 'disabled' : ''}>
                ${brokerLogo(b.id, b.name, { off: b.status !== 'available' && !b.link })}
                <b>${b.name}</b>${role(ctx, b.id)}
              </button>`)}
          </div>`;
}

export const soonPanel = b => html`
            <div class="broker-soon mt">
              ${brokerLogo(b.id, b.name, { off: true })}
              <b>${b.name} is coming soon</b>
              <p class="muted small">We're working on ${b.name} support. Until then, you can connect Dhan to use TradeLock.</p>
              ${pill('Coming soon', 'amber')}
            </div>`;

/** `cancel`: show a Cancel button (switching from an existing broker). */
export function connectPanel(ctx, { cancel = false } = {}) {
  const { catalog, account } = ctx.data;
  const ui = ctx.ui;
  ui.broker ??= account?.broker || 'dhan';
  const soon = catalog.find(b => b.id === ui.broker && b.status !== 'available');
  return html`
      <div>
        <div class="panel pad" style="padding:26px">
          ${brokerTabs(ctx)}
          <div class="broker-pane ${ui.tabFrom ? 'enter' : ''}">
          ${ui.broker === 'dhan' ? html`
            <div class="ip-box mt">
              <div class="row between"><b>${icon('shield')} Step 1 · Allow TradeLock's IP in Dhan</b>${ui.orders === true ? pill('Allowed', '', { sm: true }) : ui.orders === false ? pill('Not allowed yet', 'red', { sm: true }) : ''}</div>
              <p class="small muted">SEBI rules: Dhan only accepts API orders from your registered static IP. Add TradeLock's server IP so automatic exits and the kill switch can close positions. Monitoring and the kill switch work without it.</p>
              ${myIp(ctx).own ? html`<p class="small" style="margin:0 0 6px"><b>Your TradeLock IP</b> · only your account uses it, so Dhan accepts it as your static IP.</p>` : ''}
              <div class="row"><code class="ip">${myIp(ctx).ip}</code><button type="button" class="btn btn-sm" id="copy-ip">${icon('copy')}Copy IP</button></div>
              ${!myIp(ctx).own && myIp(ctx).alt ? html`<p class="muted small">Dhan says this IP is already used by another account? Use TradeLock's IPv6 instead: <code class="num">${myIp(ctx).alt}</code></p>` : ''}
              <ol class="steps-mini">
                <li>Open <b>web.dhan.co</b> → <b>My Profile</b> → <b>DhanHQ Trading APIs</b></li>
                <li>Scroll to <b>Static IP Setting</b> (not TOTP) → click <b>Edit</b> on <b>IP Address 1</b> or <b>IP Address 2</b></li>
                <li>Enter the IP above and save. Dhan allows two IPs, so replacing one stops orders from whatever used it</li>
              </ol>
            </div>
            <div class="row mt"><b class="small">Step 2 · Connect with your access token</b></div>
            <div class="form-grid mt-s">
              <div class="field"><label for="c-client">Dhan client ID</label><input class="input num" id="c-client" autocomplete="off" value="${ui.clientId || ''}"></div>
              <div class="field"><label for="c-token">Access token</label><input class="input num" id="c-token" type="password" autocomplete="off" value="${ui.token || ''}"></div>
              <p class="full tiny muted" style="margin:0">Generate a token at web.dhan.co → My Profile → Access DhanHQ APIs. Tokens expire every 24 hours; TradeLock will remind you to reconnect.</p>
            </div>` : soon ? soonPanel(soon) : ''}
          </div>
          <div class="mt">${formError(ui.error)}</div>
          ${ui.progress === STEPS.length && ui.ordersWarn ? html`<div class="banner amber">${icon('alert')}<div><b>Connected. Monitoring and the kill switch are on.</b> Dhan will reject exit orders from TradeLock until you add <code>${myIp(ctx).ip}</code> as your static IP (step 1). The Broker accounts page re-checks every 5 minutes.</div></div>` : ''}
          <div class="row mt">
            ${soon ? '' : html`<button class="btn btn-primary btn-lg" id="connect" ${ui.running ? 'disabled' : ''}>${icon('link')}${ui.running ? 'Connecting…' : `Connect ${catalog.find(b => b.id === ui.broker)?.name}`}</button>`}
            ${ui.broker === 'dhan' ? html`<a class="btn btn-lg" id="open-dhan" href="${DHAN_JOIN}" target="_blank" rel="noopener">${icon('plus')}Open Dhan account</a>` : ''}
            ${cancel ? html`<button class="btn btn-ghost" type="button" id="cancel-switch">Cancel</button>` : ''}
          </div>
        </div>
      </div>`;
}

/** `onDone(result)` runs after a successful connection. */
export function bindConnect(ctx, onDone) {
  const { el, signal, ui } = ctx;
    const keep = () => { ui.clientId = $('#c-client', el)?.value; ui.token = $('#c-token', el)?.value; };
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    on(el, 'click', '#copy-ip', async (_, b) => {
      const ip = myIp(ctx).ip;
      try { await navigator.clipboard.writeText(ip); b.lastChild.textContent = 'Copied'; } catch { b.lastChild.textContent = ip; }
    }, signal);
    // Android app: hand the sign-up to the browser / Dhan app (KYC needs camera and documents).
    on(el, 'click', '#open-dhan', e => {
      if (!window.TradeLockApp) return;
      e.preventDefault();
      location.href = `intent://${DHAN_JOIN.replace('https://', '')}#Intent;scheme=https;end`;
    }, signal);
    on(el, 'click', '[data-broker]', async (_, b) => {
      const id = b.dataset.broker;
      if (id !== ui.broker) {
        ui.tabFrom = ui.tabAt || null;   // slide from where the highlight is now
        keep(); ui.broker = id; ui.error = null; ctx.paint();
      }
      // Choosing a tab is the decision: Paper turns paper trading on, the broker's tab turns real money back on.
      // No second button. If it cannot switch now (something still open), the tab returns to the mode in use.
      const cur = ctx.state?.dash?.broker ?? ctx.data.account, real = cur && cur.broker !== 'paper' ? cur : null;
      const onPaper = !cur || cur.broker === 'paper' || !!cur.paperMode;
      if ((id === 'paper' && !onPaper) || (id === 'paper' && !cur) || (real && id === real.broker && onPaper)) {
        const toPaper = id === 'paper';
        ui.viaBusy = true; ctx.paint();
        try {
          await (real ? post(`/brokers/${real.id}/paper`, { on: toPaper }) : post('/paper/account'));
          toast(toPaper ? 'Paper trading on: the paper wallet at live prices, no orders to any broker.' : `Real trading on: your ${real.label === 'Paper' ? 'broker' : real.label} account, real money.`, toPaper ? 'ok' : 'warn');
          store.set({ dash: await get('/dashboard') });
          if (ctx.reload) await ctx.reload();
        } catch (err) {
          toastError(err);
          ui.broker = onPaper ? 'paper' : real?.broker;   // stays on the mode actually in use
        } finally { ui.viaBusy = false; ctx.paint(); }
        return;
      }
      // Choosing Dhan or a verified StoxKart link also makes it the broker the orders go to.
      const a = account(ctx), link = ctx.data.links?.stoxkart;
      if (!a || !link?.linked || id === tradingVia(a) || (id !== a.broker && id !== 'stoxkart')) return;
      if (id === 'stoxkart' && link.status !== 'verified') return;   // set it up / test it first
      const name = id === 'stoxkart' ? 'StoxKart' : 'Dhan';
      ui.viaBusy = true; ctx.paint();
      try {
        const r = await post('/brokers/links/stoxkart/trade-via', { on: id === 'stoxkart' });
        ctx.data.links = { ...(ctx.data.links || {}), stoxkart: r.link }; ctx.data.account = r.account;
        toast(`Orders now go through ${name}.`, 'ok');
      } catch (err) { toastError(err); }
      finally { ui.viaBusy = false; ctx.paint(); }
    }, signal);
    on(el, 'click', '#connect', async () => {
      keep();
      Object.assign(ui, { running: true, error: null, progress: 0 });
      ctx.paint();
      const request = post('/brokers/connect', { broker: ui.broker, clientId: ui.clientId, accessToken: ui.token });
      try {
        for (ui.progress = 1; ui.progress < 3; ui.progress++) { ctx.paint(); await sleep(350); }
        const res = await request;
        ui.orders = res.account?.permissions ? res.account.permissions.ordersAllowed !== false : null;
        ui.ordersWarn = res.checks.some(c => c.id === 'orders' && c.warn);
        ui.progress = 3; ctx.paint(); await sleep(300);
        if (!res.checks.every(c => c.ok || c.warn)) throw new Error('Connected, but the first sync did not succeed. Check the Broker accounts page.');
        ui.progress = STEPS.length;
        ui.token = '';
        await refreshUser();
        await onDone(res);
      } catch (e) {
        ui.error = e.message;
      }
      ui.running = false;
      if (!signal.aborted) ctx.paint();
      $$('#c-token', el).forEach(i => (i.value = ''));
    }, signal);
}

/** Puts the sliding highlight under the selected broker; after a switch it glides from the old one. Call after each paint. */
export function placeBrokerIndicator(ctx) {
  const ind = ctx.el.querySelector('.broker-ind');
  const tab = ctx.el.querySelector('.broker-tab[aria-selected="true"]');
  if (!ind || !tab) return;
  // Not laid out yet (page still entering): try again next frame.
  if (!tab.offsetWidth) { if (!ctx.signal.aborted) requestAnimationFrame(() => placeBrokerIndicator(ctx)); return; }
  const to = { left: tab.offsetLeft, width: tab.offsetWidth };
  const from = ctx.ui.tabFrom;
  ctx.ui.tabFrom = null;
  const set = p => { ind.style.transform = `translateX(${p.left}px)`; ind.style.width = `${p.width}px`; };
  if (from && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    ind.style.transition = 'none';
    set(from);
    void ind.offsetWidth;   // commit the start position before animating
    ind.style.transition = '';
  }
  if (!from) ind.style.transition = 'none';   // first placement: appear in place, no slide
  set(to);
  ctx.ui.tabAt = to;
  ind.classList.add('on');
  if (!from) { void ind.offsetWidth; ind.style.transition = ''; }
  tab.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: from ? 'smooth' : 'auto' });
}
