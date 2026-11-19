// Latest positions/orders per user from the most recent successful broker sync (memory only).
const EMPTY = Object.freeze({ positions: [], orders: [], funds: null, at: null });
const books = new Map();

export const getBook = userId => books.get(userId) || EMPTY;
export const setBook = (userId, book) => books.set(userId, book);
export const clearBook = userId => books.delete(userId);

// Kill switch status as the broker reports it (it can be switched in the broker's own app).
const killSwitch = new Map();
export const getKillStatus = userId => killSwitch.get(userId) || null;
export const setKillStatus = (userId, status) => {
  if (killSwitch.get(userId)?.active !== status.active) markDirty(userId);
  killSwitch.set(userId, status);
};
// Real ↔ Paper (or Dhan ↔ StoxKart): the reading belonged to the broker traded before; the next sync reads the new one.
export const clearKillStatus = userId => { if (killSwitch.delete(userId)) markDirty(userId); };
/**
 * Is the trading broker locked? Its own reading wins (Paper's day lock, or Dhan's switch); TradeLock's record of a lock
 * today (`ks_active_at`) counts only while that reading is unknown. Returns the lock's label ('Paper', 'Dhan', ...) or null.
 */
export function killSwitchLock(userId, s) {
  const k = killSwitch.get(userId);
  return k?.active === true || (k?.active !== false && !!s?.ks_active_at) ? k?.label || 'broker' : null;
}

// Broker-side permissions (static IP for orders, token validity), refreshed every few minutes.
const permissions = new Map();
export const getPermissions = userId => permissions.get(userId) || null;
export const setPermissions = (userId, p) => {
  const prev = permissions.get(userId);
  if (prev?.ordersAllowed !== p.ordersAllowed || prev?.tokenValidUntil !== p.tokenValidUntil) markDirty(userId);
  permissions.set(userId, p);
};

// Users whose dashboard changed outside the broker sync (rules saved, day state written, kill switch...).
// The monitor sends them a full dashboard on their next sync instead of a "synced" ping.
const dirty = new Set();
export const markDirty = userId => dirty.add(userId);
export const takeDirty = userId => dirty.delete(userId);
