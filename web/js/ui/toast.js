import { html } from '../core/dom.js';
import { icon } from './icons.js';

/** tone: 'ok' | 'warn' | 'error' */
export function toast(message, tone = 'ok') {
  const box = document.getElementById('toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = `toast ${tone}`;
  el.innerHTML = String(html`${icon(tone === 'ok' ? 'check' : 'alert')}<span>${message}</span>`);
  box.append(el);
  while (box.children.length > 3) box.firstElementChild.remove();
  setTimeout(() => el.remove(), tone === 'error' ? 5000 : 3200);
}

export const toastError = e => toast(e?.message || 'Something went wrong', 'error');
