import { config } from '../config.js';
import { SPECIAL_SESSIONS } from './market-calendar.js';

// IST is a fixed UTC+05:30 (no daylight saving), so plain arithmetic is exact and far cheaper than
// Intl formatting. This runs thousands of times per monitor cycle.
const IST_OFFSET_MS = 330 * 60e3;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Exchange-local (IST) clock: trading day, minutes since midnight, weekday. */
let lastSec = NaN, last = null;   // the monitor asks for "now" thousands of times per second

export function ist(at = Date.now()) {
  const sec = Math.floor(at / 1000);
  if (sec === lastSec) return last;
  const d = new Date(at + IST_OFFSET_MS);
  const hour = d.getUTCHours(), minute = d.getUTCMinutes();
  lastSec = sec;
  last = Object.freeze({
    day: d.toISOString().slice(0, 10),
    minutes: hour * 60 + minute,
    hhmm: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    weekday: WEEKDAYS[d.getUTCDay()],
  });
  return last;
}

export const toMinutes = hhmm => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

// Regular weekday session. Exchange holidays are not modelled here yet (see README). The algo strategies use these.
export function regularMarketOpen(at = Date.now()) {
  const n = ist(at);
  return !['Sat', 'Sun'].includes(n.weekday) && n.minutes >= config.market.open && n.minutes < config.market.close;
}
export const regularTradingDay = (at = Date.now()) => !['Sat', 'Sun'].includes(ist(at).weekday);

// Also open in a special session (Diwali Muhurat trading on a weekend): risk protection, P&L and the dashboard.
export function marketOpen(at = Date.now()) {
  const n = ist(at), sp = SPECIAL_SESSIONS[n.day];
  return sp ? n.minutes >= sp.open && n.minutes < sp.close : regularMarketOpen(at);
}
export const isTradingDay = (at = Date.now()) => !!SPECIAL_SESSIONS[ist(at).day] || regularTradingDay(at);

export function nextTradingDay(day) {
  const d = new Date(`${day}T00:00:00Z`);
  do d.setUTCDate(d.getUTCDate() + 1); while ([0, 6].includes(d.getUTCDay()));
  return d.toISOString().slice(0, 10);
}

export function previousTradingDays(day, count) {
  const out = [];
  const d = new Date(`${day}T00:00:00Z`);
  while (out.length < count) {
    d.setUTCDate(d.getUTCDate() - 1);
    if (![0, 6].includes(d.getUTCDay())) out.unshift(d.toISOString().slice(0, 10));
  }
  return out;
}
