// TradeLock's own confirm / notice dialog, instead of the browser's confirm() (a plain system box in the
// Android app). A centred card on computers, a bottom sheet on phones; Esc, a tap outside and the phone's
// back button close it as "cancel".
import { html } from '../core/dom.js';
import { icon } from './icons.js';

let closeOpen = null;

/**
 * Ask and wait: resolves true for the main button, false otherwise.
 * opts: title, body (one line), points (list), confirm / cancel labels, tone 'ok' | 'warn' | 'danger',
 *       ic (icon name), notice (only one button: an explanation, nothing to choose).
 */
export function confirmDialog({ title, body = '', points = [], confirm = 'OK', cancel = 'Cancel', tone = 'ok', ic = 'alert', notice = false } = {}) {
  closeOpen?.(false);
  return new Promise(resolve => {
    const box = document.createElement('div');
    box.className = 'tl-modal';
    const main = tone === 'danger' ? 'btn-danger' : tone === 'warn' ? 'btn-amber' : 'btn-primary';
    box.innerHTML = String(html`
      <div class="tl-dialog tone-${tone}" role="alertdialog" aria-modal="true" aria-labelledby="tl-d-title" aria-describedby="tl-d-body">
        <span class="tl-grab" aria-hidden="true"></span>
        <div class="tl-d-ico">${icon(ic)}</div>
        <h3 id="tl-d-title">${title}</h3>
        <div class="tl-d-body" id="tl-d-body">${body ? html`<p>${body}</p>` : ''}${points.length ? html`<ul>${points.map(p => html`<li>${p}</li>`)}</ul>` : ''}</div>
        <div class="tl-d-btns">
          ${notice ? '' : html`<button type="button" class="btn btn-ghost" data-d="0">${cancel}</button>`}
          <button type="button" class="btn ${main}" data-d="1">${confirm}</button>
        </div>
      </div>`);
    document.body.append(box);
    requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add('in')));
    // A history step, so the phone's back button closes the dialog instead of leaving the page.
    history.pushState({ tlDialog: 1 }, '');
    let done = false;
    const close = (value, fromHistory = false) => {
      if (done) return;
      done = true; closeOpen = null;
      window.removeEventListener('popstate', onPop);
      document.removeEventListener('keydown', onKey, true);
      if (!fromHistory && history.state?.tlDialog) history.back();
      box.classList.remove('in'); box.classList.add('out');
      setTimeout(() => box.remove(), 220);
      resolve(value);
    };
    const onPop = () => close(false, true);
    const onKey = e => { if (e.key === 'Escape') { e.stopImmediatePropagation(); close(false); } };
    window.addEventListener('popstate', onPop);
    document.addEventListener('keydown', onKey, true);
    box.addEventListener('click', e => {
      const b = e.target.closest('[data-d]');
      if (b) close(b.dataset.d === '1');
      else if (e.target === box) close(false);
    });
    closeOpen = close;
    box.querySelector('[data-d="1"]')?.focus({ preventScroll: true });
  });
}

/** An explanation with a single button. */
export const noticeDialog = opts => confirmDialog({ confirm: 'OK', ...opts, notice: true });

/** Before Algo Trading goes live: what it will do with real money. */
export const confirmAlgoStart = () => confirmDialog({
  ic: 'spark', tone: 'warn', title: 'Start Algo Trading?', confirm: 'Start Algo Trading', cancel: 'Not now',
  body: 'TradeLock will place LIVE orders on your Dhan account for every signal of the strategies that are on.',
  points: [
    html`Buys the <b>ATM option of the next expiry</b> on the indices you ticked.`,
    html`Sized so the stop-loss risks the <b>day's stop-loss still left</b>, with a stop-loss order at Dhan.`,
    html`Exits on that stop-loss, 2 closes against EMA 9, your exit, or the cutoff. <b>All your risk rules still apply.</b>`,
  ],
});

