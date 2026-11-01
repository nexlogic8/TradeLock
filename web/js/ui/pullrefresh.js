// Pull to refresh (phones and the Android app) and the "reconnecting" spinner. Pull down from the top of
// a page: a refresh circle follows the finger; let go past the line to reload the page's data and the
// live connection. The same circle spins on its own while live updates reconnect.
import { store } from '../core/store.js';
import { show, currentRoute } from '../core/router.js';
import { startStream } from '../core/stream.js';
import { refreshUser } from '../core/session.js';
import { icon } from './icons.js';

const PULL = 72, MAX = 110;

export function initPullRefresh() {
  const el = document.createElement('div');
  el.id = 'ptr';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `<span class="ptr-circle">${icon('refresh')}</span>`;
  document.body.append(el);
  const circle = el.firstElementChild;

  let startY = null, dy = 0, busy = false;
  const set = (y, turn) => {
    el.style.transform = `translate(-50%, ${y}px)`;
    el.style.opacity = String(Math.min(1, y / 40));
    circle.style.transform = `rotate(${turn}deg)`;
  };
  const reset = () => { el.classList.remove('pull', 'spin'); el.style.transform = ''; el.style.opacity = ''; circle.style.transform = ''; };
  const blocked = () => document.querySelector('.ks-modal, .pdrawer.open, #pdrawer.open') || !document.querySelector('.app');

  window.addEventListener('touchstart', e => {
    if (busy || e.touches.length !== 1 || window.scrollY > 0 || blocked()) { startY = null; return; }
    startY = e.touches[0].clientY; dy = 0;
  }, { passive: true });
  window.addEventListener('touchmove', e => {
    if (startY == null) return;
    dy = e.touches[0].clientY - startY;
    if (dy <= 0 || window.scrollY > 0) { dy = 0; reset(); return; }
    const y = Math.min(MAX, dy * 0.5);
    el.classList.add('pull');
    el.classList.toggle('ready', y >= PULL);
    set(y, y * 4);
  }, { passive: true });
  window.addEventListener('touchend', async () => {
    if (startY == null) return;
    startY = null;
    if (Math.min(MAX, dy * 0.5) < PULL) { reset(); return; }
    busy = true;
    el.classList.remove('ready');
    el.classList.add('spin');
    set(PULL, 0);
    try {
      startStream();
      await refreshUser().catch(() => {});
      await show(currentRoute());
    } finally {
      busy = false;
      reset();
      sync();
    }
  });

  // Reconnecting: spin the circle in place (after a moment, so short blips don't flash it).
  let timer = null;
  const sync = () => {
    if (store.get().live !== false) {   // connected (or signed out): hide
      clearTimeout(timer); timer = null;
      if (!busy) el.classList.remove('reconnect');
      return;
    }
    // Still failing: keep the first timer (repeated errors must not keep postponing the spinner).
    timer ??= setTimeout(() => { timer = null; if (store.get().live === false && !busy) el.classList.add('reconnect'); }, 1500);
  };
  store.on(patch => { if ('live' in patch) sync(); });
}
