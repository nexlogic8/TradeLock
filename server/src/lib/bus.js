// In-process event bus: userId -> that user's open live connections (SSE tabs).
// Delivery is a direct lookup, so cost does not grow with the number of connected users.
const listeners = new Map();

export function emit(userId, type, data) {
  const set = listeners.get(userId);
  if (set) for (const fn of set) fn(type, data);
}

/** True when the user has a live screen open (skip building pushes nobody will see). */
export const hasListeners = userId => listeners.has(userId);

export function subscribe(userId, fn) {
  let set = listeners.get(userId);
  if (!set) listeners.set(userId, (set = new Set()));
  set.add(fn);
  return () => {
    set.delete(fn);
    if (!set.size && listeners.get(userId) === set) listeners.delete(userId);
  };
}
