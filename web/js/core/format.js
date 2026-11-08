const nf0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const IST = 'Asia/Kolkata';

/** ₹ amount with a true minus sign; `sign` adds + for gains. */
export function inr(v, { sign = false, dp = 0 } = {}) {
  if (v == null || Number.isNaN(v)) return '–';
  const n = (dp ? nf2 : nf0).format(Math.abs(v));
  const pre = v < 0 && Math.abs(v) >= (dp ? 0.005 : 0.5) ? '−' : sign && v > 0 ? '+' : '';
  return `${pre}₹${n}`;
}
/** Wallet amounts are integer paise. */
export const paise = (p, opts = {}) => inr(p / 100, { dp: 2, ...opts });
export const tone = v => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
export const pct = (x, dp = 0) => (x == null ? '–' : `${(x * 100).toFixed(dp)}%`);
export const price = v => (v == null ? '–' : nf2.format(v));
export const int = v => nf0.format(v);

/** Axis labels in Indian units: ₹2.5k, ₹1.2L. */
export function axisInr(v) {
  if (v === 0) return '0';
  const a = Math.abs(v);
  const s = a >= 1e5 ? `${+(a / 1e5).toFixed(1)}L` : a >= 1000 ? `${+(a / 1000).toFixed(1)}k` : String(a);
  return `${v < 0 ? '−' : ''}₹${s}`;
}

const tf = new Intl.DateTimeFormat('en-GB', { timeZone: IST, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const hm = new Intl.DateTimeFormat('en-GB', { timeZone: IST, hour: '2-digit', minute: '2-digit', hour12: false });
export const timeIST = ts => tf.format(ts);
export const hmIST = ts => hm.format(ts);
export const dateIST = (ts, opts = { day: '2-digit', month: 'short', year: 'numeric' }) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: IST, ...opts }).format(ts);
export const dayToTs = day => Date.parse(`${day}T12:00:00+05:30`);
export const longDay = day => dateIST(dayToTs(day), { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' });
export const shortDay = day => dateIST(dayToTs(day), { day: 'numeric', month: 'short' });

export function ago(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export function fmt12(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
export const duration = min => `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;

// Special sessions on a weekend (Diwali Muhurat trading), IST minutes: keep in step with server/src/lib/market-calendar.js.
const SPECIAL_SESSIONS = { '2026-11-08': [855, 930] };

/** Current IST minutes since midnight and whether NSE is in session (weekends + special sessions; no holiday calendar). */
export function istNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: IST, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false }).formatToParts(Date.now()).map(x => [x.type, x.value]));
  const minutes = (Number(p.hour) % 24) * 60 + Number(p.minute);
  const sp = SPECIAL_SESSIONS[`${p.year}-${p.month}-${p.day}`];
  const open = sp ? minutes >= sp[0] && minutes < sp[1] : !['Sat', 'Sun'].includes(p.weekday) && minutes >= 555 && minutes < 930;
  return { minutes, open, hhmm: `${String(Number(p.hour) % 24).padStart(2, '0')}:${p.minute}` };
}
