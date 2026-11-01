// Theme preference: 'dark' (default), 'light' or 'system'. Stored per browser.
import { store } from './store.js';

const KEY = 'tl-theme';
const media = window.matchMedia('(prefers-color-scheme: light)');

export function themePref() {
  try { return localStorage.getItem(KEY) || 'dark'; } catch { return 'dark'; }
}

export const resolvedTheme = (pref = themePref()) => (pref === 'system' ? (media.matches ? 'light' : 'dark') : pref);

function apply() {
  const theme = resolvedTheme();
  document.documentElement.setAttribute('data-theme', theme);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#F3F6FA' : '#05090F');
  store.set({ theme });
  window.dispatchEvent(new Event('resize')); // charts read colours from CSS tokens: redraw them
}

export function setThemePref(pref) {
  try { localStorage.setItem(KEY, pref); } catch { /* storage blocked: still applies for this visit */ }
  apply();
}

media.addEventListener('change', () => { if (themePref() === 'system') apply(); });
apply();
