// Scope entries to an adapter (account + token). Reconnection gets a new cache.
// Short, hard TTLs: failures and expired snapshots are never served as fresh data.
export function createMarketCache({ now = Date.now, maxEntries = 80 } = {}) {
  const scopes = new WeakMap();
  return async function cached(scope, key, ttl, load, { fresh = false } = {}) {
    let entries = scopes.get(scope);
    if (!entries) { entries = new Map(); scopes.set(scope, entries); }
    const previous = entries.get(key);
    if (previous?.pending) return previous.pending;
    if (!fresh && previous?.result && now() - previous.result.asOf < ttl) {
      entries.delete(key); entries.set(key, previous);
      return { ...previous.result, cached: true };
    }
    const entry = {};
    const pending = Promise.resolve().then(load).then(value => {
      const result = { value, asOf: now(), cached: false };
      entry.result = result;
      return result;
    }).catch(error => {
      if (entries.get(key) === entry) entries.delete(key);
      throw error;
    }).finally(() => { delete entry.pending; });
    entry.pending = pending;
    entries.delete(key); entries.set(key, entry);
    for (const [oldKey, oldEntry] of entries) {
      if (entries.size <= maxEntries) break;
      if (!oldEntry.pending) entries.delete(oldKey);
    }
    // A burst can consist entirely of pending requests; trim when they finish too.
    pending.finally(() => {
      for (const [oldKey, oldEntry] of entries) {
        if (entries.size <= maxEntries) break;
        if (!oldEntry.pending) entries.delete(oldKey);
      }
    }).catch(() => {});
    return pending;
  };
}

export const cachedMarketData = createMarketCache();
