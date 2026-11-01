// Profile: who you are (name, email, mobile) and how your account is protected (two-step sign-in).
import { html, $, on } from '../core/dom.js';
import { get, post, patch } from '../core/api.js';
import { store } from '../core/store.js';
import { dateIST, paise } from '../core/format.js';
import { signOut } from '../core/session.js';
import { stopStream } from '../core/stream.js';
import { navigate } from '../core/router.js';
import { icon } from '../ui/icons.js';
import { pill, formError, avatar } from '../ui/parts.js';
import { toast, toastError } from '../ui/toast.js';

const dayStr = ts => (ts ? dateIST(ts) : '–');

/** One line: plan, status, validity date and a link to the Subscription page. */
function subscriptionSummary(sub) {
  if (!sub) return '';
  const paid = sub.status === 'active';
  const end = paid ? sub.currentPeriodEnd : sub.trialEndsAt;
  const status = !sub.active ? pill(paid ? 'Ended' : sub.trialBlocked ? 'No free trial' : 'Trial ended', 'red', { dot: true, sm: true })
    : paid ? pill('Active', '', { dot: true, sm: true }) : pill('Free trial', 'ice', { dot: true, sm: true });
  return html`
    <div class="panel pad mt sub-summary">
      <span class="sub-ico">${icon('card')}</span>
      <div class="grow"><b>${sub.plan}</b> ${status}
        <span class="muted small">${!sub.active ? 'Ended on' : paid ? 'Active until' : 'Trial ends on'} ${dayStr(end)}</span></div>
      <a class="btn btn-sm ${sub.active && paid ? '' : 'btn-primary'}" href="/billing">${sub.active && paid ? 'Manage subscription' : 'Subscribe now'}${icon('arrow')}</a>
    </div>`;
}

const initials = name => name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();

/** Delete my account: what happens, then type DELETE (and the authenticator code when two-step sign-in is on). */
function deletePanel(ctx) {
  const u = ctx.state.user;
  const open = ctx.ui.deleteOpen;
  const wallet = ctx.data.billing?.wallet?.total || 0;
  return html`
    <div class="panel pad mt del-panel" id="delete-account">
      <div class="set-row">
        <div><b>Delete account</b><span>Permanently delete your TradeLock account and its data.</span></div>
        ${open ? '' : html`<button class="btn btn-sm btn-danger-ghost" id="del-open">${icon('trash')}Delete account</button>`}
      </div>
      ${open ? html`
        <div class="del-box">
          <b>This cannot be undone. When you delete your account:</b>
          <ul>
            <li>Your profile, risk rules, P&amp;L history, alerts and settings are erased.</li>
            <li>Your broker is disconnected and its access token is deleted.</li>
            <li>Any time left on your plan ends and is not refunded.</li>
            ${wallet ? html`<li class="neg"><b>Your wallet balance of ${paise(wallet)} will be lost.</b> Withdraw it first from the <a href="/wallet">Wallet</a> page.</li>` : ''}
            <li>Payment records are kept without your name, as Indian tax law requires.</li>
          </ul>
          <div class="field"><label for="del-confirm">Type <b>DELETE</b> to confirm</label><input class="input num" id="del-confirm" autocomplete="off" autocapitalize="characters" spellcheck="false"></div>
          ${u.mfaEnabled ? html`<div class="field"><label for="del-code">Authenticator code</label><input class="input num" id="del-code" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></div>` : ''}
          ${formError(ctx.ui.delError)}
          <div class="row">
            <button class="btn btn-danger" id="del-go">${icon('trash')}Delete my account</button>
            <button class="btn btn-ghost" id="del-cancel">Cancel</button>
          </div>
        </div>` : ''}
    </div>`;
}

export default {
  title: 'Profile',
  sub: 'Your details and how your account is protected',
  layout: 'app',
  auth: true,

  // Account details plus live plan status (the signed-in user object can be older than a payment).
  async load() {
    const [settings, billing] = await Promise.all([get('/settings'), get('/billing').catch(() => null)]);
    if (billing?.subscription) store.set({ user: { ...store.get().user, subscription: billing.subscription } });
    return { ...settings, billing };
  },

  view(ctx) {
    const u = ctx.data.user;
    const mfa = ctx.ui.mfa;
    const sub = ctx.data.billing?.subscription || ctx.state.user?.subscription;
    return html`
      <div class="panel pad profile-head">
        ${avatar({ initials: initials(u.name), avatar: ctx.state.user?.avatar }, 'profile-avatar')}
        <div class="grow profile-who"><h2>${u.name}</h2><span class="muted">${u.email}</span></div>
        ${sub ? pill(sub.status === 'active' ? 'TradeLock Pro' : sub.status === 'trial' ? 'Free trial' : sub.status, sub.status === 'active' ? '' : 'ice', { dot: true }) : ''}
      </div>

      ${subscriptionSummary(sub)}

      <div class="halves fill mt">
        <form class="panel pad" id="account" novalidate>
          <h3 class="panel-title" style="margin-bottom:18px">${icon('user')} Personal details</h3>
          <div class="form-grid">
            <div class="field full"><label for="s-name">Display name</label><input class="input" id="s-name" value="${u.name}" maxlength="80"></div>
            <div class="field full"><label for="s-email">Email</label><input class="input" id="s-email" value="${u.email}" disabled>
              <span class="tiny dim">Your sign-in email. It can't be changed here.</span></div>
            <div class="field full"><label for="s-phone">Mobile number <span class="dim">(optional)</span></label>
              <input class="input num" id="s-phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+91 98765 43210" value="${u.phone || ''}">
              <span class="tiny dim">Prefilled when you pay, so the payment window doesn't ask for it.</span></div>
          </div>
          <button class="btn btn-primary mt" type="submit">Save details</button>
        </form>

        <div class="panel pad">
          <h3 class="panel-title" style="margin-bottom:6px">${icon('shield')} Security</h3>
          <div class="set-row">
            <div><b>Two-step sign-in</b><span>${u.mfaEnabled ? 'On. A code from your authenticator app is needed at sign-in and to use the kill switch.' : 'Recommended. Adds a 6-digit code from an authenticator app when you sign in.'}</span></div>
            ${u.mfaEnabled ? pill('On', '', { dot: true }) : mfa ? '' : html`<button class="btn btn-sm btn-primary" id="mfa-start">Set up</button>`}
          </div>
          ${mfa ? html`
            <div class="well stack">
              <span class="small">Add this key to Google Authenticator, 1Password or any TOTP app, then enter the 6-digit code it shows.</span>
              <span class="secret">${mfa.secret.replace(/(.{4})/g, '$1 ').trim()}</span>
              <div class="field"><label for="mfa-code">Code</label><input class="input num" id="mfa-code" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></div>
              ${formError(ctx.ui.error)}
              <div class="row"><button class="btn btn-primary btn-sm" id="mfa-enable">Turn on</button><button class="btn btn-ghost btn-sm" id="mfa-cancel">Cancel</button></div>
            </div>` : ''}
          <div class="set-row">
            <div><b>Sign out</b><span>Ends your session on this device.</span></div>
            <button class="btn btn-sm" id="profile-logout">${icon('logout')}Sign out</button>
          </div>
        </div>
      </div>
      ${deletePanel(ctx)}`;
  },

  mount(ctx) {
    const { el, signal, ui } = ctx;
    on(el, 'click', '#del-open', () => { ctx.ui.deleteOpen = true; ctx.ui.delError = null; ctx.paint(); $('#del-confirm', el)?.focus(); }, signal);
    on(el, 'click', '#del-cancel', () => { ctx.ui.deleteOpen = false; ctx.paint(); }, signal);
    on(el, 'click', '#del-go', async (_, b) => {
      const confirm = $('#del-confirm', el)?.value || '';
      const code = $('#del-code', el)?.value || '';
      if (confirm.trim().toUpperCase() !== 'DELETE') { ctx.ui.delError = 'Type DELETE to confirm.'; ctx.paint(); return; }
      b.disabled = true;
      try {
        await post('/account/delete', { confirm, code });
        stopStream();
        store.set({ user: null, dash: null, emergency: null, unread: 0 });
        toast('Your TradeLock account has been deleted.');
        navigate('landing');
      } catch (e) { ctx.ui.delError = e.message; ctx.paint(); }
    }, signal);
    on(el, 'submit', '#account', async e => {
      e.preventDefault();
      try {
        const { user } = await patch('/settings', { name: $('#s-name', el).value, phone: $('#s-phone', el).value });
        ctx.data.user = user;
        store.set({ user: { ...store.get().user, ...user } });
        toast('Details saved.');
        ctx.paint();
      } catch (err) { toastError(err); }
    }, signal);
    on(el, 'click', '#mfa-start', async () => {
      try { ui.mfa = await post('/auth/mfa/setup'); ui.error = null; ctx.paint(); $('#mfa-code', el)?.focus(); } catch (err) { toastError(err); }
    }, signal);
    on(el, 'click', '#mfa-cancel', () => { ui.mfa = null; ctx.paint(); }, signal);
    on(el, 'click', '#mfa-enable', async (_, b) => {
      b.disabled = true;
      try {
        const { user } = await post('/auth/mfa/enable', { code: $('#mfa-code', el).value.trim() });
        ctx.data.user = user;
        store.set({ user });
        ui.mfa = null;
        toast('Two-step sign-in is on.');
      } catch (err) { ui.error = err.message; }
      ctx.paint();
    }, signal);
    on(el, 'click', '#profile-logout', () => signOut(), signal);
  },
};
