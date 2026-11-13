import { html, $, on } from '../core/dom.js';
import { get, post, del } from '../core/api.js';
import { ago, dateIST, inr } from '../core/format.js';
import { refreshUser } from '../core/session.js';
import { store } from '../core/store.js';
import { icon } from '../ui/icons.js';
import { pill, formError, brokerLogo } from '../ui/parts.js';
import { toast } from '../ui/toast.js';
import { mountKillSwitch } from '../ui/killswitch.js';
import { connectPanel, bindConnect, placeBrokerIndicator, brokerTabs, soonPanel, myIp } from '../ui/connect.js';
import { stoxkartPanel, bindStoxkart } from '../ui/stoxkart-link.js';

const CAP = {
  positions: ['Positions and orders', { available: ['Available', ''] }, 'Read every 2 seconds while the market is open.'],
  squareOff: ['Automated square-off', { available: ['Available', ''], permission: ['Subject to permissions', 'amber'] }, 'Needs order placement enabled for your API token.'],
  accountLock: ['Account-wide lock', { killswitch: ['Kill switch', 'ice'], available: ['Available', ''], unverified: ['Not verified', 'grey'] }, "Uses the broker's kill switch, which also blocks orders from the broker's own app. It needs a flat account to switch on."],
};

// This pane is the connected account's own broker (Dhan): its label turns into StoxKart while orders go through StoxKart.
const ownBroker = a => ({ dhan: 'Dhan', mock: 'Demo broker' })[a.broker] || a.label;

function squareOffRow(a, mine) {
  const p = a.permissions;
  if (a.broker === 'mock' || p?.ordersAllowed === true) {
    return html`<div class="cap"><b>Automated square-off</b>${pill('Available')}<p>${ownBroker(a)} accepts orders from TradeLock, so exits and the kill switch can run.</p></div>`;
  }
  if (p?.ordersAllowed === false) {
    return html`<div class="cap cap-alert"><b>Automated square-off</b>${pill('Blocked · static IP', 'red')}
      <p><b>${ownBroker(a)} will reject exit orders from TradeLock.</b> Under SEBI rules ${ownBroker(a)} only accepts API orders from your registered static IP.
      TradeLock sends your orders from <code>${mine.ip}</code>; your registered IP${p.registeredIps.length === 1 ? ' is' : 's are'} ${p.registeredIps.length ? p.registeredIps.map((ip, i) => html`${i ? ' and ' : ''}<code>${ip}</code>`) : 'not set'}.</p>
      <p>Fix: ${ownBroker(a)} web → <b>My Profile → DhanHQ Trading APIs → Static IP Setting</b> → <b>Edit</b> IP Address 1 or 2 → set <code>${mine.ip}</code>${mine.own ? ' (your own TradeLock IP)' : mine.alt ? html` (or, if Dhan says it is already used by another account, TradeLock's IPv6 <code>${mine.alt}</code>)` : ''} as the primary or secondary IP. Replacing an IP another app uses will stop orders from that app.</p></div>`;
  }
  return html`<div class="cap"><b>Automated square-off</b>${pill('Checking…', 'grey')}<p>Checking whether ${ownBroker(a)} accepts orders from this server. Use Refresh now to check immediately.</p></div>`;
}

/** Is the broker session working right now? Connected · reconnecting (brief blip) · disconnected. */
function connBadge(a) {
  if (a.status === 'connected') return pill('Connected', '', { dot: true, pulse: true });
  if (a.status === 'delayed') return pill('Reconnecting…', 'amber', { dot: true });
  return pill(a.status === 'expired' ? 'Disconnected · token expired' : 'Disconnected', 'red', { dot: true });
}

function lockRow(a) {
  const ks = a.killSwitch;
  const status = ks?.active === true ? pill('ON · locked', 'red', { dot: true }) : ks?.active === false ? pill('Available · OFF', '', { dot: true }) : pill('Kill switch', 'ice');
  return html`<div class="cap"><b>Account-wide lock (kill switch)</b>${status}
    <p>Uses ${ownBroker(a)}'s kill switch, which also blocks orders from the ${ownBroker(a)} app. It needs a flat account to switch on.${ks ? ` Status read ${ago(ks.checkedAt)}.` : ''}</p></div>`;
}

// Paper trading as the first broker tab, with the paper wallet's balance.
async function withPaper(d) {
  d.catalog = [{ id: 'paper', name: 'Paper', status: 'available' }, ...d.catalog.filter(b => b.id !== 'paper')];
  d.paper = await get('/paper/wallet').catch(() => null);
  return d;
}

/** The Paper tab: in use or not, the paper wallet, and the switch between paper and real money. */
function paperView(ctx, a, real) {
  const p = ctx.data.paper, inUse = !a || a.broker === 'paper' || !!a.paperMode, name = real ? (ownBroker(real) === 'Paper' ? 'Dhan' : ownBroker(real)) : null;
  return html`
    <div class="panel pad" style="padding:26px">
      ${brokerTabs(ctx)}
      <div class="broker-pane ${ctx.ui.tabFrom ? 'enter' : ''}"><div class="mt">
        <div class="acct-head">
          <div class="acct-id ok">
            ${brokerLogo('paper', 'Paper')}
            <div class="grow"><h2>Paper trading ${inUse ? pill('In use', '', { dot: true, pulse: true }) : pill('Not in use', 'grey')}</h2>
              <span class="muted small">${p ? html`Paper wallet <b class="num">${inr(p.balance)}</b> · ` : ''}live prices, simulated fills, no order goes to any broker</span></div>
          </div>
        </div>
        <div class="mt">
          <div class="cap"><b>Orders</b>${pill('Simulated')}<p>Filled at the live price with the paper wallet's money; stop-losses rest until the price reaches them, as at a broker.</p></div>
          <div class="cap"><b>Prices</b>${pill('Live')}<p>From TradeLock's Dhan market data: option chain, quotes and the live feed. No broker account needed.</p></div>
          <div class="cap"><b>Algo Trading and risk rules</b>${pill('Available')}<p>Strategies, stop-loss, exits, your Risk rules and the day lock run exactly as with real money; Overview and P&amp;L show the paper account.</p></div>
        </div>
        <div class="row mt">
          ${!inUse ? html`<button class="btn btn-primary" id="paper-use">${icon('play')}Use paper trading</button>`
            : real ? html`<button class="btn" id="paper-real">${icon('link')}Switch to real money (${name})</button>` : ''}
          <a class="btn btn-ghost" href="/wallet" data-nav="wallet">${icon('wallet')}Set paper balance</a>
          <a class="btn btn-ghost" href="/algo" data-nav="algo">AI Algo Trading</a>
        </div>
        ${!real ? html`<p class="muted small mt">To trade with real money, open the <b>Dhan</b> tab and connect your account. It starts on Paper, and Real is one switch away.</p>` : ''}
      </div></div>
    </div>`;
}

// The connected account's own broker name (its label turns into the trading broker's when orders go via StoxKart).
const ownName = (catalog, a) => catalog.find(c => c.id === a.broker)?.name || a.label;

export default {
  title: 'Broker accounts',
  sub: 'Connection health and what your broker allows',
  layout: 'app',
  auth: true,

  // Paper trading is the first tab: the paper wallet at live prices (no broker needed), and the default.
  async load() { return withPaper(await get('/brokers')); },

  view(ctx) {
    const { catalog } = ctx.data;
    const a = ctx.state.dash?.broker ?? ctx.data.account;
    const ui = ctx.ui;
    const real = a && a.broker !== 'paper' ? a : null;   // the broker connection, if any (else the Paper account)
    ui.broker ??= !real || a.paperMode ? 'paper' : a.tradeVia === 'stoxkart' ? 'stoxkart' : a.broker;
    const soon = catalog.find(b => b.id === ui.broker && b.status !== 'available');
    if (ui.broker === 'paper') return paperView(ctx, a, real);
    if (!real) return connectPanel(ctx);
    if (ui.switching) return connectPanel(ctx, { cancel: true });
    return html`
      <div class="panel pad" style="padding:26px">
        ${brokerTabs(ctx)}
        <div class="broker-pane ${ui.tabFrom ? 'enter' : ''}">
        ${ui.broker !== a.broker && soon ? (soon.link ? stoxkartPanel(ctx) : soonPanel(soon)) : html`<div class="mt">
          <div class="acct-head">
            <div class="acct-id ${a.status === 'connected' ? 'ok' : 'bad'}">
              ${brokerLogo(a.broker, ownName(catalog, a))}
              <div class="grow"><h2>${ownName(catalog, a)} <span class="num muted" style="font-size:15px;font-weight:500">${a.clientId}</span> ${connBadge(a)}</h2>
                <span class="muted small">Last successful sync: ${ago(a.lastSyncAt)}${a.lastError && a.status !== 'connected' ? ` · ${a.lastError}` : ''}</span></div>
            </div>
            <div class="acct-actions">
              <div class="ks-slot" id="ks-broker"></div>
            </div>
          </div>
          <div class="mt">
            <div class="cap"><b>${CAP.positions[0]}</b>${pill('Available')}<p>${CAP.positions[2]}</p></div>
            ${squareOffRow(a, myIp(ctx))}
            ${lockRow(a)}
            ${a.tokenExpiresAt ? html`<div class="cap"><b>Access token expires</b><span class="num muted">${dateIST(a.tokenExpiresAt, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} IST</span><p>Dhan tokens last 24 hours. Paste a fresh one with Reconnect.</p></div>` : ''}
          </div>
          ${ui.reconnect && a.broker !== 'mock' ? html`
            <div class="well stack mt">
              <div class="field"><label for="b-token">New access token</label><input class="input num" id="b-token" type="password" autocomplete="off"></div>
              ${formError(ui.error)}
              <div class="row"><button class="btn btn-primary btn-sm" id="do-reconnect">Verify and save</button><button class="btn btn-ghost btn-sm" id="cancel-reconnect">Cancel</button></div>
            </div>` : ''}
          ${ui.confirmDisconnect ? html`
            <div class="banner red mt">${icon('alert')}<div class="grow"><b>Disconnect ${ownBroker(a)}?</b> Monitoring and rule enforcement stop immediately. Your stored token is deleted.</div>
              <button class="btn btn-sm btn-danger" id="do-disconnect">Disconnect</button><button class="btn btn-sm btn-ghost" id="cancel-disconnect">Keep</button></div>` : ''}
          <div class="row mt">
            <button class="btn btn-primary" id="sync-now">${icon('refresh')}Refresh now</button>
            <button class="btn" id="reconnect">${icon('link')}Reconnect broker</button>
            <button class="btn btn-ghost" id="perms" aria-expanded="${!!ui.perms}">${icon('key')}${ui.perms ? 'Hide' : 'View'} permissions</button>
            <button class="btn btn-ghost" id="disconnect">${icon('x')}Disconnect</button>
          </div>
          ${ui.perms ? html`<div class="well mt small">
            <b>${ownBroker(a)} APIs TradeLock uses</b>
            <ul class="bullets mt-s">
              <li><code>GET /positions</code>, <code>/orders</code>, <code>/trades</code> · positions, P&amp;L, order book and fills, every 2 s while the market is open</li>
              <li><code>GET /fundlimit</code> · available margin, used margin and capital</li>
              <li><code>GET /profile</code> · token expiry and active segments</li>
              <li><code>GET /ip/getIP</code> · whether ${ownBroker(a)} accepts orders from this server (static IP)</li>
              <li><code>GET /killswitch</code> · kill switch status, checked every 10 s</li>
              <li><code>POST /killswitch</code> · lock the account when a rule is hit or you press the kill switch (DEACTIVATE when you switch it off)</li>
              <li><code>POST /orders</code>, <code>DELETE /orders</code> · orders you place here, exits and the kill switch</li>
            </ul></div>` : ''}
        </div>`}
        </div>
      </div>`;
  },

  onStore(ctx, patch) {
    const key = `${patch.dash?.broker?.status}:${patch.dash?.broker?.agentOn}:${patch.dash?.broker?.permissions?.ordersAllowed}`;
    if (patch.dash && key !== ctx.ui.lastKey && !ctx.ui.reconnect && !ctx.ui.running && !ctx.ui.switching && (ctx.state.dash?.broker || ctx.data.account)) {
      ctx.ui.lastKey = key;
      ctx.paint();
    }
  },

  draw(ctx) {
    placeBrokerIndicator(ctx);
    const slot = document.getElementById('ks-broker');
    if (slot && !slot.dataset.ready) { slot.dataset.ready = '1'; mountKillSwitch(slot, ctx.signal, { compact: true }); }
  },

  mount(ctx) {
    const { el, signal, ui } = ctx;
    const account = () => ctx.state.dash?.broker ?? ctx.data.account;
    // Connect (no broker yet) or switch broker, right on this page.
    bindConnect(ctx, async () => {
      ctx.data = await withPaper(await get('/brokers')); ui.broker = undefined;
      Object.assign(ui, { switching: false, progress: null, error: null });
      toast('Broker connected. Monitoring is live.');
    });
    on(el, 'click', '#cancel-switch', () => { ui.switching = false; ui.error = null; ctx.paint(); }, signal);
    // Paper tab: use paper trading (switch the broker account to Paper, or set up the Paper account), or go back to real.
    const reloadAll = async () => { ctx.data = await withPaper(await get('/brokers')); store.set({ dash: await get('/dashboard') }); ctx.paint(); };
    on(el, 'click', '#paper-use', async (_, b) => {
      const real = account()?.broker !== 'paper' ? account() : null;
      b.disabled = true;
      try {
        await (real ? post(`/brokers/${real.id}/paper`, { on: true }) : post('/paper/account'));
        toast('Paper trading on: the paper wallet at live prices, no orders to any broker.', 'ok');
        await reloadAll();
      } catch (e) { toast(e.message, 'error'); b.disabled = false; }
    }, signal);
    on(el, 'click', '#paper-real', async (_, b) => {
      if (!confirm('Switch to REAL money on your broker account?')) return;
      b.disabled = true;
      try {
        await post(`/brokers/${account().id}/paper`, { on: false });
        toast('Real trading on: your broker account, real money.', 'warn');
        ui.broker = undefined;
        await reloadAll();
      } catch (e) { toast(e.message, 'error'); b.disabled = false; }
    }, signal);
    bindStoxkart(ctx);
    const doReconnect = async body => {
      await post(`/brokers/${account().id}/reconnect`, body);
      await refreshUser();
      ui.reconnect = false;
      ui.error = null;
      toast('Broker reconnected. Sync is live.');
    };
    on(el, 'click', '#sync-now', async (_, b) => {
      b.disabled = true;
      try {
        const { account: a } = await post(`/brokers/${account().id}/sync`);
        toast(a.status === 'connected' ? 'Refreshed from your broker.' : `Sync failed: ${a.lastError || a.status}`, a.status === 'connected' ? 'ok' : 'error');
      } catch (e) { toast(e.message, 'error'); }
      ctx.paint();
    }, signal);
    on(el, 'click', '#reconnect', async (_, b) => {
      if (account().broker !== 'mock') { ui.reconnect = true; ctx.paint(); return $('#b-token', el)?.focus(); }
      b.disabled = true;
      try { await doReconnect({}); } catch (e) { toast(e.message, 'error'); }
      ctx.paint();
    }, signal);
    on(el, 'click', '#do-reconnect', async (_, b) => {
      b.disabled = true;
      try { await doReconnect({ accessToken: $('#b-token', el).value }); } catch (e) { ui.error = e.message; }
      ctx.paint();
    }, signal);
    on(el, 'click', '#cancel-reconnect', () => { ui.reconnect = false; ui.error = null; ctx.paint(); }, signal);
    on(el, 'click', '#perms', () => { ui.perms = !ui.perms; ctx.paint(); }, signal);
    on(el, 'click', '#disconnect', () => { ui.confirmDisconnect = true; ctx.paint(); }, signal);
    on(el, 'click', '#cancel-disconnect', () => { ui.confirmDisconnect = false; ctx.paint(); }, signal);
    on(el, 'click', '#do-disconnect', async (_, b) => {
      b.disabled = true;
      try {
        await del(`/brokers/${account().id}`);
        // Drop the live broker right away (top bar, sidebar, this page); the server's snapshot follows.
        if (store.get().dash) store.set({ dash: { ...store.get().dash, broker: null } });
        await refreshUser();
        ctx.data = await withPaper(await get('/brokers'));
        Object.assign(ui, { confirmDisconnect: false, justConnected: false, broker: null, progress: null, error: null });
        toast('Broker disconnected. Monitoring has stopped.', 'warn');
      } catch (e) { toast(e.message, 'error'); }
      ctx.paint();
    }, signal);
  },
};
