import { html, on } from '../core/dom.js';
import { get, patch } from '../core/api.js';
import { store } from '../core/store.js';
import { icon } from '../ui/icons.js';
import { toast, toastError } from '../ui/toast.js';
import { themePref, setThemePref } from '../core/theme.js';

const PREFS = [
  ['emergencyConfirm', 'Kill switch confirmation', 'Ask before the kill switch closes positions and locks the account'],
  ['push', 'In-app alerts', 'Show a pop-up for risk warnings and events'],
  ['brokerAlerts', 'Broker disconnect alerts', 'Alert when broker sync is delayed for more than 30 seconds'],
];

export default {
  title: 'Settings',
  sub: 'How TradeLock looks and when it alerts you',
  layout: 'app',
  auth: true,

  load: () => get('/settings'),

  view(ctx) {
    const u = ctx.data.user;
    return html`
      <div class="halves fill">
        <div class="panel pad">
          <h3 class="panel-title" style="margin-bottom:18px">${icon('gear')} Preferences</h3>
          <div class="form-grid">
            <div class="field full"><label id="s-theme-label">Theme</label>
              <div class="seg theme-seg" role="radiogroup" aria-labelledby="s-theme-label">${[['dark', 'Dark', 'moon', 'Dark theme'], ['light', 'Light', 'sun', 'Light theme'], ['system', 'System', 'monitor', 'Same as my device']].map(([v, l, ic, hint]) => html`<button type="button" role="radio" title="${hint}" data-theme-pref="${v}" aria-checked="${String(themePref() === v)}" aria-pressed="${String(themePref() === v)}">${icon(ic)}${l}</button>`)}</div>
              <span class="tiny dim">On a computer you can also switch with the sun / moon button at the top right.</span></div>
            <div class="field"><label for="s-tz">Timezone</label><select class="input" id="s-tz" disabled><option>Asia/Kolkata (IST)</option></select></div>
            <div class="field"><label for="s-cur">Currency</label><select class="input" id="s-cur" disabled><option>INR (₹)</option></select></div>
          </div>
          <p class="tiny dim">Times and amounts follow NSE conventions: IST and Indian rupees.</p>
          <p class="small muted" style="margin:14px 0 0">Your name, mobile number and two-step sign-in are on your <a href="/profile">Profile</a>.</p>
        </div>
        <div class="panel pad">
          <h3 class="panel-title" style="margin-bottom:6px">Alerts and confirmations</h3>
          ${PREFS.map(([k, title, desc]) => html`
            <div class="set-row"><div><b>${title}</b><span>${desc}</span></div>
              <button class="switch" type="button" role="switch" aria-checked="${u.prefs[k] !== false}" aria-label="${title}" data-pref="${k}"></button></div>`)}
        </div>
        ${window.TradeLockApp?.testTradeAlarm ? html`
        <div class="panel pad">
          <h3 class="panel-title" style="margin-bottom:6px">Trade alarm (this phone)</h3>
          <p class="small muted" style="margin:0 0 12px">While Algo Trading is on, every automatic entry rings this phone like an alarm, with the app open or closed, on silent and in Do Not Disturb, until you press Stop.</p>
          <div class="row" style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-sm btn-primary" type="button" id="s-alarm-test">Test alarm</button>
            <button class="btn btn-sm" type="button" id="s-alarm-setup">Check phone permissions</button>
          </div>
        </div>` : ''}
      </div>`;
  },

  mount(ctx) {
    const { el, signal } = ctx;
    const save = async body => {
      const { user } = await patch('/settings', body);
      ctx.data.user = user;
      store.set({ user: { ...store.get().user, ...user } });
      return user;
    };
    on(el, 'click', '#s-alarm-test', () => window.TradeLockApp?.testTradeAlarm?.(), signal);
    on(el, 'click', '#s-alarm-setup', () => window.TradeLockApp?.setupTradeAlerts?.(), signal);
    on(el, 'click', '[data-theme-pref]', (_, b) => {
      setThemePref(b.dataset.themePref);
      el.querySelectorAll('[data-theme-pref]').forEach(x => { const on_ = x === b; x.setAttribute('aria-checked', String(on_)); x.setAttribute('aria-pressed', String(on_)); });
      toast(`Theme: ${b.textContent.trim()}`);
    }, signal);
    on(el, 'click', '[data-pref]', async (_, b) => {
      const k = b.dataset.pref;
      const next = b.getAttribute('aria-checked') !== 'true';
      b.setAttribute('aria-checked', next);
      try { await save({ prefs: { [k]: next } }); } catch (err) { b.setAttribute('aria-checked', !next); toastError(err); }
    }, signal);
  },
};
