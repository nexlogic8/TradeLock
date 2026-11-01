// Shared view fragments.
import { html } from '../core/dom.js';
import { ago } from '../core/format.js';
import { icon } from './icons.js';

export const pill = (text, tone = '', { dot = false, pulse = false, sm = false } = {}) =>
  html`<span class="pill ${tone} ${sm ? 'sm' : ''}">${dot ? html`<span class="dot ${pulse ? 'pulse' : ''}"></span>` : ''}${text}</span>`;

export const meter = (fraction, tone = '') =>
  html`<div class="meter ${tone}"><i style="width:${Math.round(Math.max(0, Math.min(1, fraction)) * 1000) / 10}%"></i></div>`;

export const empty = (ic, title, body, action) => html`
  <div class="empty">
    <div class="ico">${icon(ic)}</div>
    <h3>${title}</h3>
    <p>${body}</p>
    ${action ? html`<a class="btn btn-primary" href="/${action[0]}">${action[1]}</a>` : ''}
  </div>`;

export const errorView = e => html`
  <div class="panel pad">${empty('alert', 'This page could not load', e?.message || 'Unexpected error', null)}
    <div class="row" style="justify-content:center"><button class="btn" data-reload>Reload</button></div>
  </div>`;

/**
 * Can TradeLock place orders (exits, square-off) on this broker account right now?
 * From the broker's own answer (Dhan /ip/getIP, re-checked every 15 min): 'allowed' | 'blocked' | 'checking'.
 */
export function orderPermission(broker) {
  if (!broker) return { state: 'none' };
  const p = broker.permissions;
  if (broker.broker === 'mock' || broker.capabilities?.squareOff === 'available' || p?.ordersAllowed === true) return { state: 'allowed' };
  if (p?.ordersAllowed === false) return { state: 'blocked', serverIp: p.serverIp || '34.93.19.54' };
  return { state: 'checking' };
}

// Broker logos (served from /icons/brokers). Unknown brokers get their initials.
const BROKER_LOGOS = { dhan: 'dhan.svg', zerodha: 'zerodha.svg', upstox: 'upstox.png', angelone: 'angelone.png', stoxkart: 'stoxkart.png' };
export const brokerLogo = (id, name, { off = false } = {}) => (BROKER_LOGOS[id]
  ? html`<span class="b-logo img"><img src="/icons/brokers/${BROKER_LOGOS[id]}" alt="${name}" width="32" height="32"></span>`
  : html`<span class="b-logo ${off ? 'off' : ''}">${name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase()}</span>`);

/** Small inline broker logo (chips, card titles); nothing for brokers without one. */
export const brokerMark = (id, name) => (BROKER_LOGOS[id]
  ? html`<img class="b-mark" src="/icons/brokers/${BROKER_LOGOS[id]}" alt="${name}" width="18" height="18">` : '');

/** Profile picture (Google photo / Gravatar) over the initials; a broken image just disappears. */
export const avatar = (u, cls = '') => html`<span class="avatar ${cls}">${u?.initials || ''}${u?.avatar ? html`<img class="av-img" src="${u.avatar}" alt="" referrerpolicy="no-referrer" loading="lazy">` : ''}</span>`;
// Images that fail to load (no Gravatar for this email, offline...) are removed so the initials show.
document.addEventListener('error', e => { if (e.target?.classList?.contains('av-img')) e.target.remove(); }, true);

export const formError = msg => (msg ? html`<div class="form-error" role="alert">${icon('alert')}<span>${msg}</span></div>` : '');

/**
 * How healthy is protection right now? Drives the status chip, sidebar card and banner.
 * Principle: anything short of fresh broker data must not look like active protection.
 */
/** Live status + the banner to show. A plan that is not active outranks the broker banners. */
export function statusOf(state) {
  const st = brokerStatus(state);
  const sub = state.user?.subscription;
  if (sub && !sub.active) {
    st.banner = sub.trialBlocked
      ? { tone: 'amber', title: `Free trial not available: ${sub.trialBlocked.toLowerCase()}.`, action: ['billing', 'Subscribe'] }
      : { tone: 'amber', title: sub.status === 'trial' ? 'Your free trial has ended.' : 'Your TradeLock Pro plan has ended.', action: ['billing', 'Subscribe'] };
  }
  return st;
}

function brokerStatus({ dash, live }) {
  if (!dash) return { tone: 'idle', label: 'Connecting…', chip: 'connecting', pill: 'Connecting', detail: 'Waiting for the first sync.', protecting: false };
  const b = dash.broker;
  if (!b) {
    return {
      tone: 'idle', label: 'No broker connected', chip: 'no broker', pill: 'No broker', detail: 'Connect a broker to start monitoring.', protecting: false,
      banner: { tone: 'info', title: 'No broker connected.', body: 'Risk rules are not being checked. Connect your broker to start monitoring.', action: ['brokers', 'Connect broker'] },
    };
  }
  if (live === false) {
    return {
      tone: 'warn', label: 'Reconnecting…', chip: 'offline', pill: 'Reconnecting', detail: 'Reconnecting to TradeLock…', protecting: false,
    };
  }
  if (b.agentOn === false) {
    return {
      tone: 'idle', label: 'Agent stopped', chip: 'agent stopped', pill: 'Agent stopped', detail: 'Not monitoring. Start the agent to protect your account.', protecting: false,
      banner: { tone: 'amber', title: 'The TradeLock agent is stopped.', body: `Your ${b.label} account is not being monitored: rules, alerts and the kill switch are off.`, agentStart: true },
    };
  }
  const delayed = {
    tone: 'warn', protecting: false, pill: 'Data delayed',
    banner: {
      tone: 'amber', title: `${b.label} data is delayed (last sync ${ago(b.lastSyncAt)}).`,
      body: 'Risk rules cannot be checked against current positions until sync recovers. Do not rely on automatic protection right now.',
    },
  };
  switch (b.status) {
    case 'connected':
      if (!dash.marketOpen && b.broker !== 'mock') {
        return { tone: 'idle', label: 'Market closed', chip: 'market closed', pill: 'Market closed', detail: b.lastSyncAt ? `Refreshed ${ago(b.lastSyncAt)} · rules resume 09:15 IST` : 'Rules resume at 09:15 IST.', protecting: false };
      }
      return { tone: 'ok', label: 'Monitoring active', chip: 'connected', pill: 'Active', detail: `${b.label} synced ${ago(b.lastSyncAt)}`, protecting: true };
    case 'delayed':
      return { ...delayed, label: 'Sync delayed', chip: 'sync delayed', detail: `Last ${b.label} sync ${ago(b.lastSyncAt)}` };
    case 'degraded':
      return { ...delayed, label: 'Monitoring degraded', chip: 'degraded', detail: `Last ${b.label} sync ${ago(b.lastSyncAt)}` };
    case 'expired':
      return {
        tone: 'bad', label: 'Broker session expired', chip: 'session expired', pill: 'Expired', detail: 'Reconnect to resume monitoring.', protecting: false,
        banner: { tone: 'red', title: `Your ${b.label} session has expired.`, body: 'TradeLock cannot see your positions or act on your rules until you reconnect.', action: ['brokers', 'Reconnect'] },
      };
    default:
      return { tone: 'idle', label: b.status, chip: b.status, detail: '', protecting: false };
  }
}

export const toneColor = tone => ({ ok: 'var(--mint)', warn: 'var(--amber)', bad: 'var(--red)' }[tone] || 'var(--muted)');
export const toneClass = tone => ({ ok: '', warn: 'amber', bad: 'red' }[tone] ?? 'grey');
