// Latest tick and 1-minute candles per instrument, built from the Dhan live feed (live.js) for Algo Trading.
// Minutes follow the server's receive time (Dhan's last-trade time has 1-second resolution and is not always
// sent for indices). A minute counts as complete only when the feed was up for all of it: connected before
// it started, no drop since, and the minute is over; otherwise callers fall back to Dhan's REST candles.
const MINUTE = 60_000, KEEP_MINUTES = 400;

export function createTickBook() {
  const last = new Map(), bars = new Map();
  let upSince = null;   // the feed has been connected (no drop) since this time
  return {
    /** The upstream feed connected (time) or dropped (null). */
    connected(at) { upSince = at; },
    get upSince() { return upSince; },
    /** One decoded tick; returns the minute that just closed for this key, if this tick started a new one. */
    add(key, tick) {
      const at = tick.at || Date.now();
      last.set(key, { ...tick, at });
      const m = Math.floor(at / MINUTE) * MINUTE, series = bars.get(key) || new Map();
      if (!bars.has(key)) bars.set(key, series);
      const bar = series.get(m), px = tick.ltp;
      let closed = null;
      if (!bar) {
        if (series.size) closed = Math.max(...series.keys());
        series.set(m, { time: m, open: px, high: px, low: px, close: px, ticks: 1, firstAt: at, lastAt: at });
        if (series.size > KEEP_MINUTES) series.delete(Math.min(...series.keys()));
      } else {
        bar.high = Math.max(bar.high, px); bar.low = Math.min(bar.low, px); bar.close = px; bar.ticks++; bar.lastAt = at;
      }
      return closed != null && closed < m ? closed : null;
    },
    /** Latest tick for key received at or after `since` (ms), else null. */
    tick(key, { since = 0 } = {}) {
      const t = last.get(key);
      return t && t.at >= since ? t : null;
    },
    /** The completed 1-minute candle starting at `minute` (ms) for key, or null when it may be partial. */
    minute(key, minute, now = Date.now()) {
      const bar = bars.get(key)?.get(minute);
      if (!bar || now < minute + MINUTE || upSince == null || upSince > minute) return null;
      return bar;
    },
    clear() { last.clear(); bars.clear(); upSince = null; },
  };
}
