// NSE equity / F&O trading calendar: weekends plus the exchange's weekday trading holidays, and today's session.
// Used by the Android app to sleep outside market hours (GET /api/algo/entries → session).
// 2025-10 … 2026-10 checked against the stored NIFTY 1-minute history (weekdays with no candles); the rest of
// 2026 from NSE's published list. Add the next year's dates when NSE publishes them (each December): until then
// days after the last listed year count weekends only.
import { config } from '../config.js';

export const NSE_HOLIDAYS = Object.freeze({
  '2025-11-05': 'Guru Nanak Jayanti', '2025-12-25': 'Christmas',
  '2026-01-15': 'Maharashtra municipal elections', '2026-01-26': 'Republic Day', '2026-03-03': 'Holi', '2026-03-26': 'Ram Navami',
  '2026-03-31': 'Mahavir Jayanti', '2026-04-03': 'Good Friday', '2026-04-14': 'Ambedkar Jayanti', '2026-05-01': 'Maharashtra Day',
  '2026-05-28': 'Bakri Id', '2026-06-26': 'Muharram', '2026-09-14': 'Ganesh Chaturthi', '2026-10-02': 'Gandhi Jayanti',
  '2026-10-20': 'Dussehra', '2026-11-10': 'Diwali Balipratipada', '2026-11-24': 'Guru Nanak Jayanti', '2026-12-25': 'Christmas',
});

// Special sessions on a non-trading day (Diwali Muhurat trading): open / close in IST minutes. Risk protection runs in
// them; the algo strategies do not (they keep the regular weekday clock). Add each year's from NSE's circular.
export const SPECIAL_SESSIONS = Object.freeze({
  '2026-11-08': Object.freeze({ name: 'Muhurat trading', open: 14 * 60 + 15, close: 15 * 60 + 30 }),
});

const IST_MS = 330 * 60_000;
const istDay = at => new Date(at + IST_MS).toISOString().slice(0, 10);
const weekend = day => [0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay());
const at = (day, minutes) => Date.parse(`${day}T00:00:00Z`) - IST_MS + minutes * 60_000;
const addDay = day => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

/** Why `day` has no session ('Saturday', a holiday name), or null on a trading day. */
export function closedReason(day) {
  if (SPECIAL_SESSIONS[day]) return null;
  if (weekend(day)) return new Date(`${day}T00:00:00Z`).getUTCDay() === 0 ? 'Sunday' : 'Saturday';
  return NSE_HOLIDAYS[day] || null;
}
export const isMarketDay = day => !closedReason(day);

/**
 * Today's session and the next one, as epoch ms: { day, tradingDay, closed (reason or null), open (in session now),
 * openAt / closeAt (today's, null when closed), nextOpenAt (today's open if still ahead, else the next trading day's) }.
 */
export function sessionInfo(now = Date.now()) {
  const day = istDay(now), closed = closedReason(day), { open, close } = SPECIAL_SESSIONS[day] ?? config.market;
  const openAt = closed ? null : at(day, open), closeAt = closed ? null : at(day, close);
  let next = day;
  if (closed || now >= openAt) { do next = addDay(next); while (!isMarketDay(next)); }
  return { day, tradingDay: !closed, closed, special: SPECIAL_SESSIONS[day]?.name ?? null, open: !closed && now >= openAt && now < closeAt, openAt, closeAt,
    nextOpenAt: at(next, next === day ? open : (SPECIAL_SESSIONS[next] ?? config.market).open), nextDay: next };
}
