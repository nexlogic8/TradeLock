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
