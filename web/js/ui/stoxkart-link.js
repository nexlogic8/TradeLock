// Broker accounts → StoxKart tab: link the account (stage 1). The details are stored encrypted on the server and
// only tested here; Dhan stays the active broker for monitoring and Algo Trading.
import { html, on } from '../core/dom.js';
import { get, put, post, del } from '../core/api.js';
import { icon } from './icons.js';
import { pill, brokerLogo } from './parts.js';
import { ago } from '../core/format.js';
import { toast, toastError } from './toast.js';

const STATUS = { linked: ['Saved, not tested', 'amber'], verified: ['Connected', ''], failed: ['Disconnected · login failed', 'red'] };

const field = (id, label, type, hint, { required = true, value = '' } = {}) => html`
  <div class="field"><label for="${id}">${label}</label>
    <input class="input ${type === 'password' ? 'num' : ''}" id="${id}" type="${type}" autocomplete="off" spellcheck="false" value="${value}" ${required ? 'required' : ''}>
    ${hint ? html`<small class="muted">${hint}</small>` : ''}</div>`;

export function stoxkartPanel(ctx) {
  const l = ctx.data.links?.stoxkart || { linked: false }, ui = ctx.ui, editing = !l.linked || ui.skEdit, d = ui.skDraft || {};
  const [label, tone] = STATUS[l.status] || ['', ''];
  const acct = ctx.data.account ?? ctx.state?.dash?.broker;
  return html`
    <div class="sk-link mt">
      <div class="acct-head"><div class="acct-id ${l.status === 'verified' ? 'ok' : l.linked ? 'bad' : ''}">
        ${brokerLogo('stoxkart', 'StoxKart')}
        <div class="grow"><h2>StoxKart ${l.linked ? html`<span class="num muted" style="font-size:15px;font-weight:500">${l.clientId}</span> ${pill(label, tone, { dot: true, pulse: l.status === 'verified' })}` : pill('Beta', 'ice', { sm: true })}</h2>
          <span class="muted small">${l.linked ? `Last successful sync: ${l.trading && acct?.lastSyncAt ? ago(acct.lastSyncAt) : l.verifiedAt ? ago(l.verifiedAt) : 'not yet'}` : 'Link your StoxKart account (Superr API). Dhan keeps supplying the market data.'}</span></div></div></div>
      ${l.linked && !editing ? html`
        <div class="mt">
          <div class="cap"><b>Positions and orders</b>${pill('Available')}<p>Read every 2 seconds while the market is open.</p></div>
          <div class="cap"><b>Automated square-off</b>${pill('Available')}<p>StoxKart accepts orders from TradeLock, so exits can run. Keep <code>34.93.19.54</code> in your Superr API app's static IPs.</p></div>
          <div class="cap"><b>Account-wide lock (kill switch)</b>${pill('Not offered', 'grey')}<p>StoxKart has no API kill switch. When a rule is hit TradeLock closes positions and blocks its own orders.</p></div>
          <div class="cap"><b>Algo ID</b><span class="num muted">${l.algoId || '99999'}</span><p>Sent with every order, as SEBI's algo rules require. Change it with Update details if your Superr API app shows a different one.</p></div>
          <div class="cap"><b>Session</b><span class="num muted">Renews daily</span><p>TradeLock logs in to StoxKart each day with your TOTP, so there is no token to paste.</p></div>
        </div>
        ${l.status === 'failed' && l.lastError ? html`<div class="banner red mt">${icon('alert')}<div class="grow"><b>StoxKart refused the login.</b> ${l.lastError}<br><small class="muted">Check the password, API key/secret and TOTP secret, and that your API request is approved. Repeated wrong passwords can lock your StoxKart login.</small></div></div>` : ''}
        <div class="row mt">
          <button class="btn btn-primary" type="button" id="sk-test" ${ui.skBusy ? 'disabled' : ''}>${icon('refresh')}${ui.skBusy ? 'Logging in to StoxKart…' : 'Test connection'}</button>
          <button class="btn" type="button" id="sk-edit">${icon('key')}Update details</button>
          <button class="btn btn-ghost" type="button" id="sk-remove">${icon('x')}Remove</button>
        </div>` : html`
        <form class="sk-form mt" id="sk-form" autocomplete="off">
          <div class="halves">
            ${field('sk-client', 'StoxKart client ID', 'text', 'Your StoxKart login ID, e.g. SV12345', { required: !l.linked, value: d.clientId || '' })}
            ${field('sk-password', 'StoxKart password', 'password', l.linked ? 'Leave blank to keep the saved one' : 'Your StoxKart login password', { required: !l.linked, value: d.password || '' })}
            ${field('sk-key', 'API key', 'password', l.linked ? 'Leave blank to keep the saved one' : 'From your approved Superr API app (developers.stoxkart.com → My API Requests)', { required: !l.linked, value: d.apiKey || '' })}
            ${field('sk-secret', 'API secret', 'password', l.linked ? 'Leave blank to keep the saved one' : 'Shown with the API key once the request is approved', { required: !l.linked, value: d.apiSecret || '' })}
            ${field('sk-totp', 'TOTP secret (setup key)', 'password', l.linked ? 'Leave blank to keep the saved one' : 'The long setup key shown when you enabled TOTP (ENABLE TOTP on developers.stoxkart.com) — not the 6-digit code. TradeLock uses it to log in each morning.', { required: !l.linked, value: d.totpSecret || '' })}
            ${field('sk-algo', 'Algo ID', 'text', 'Shown under the Strategy of your Superr API app (developers.stoxkart.com → My API Requests). 99999 for NSE-BSE_NON_REGISTERED.', { required: false, value: d.algoId || l.algoId || '99999' })}
          </div>
          <p class="muted small">Stored encrypted on TradeLock's server for your account only, never shown again, and sent only to StoxKart (openapi.stoxkart.com). Orders and data from StoxKart will come from TradeLock's server IP 34.93.19.54, so keep it in your app's static IPs.</p>
          <div class="row">
            <button class="btn btn-primary" type="submit" ${ui.skBusy ? 'disabled' : ''}>${icon('check')}${ui.skBusy ? 'Saving…' : 'Save and test'}</button>
            ${l.linked ? html`<button class="btn btn-ghost" type="button" id="sk-cancel">Cancel</button>` : ''}
          </div>
        </form>`}
    </div>`;
}

export function bindStoxkart(ctx) {
  const { el, signal, ui } = ctx;
  const reload = async () => { ctx.data.links = { ...(ctx.data.links || {}), stoxkart: await get('/brokers/links/stoxkart') }; };
  const test = async () => {
    ui.skBusy = true; ctx.paint();
    try {
      await reload();
      ctx.data.links.stoxkart = await post('/brokers/links/stoxkart/test', {});
      const s = ctx.data.links.stoxkart;
      toast(s.status === 'verified' ? 'StoxKart connected.' : 'StoxKart refused the login: see the details below.', s.status === 'verified' ? 'ok' : 'warn');
    } catch (err) { toastError(err); }
    finally { ui.skBusy = false; ctx.paint(); }
  };
  on(el, 'submit', '#sk-form', async e => {
    e.preventDefault();
    // Read the fields before repainting: the repaint (busy state) re-renders the form empty.
    const val = id => el.querySelector(id)?.value ?? '';
    const body = { clientId: val('#sk-client'), password: val('#sk-password'), apiKey: val('#sk-key'), apiSecret: val('#sk-secret'), totpSecret: val('#sk-totp'), algoId: val('#sk-algo') };
    ui.skDraft = body;   // shown again if the save is refused, so only the named field needs fixing
    ui.skBusy = true; ctx.paint();
    try {
      ctx.data.links = { ...(ctx.data.links || {}), stoxkart: await put('/brokers/links/stoxkart', body) };
      ui.skEdit = false; ui.skDraft = null;
    } catch (err) { toastError(err); ui.skBusy = false; ctx.paint(); return; }
    ui.skBusy = false;
    await test();
  }, signal);
  on(el, 'click', '#sk-test', () => test(), signal);
  on(el, 'click', '#sk-edit', () => { ui.skEdit = true; ctx.paint(); }, signal);
  on(el, 'click', '#sk-cancel', () => { ui.skEdit = false; ui.skDraft = null; ctx.paint(); }, signal);
  on(el, 'click', '#sk-remove', async () => {
    if (!confirm('Remove the saved StoxKart details from TradeLock?')) return;
    try { ctx.data.links.stoxkart = await del('/brokers/links/stoxkart'); toast('StoxKart details removed.'); } catch (err) { toastError(err); }
    ctx.paint();
  }, signal);
}
