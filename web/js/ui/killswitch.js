// The kill switch control (Overview and Broker accounts). One click + one confirmation:
// TradeLock cancels pending orders, closes every open position, then switches on the broker's kill
// switch twice (Dhan: on, off, on), so it cannot be turned off again until the next trading day.
import { html, $ } from '../core/dom.js';
import { post } from '../core/api.js';
import { store } from '../core/store.js';
import { icon } from './icons.js';
import { brokerMark } from './parts.js';
import { toast, toastError } from './toast.js';

const ACTIONS = ['pause', 'cancel', 'exit', 'killswitch'];

/** What the switch shows right now. */
function stateOf({ dash: d, emergency: e }) {
  const ks = d?.killSwitch;
  if (!d?.broker || !ks?.supported) return { kind: 'na' };
  if (ks.activeAt || ks.broker?.active === true) return { kind: 'on' };
  if (e?.status === 'running' && e.actions?.includes('killswitch')) return { kind: 'working', text: 'Closing positions…' };
  if (ks.armed) return { kind: 'working', text: 'Locks as soon as all positions are closed' };
  return { kind: 'off' };
}

function view(s, label, compact, broker) {
  if (s.kind === 'na') return compact ? '' : html`<span class="muted small">Kill switch not available for this broker.</span>`;
  const on = s.kind !== 'off';
  return html`
    <button class="ks-ctl ${s.kind}" type="button" role="switch" aria-checked="${on}" ${s.kind === 'off' ? '' : 'disabled'}
      data-ks-go title="${s.kind === 'off' ? `Close all positions and lock ${label} for the day` : ''}">
      ${brokerMark(broker, label) ? html`<span class="ks-ico ks-brand" aria-hidden="true">${brokerMark(broker, label)}</span>` : html`<span class="ks-ico" aria-hidden="true">${icon('lock')}</span>`}
      <span class="ks-text"><b>${broker ? `${label} kill switch` : 'Kill switch'} <em>${s.kind === 'on' ? 'ON' : s.kind === 'working' ? 'ARMING' : 'OFF'}</em></b>
        <span>${s.kind === 'on' ? 'Locked until the next trading day' : s.kind === 'working' ? s.text : `Close all & lock ${label} for today`}</span></span>
      <span class="ks-toggle" aria-hidden="true"><i>${icon('lock')}</i></span>
    </button>`;
}

/** Confirmation dialog. Resolves { code } when confirmed, null when cancelled. */
function confirmDialog(label, needCode, positions) {
  return new Promise(resolve => {
    const box = document.createElement('div');
    box.className = 'ks-modal';
    box.innerHTML = String(html`
      <div class="panel pad ks-dialog" role="alertdialog" aria-modal="true" aria-labelledby="ks-title">
        <div class="ks-dialog-ico">${icon('lock')}</div>
        <h3 id="ks-title">Turn on the kill switch?</h3>
        <ul>
          <li>${positions ? `Close your ${positions} open position${positions === 1 ? '' : 's'} at market` : 'No open positions to close'}, and cancel pending orders.</li>
          <li>Lock your ${label} account. No trading for the rest of the day, not even in the ${label} app.</li>
          <li><b>This cannot be undone today.</b> Trading unlocks on the next trading day.</li>
        </ul>
        ${needCode ? html`<div class="field"><label for="ks-code">Authenticator code</label><input class="input num" id="ks-code" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></div>` : ''}
        <div class="row ks-dialog-btns">
          <button class="btn btn-ghost" data-ks-cancel>Cancel</button>
          <button class="btn btn-danger" data-ks-confirm ${needCode ? 'disabled' : ''}>${icon('lock')}Yes, close all and lock</button>
        </div>
      </div>`);
    document.body.append(box);
    const done = value => { box.remove(); document.removeEventListener('keydown', onKey); resolve(value); };
    const onKey = e => { if (e.key === 'Escape') done(null); };
    document.addEventListener('keydown', onKey);
    box.addEventListener('click', e => {
      if (e.target === box || e.target.closest('[data-ks-cancel]')) done(null);
      if (e.target.closest('[data-ks-confirm]')) done({ code: $('#ks-code', box)?.value.trim() });
    });
    const code = $('#ks-code', box);
    code?.addEventListener('input', () => { $('[data-ks-confirm]', box).disabled = !/^\d{6}$/.test(code.value.trim()); });
    (code || $('[data-ks-cancel]', box)).focus();
  });
}

/** Render the control into `el` and keep it up to date. */
export function mountKillSwitch(el, signal, { compact = false } = {}) {
  const paint = () => {
    const s = store.get();
    el.innerHTML = String(view(stateOf(s), s.dash?.broker?.label || 'broker', compact, s.dash?.broker?.broker));
  };
  paint();
  // The page may redraw and replace this element: then stop listening (no leak across redraws).
  const off = store.on(patch => {
    if (!el.isConnected) return off();
    if ('dash' in patch || 'emergency' in patch) paint();
  });
  signal.addEventListener('abort', off);

  el.addEventListener('click', async e => {
    if (!e.target.closest('[data-ks-go]')) return;
    const s = store.get();
    if (stateOf(s).kind !== 'off') return;
    const label = s.dash?.broker?.label || 'broker';
    const ask = s.user?.prefs?.emergencyConfirm !== false || s.user?.mfaEnabled;
    const ok = ask ? await confirmDialog(label, !!s.user?.mfaEnabled, s.dash?.positions?.length || 0) : { code: undefined };
    if (!ok) return;
    try {
      const { record } = await post('/emergency', { actions: ACTIONS, confirm: 'STOP', code: ok.code });
      store.set({ emergency: record });
      toast(`Kill switch on: closing positions, then locking ${label}.`, 'warn');
    } catch (err) { toastError(err); }
  }, { signal });
}
