// Small view helpers shared by the admin pages.
import { html } from '/js/core/dom.js';
import { pill } from '/js/ui/parts.js';

export const kpi = (label, value, foot = '', tone = '') => html`
  <div class="panel kpi"><div class="lbl">${label}</div><div class="val ${tone}">${value}</div><div class="foot">${foot}</div></div>`;

export const kv = (label, value, note = '') => html`<div class="adm-kv"><span>${label}</span><b class="num">${value}</b>${note ? html`<span class="dim">${note}</span>` : ''}</div>`;

export const gb = b => `${(b / 1e9).toFixed(1)} GB`;
export const mb = b => `${Math.round(b / 1e6)} MB`;
export const span = s => (s >= 86400 ? `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`
  : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.max(0, Math.floor(s / 60))}m`);

const BROKER = { connected: '', live: '', delayed: 'amber', degraded: 'red', expired: 'red' };
export const brokerPill = (broker, status) => pill(`${broker} · ${status}`, BROKER[status] ?? 'grey', { sm: true, dot: true });

export function subPill(status, trialEndsAt, periodEnd) {
  if (!status) return '–';
  if (status === 'trial' && trialEndsAt < Date.now()) return pill('Trial ended', 'red', { sm: true });
  if (status === 'active' && periodEnd && periodEnd < Date.now()) return pill('Lapsed', 'red', { sm: true });
  return pill(status === 'active' ? 'Pro' : status, { active: '', trial: 'ice' }[status] ?? 'grey', { sm: true });
}

export const levelPill = level => pill(level === 'critical' ? 'Critical' : 'Warning', level === 'critical' ? 'red' : 'amber', { sm: true, dot: true, pulse: level === 'critical' });

export const searchBox = (id, value, placeholder) =>
  html`<input class="input adm-search" id="${id}" type="search" placeholder="${placeholder}" value="${value || ''}" aria-label="${placeholder}">`;

/** Debounced search input that reloads the page and keeps the cursor in the box. */
export function bindSearch(ctx, id) {
  let t;
  ctx.el.addEventListener('input', e => {
    if (e.target.id !== id) return;
    clearTimeout(t);
    t = setTimeout(async () => {
      ctx.ui.q = e.target.value;
      await ctx.reload();
      const box = ctx.el.querySelector(`#${id}`);
      box?.focus();
      box?.setSelectionRange(box.value.length, box.value.length);
    }, 250);
  }, { signal: ctx.signal });
}
