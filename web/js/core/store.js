// One shared state object. Subscribers receive the patch so they can ignore unrelated changes.
const state = {
  user: null,       // signed-in user (from /auth/me)
  meta: null,       // public server info (plan, brokers, demo creds in dev)
  dash: null,       // live dashboard snapshot pushed over SSE
  emergency: null,  // latest emergency action record
  unread: 0,
  wallet: null,     // TradeLock wallet balances in paise { funds, earnings, total, pendingWithdrawals }
  live: null,       // SSE connection state: null (not started) | true | false
};
const subs = new Set();

export const store = {
  get: () => state,
  set(patch) {
    Object.assign(state, patch);
    for (const fn of subs) fn(patch, state);
  },
  on(fn) {
    subs.add(fn);
    return () => subs.delete(fn);
  },
};
