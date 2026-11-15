package com.nexlogic.tradelock.alarm;

import com.nexlogic.tradelock.BuildConfig;
import com.nexlogic.tradelock.MainActivity;
import com.nexlogic.tradelock.R;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

import java.util.Calendar;
import java.util.TimeZone;

/**
 * When the trade alarm needs to watch: a trading day from LEAD before the open to LEAD after the close. The server
 * sends the day's session with every poll (holidays included); without a fresh one (first start, no network) the
 * phone falls back to weekdays 09:15–15:30 IST and learns about a holiday from its first poll that morning.
 * Outside the window the service stops completely (no notification, polling or wake lock) and one alarm starts it
 * again at the next session.
 */
final class MarketSession {
  static final long LEAD_MS = 5 * 60_000L;
  private static final TimeZone IST = TimeZone.getTimeZone("Asia/Kolkata");
  private static final int OPEN_MIN = 9 * 60 + 15, CLOSE_MIN = 15 * 60 + 30;

  private MarketSession() { }

  private static SharedPreferences prefs(Context c) { return c.getSharedPreferences(TradeAlertService.PREFS, Context.MODE_PRIVATE); }

  /** Today's IST date, yyyy-MM-dd. */
  static String today(long now) {
    Calendar k = Calendar.getInstance(IST);
    k.setTimeInMillis(now);
    return String.format(java.util.Locale.US, "%04d-%02d-%02d", k.get(Calendar.YEAR), k.get(Calendar.MONTH) + 1, k.get(Calendar.DAY_OF_MONTH));
  }

  /** Store the server's session for today (from /api/algo/entries). */
  static void save(Context c, JSONObject s, boolean algoOn) {
    if (s == null) return;
    prefs(c).edit().putString("sDay", s.optString("day", "")).putBoolean("sTrading", s.optBoolean("tradingDay", true))
        .putLong("sOpen", s.optLong("openAt", 0)).putLong("sClose", s.optLong("closeAt", 0)).putLong("sNext", s.optLong("nextOpenAt", 0))
        .putString("sClosed", s.isNull("closed") ? "" : s.optString("closed", "")).putBoolean("algoOn", algoOn).apply();
  }

  static boolean algoOn(Context c) { return prefs(c).getBoolean("algoOn", true); }

  /** Why today has no session ("Saturday", a holiday) per the server, or "" when it trades / is unknown. */
  static String closedReason(Context c, long now) {
    SharedPreferences p = prefs(c);
    return today(now).equals(p.getString("sDay", "")) ? p.getString("sClosed", "") : "";
  }

  /** True while TradeLock should watch for entries. */
  static boolean inWindow(Context c, long now) {
    SharedPreferences p = prefs(c);
    if (today(now).equals(p.getString("sDay", ""))) {
      if (!p.getBoolean("sTrading", true)) return false;
      long open = p.getLong("sOpen", 0), close = p.getLong("sClose", 0);
      if (open > 0 && close > 0) return now >= open - LEAD_MS && now <= close + LEAD_MS;
    }
    Calendar k = Calendar.getInstance(IST);
    k.setTimeInMillis(now);
    int day = k.get(Calendar.DAY_OF_WEEK), m = k.get(Calendar.HOUR_OF_DAY) * 60 + k.get(Calendar.MINUTE);
    return day != Calendar.SATURDAY && day != Calendar.SUNDAY && m >= OPEN_MIN - 5 && m <= CLOSE_MIN + 5;
  }

  /** When to start watching next (LEAD before the next session's open), after `now`. */
  static long nextStart(Context c, long now) {
    SharedPreferences p = prefs(c);
    long next = p.getLong("sNext", 0);
    // The server's next open, if it is still ahead and we are not inside today's window already past it.
    if (next - LEAD_MS > now && next - now < 6 * 24 * 60 * 60_000L) return next - LEAD_MS;
    Calendar k = Calendar.getInstance(IST);
    k.setTimeInMillis(now);
    k.set(Calendar.HOUR_OF_DAY, 9); k.set(Calendar.MINUTE, 10); k.set(Calendar.SECOND, 0); k.set(Calendar.MILLISECOND, 0);
    while (k.getTimeInMillis() <= now || k.get(Calendar.DAY_OF_WEEK) == Calendar.SATURDAY || k.get(Calendar.DAY_OF_WEEK) == Calendar.SUNDAY) {
      k.add(Calendar.DAY_OF_MONTH, 1);
    }
    return k.getTimeInMillis();
  }
}
