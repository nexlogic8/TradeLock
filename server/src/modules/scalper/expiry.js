const EXPIRY_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EXPIRY_CLOSE_MINUTES = 15 * 60 + 30;

export function activeNiftyExpiries(expiries, clock, close = EXPIRY_CLOSE_MINUTES) {
  const sameDayStillActive = !['Sat','Sun'].includes(clock.weekday) && clock.minutes < close;   // close: MCX trades to 23:55
  return [...new Set(Array.isArray(expiries) ? expiries : [])]
    .filter(expiry => typeof expiry === 'string' && EXPIRY_DATE.test(expiry)
      && (expiry > clock.day || (expiry === clock.day && sameDayStillActive)))
    .sort();
}

// Power Scalper's default expiry by IST weekday: Monday-Tuesday (and the weekend, ahead of Monday) the
// 2nd upcoming expiry, since the nearest one expires on Tuesday; Wednesday-Friday the current (nearest).
// After Tuesday's 15:30 close that expiry has left the list, so Tuesday evening counts as Wednesday.
export function defaultExpiryIndex(weekday, minutes = 0) {
  if (weekday === 'Tue' && minutes >= EXPIRY_CLOSE_MINUTES) return 0;
  return ['Mon', 'Tue', 'Sat', 'Sun'].includes(weekday) ? 1 : 0;
}

export function resolveNiftyExpiry(requested, expiries, clock, rule = 'weekday', close = EXPIRY_CLOSE_MINUTES) {
  // 'weekday' is the NIFTY rule above; other indices default to their nearest active expiry.
  if (!requested) return expiries[Math.min(rule === 'weekday' ? defaultExpiryIndex(clock.weekday, clock.minutes) : 0, expiries.length - 1)] || null;
  if (expiries.includes(requested)) return requested;
  const expired = typeof requested === 'string' && EXPIRY_DATE.test(requested)
    && (requested < clock.day || (requested === clock.day
      && (['Sat','Sun'].includes(clock.weekday) || clock.minutes >= close)));
  return expired ? expiries[0] || null : null;
}
