package in.tradelock.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/**
 * Keeps the trade alarm alive, during market hours only. Samsung's "Active apps → Stop / Close all" stops the
 * watch service and Android does not restart a service stopped that way. During the session this wakes every
 * few minutes (also in Doze) and starts the service again (a no-op when it is running). Outside it, a single
 * exact alarm fires 5 minutes before the next session (MarketSession: weekends and NSE holidays skipped), so a
 * closed market costs no battery. Allowed from the background: exact alarm, and TradeLock is exempt from
 * battery optimisation.
 */
public class WatchdogReceiver extends BroadcastReceiver {
  private static final long EVERY_MS = 3 * 60_000L;

  static void schedule(Context c) {
    AlarmManager am = c.getSystemService(AlarmManager.class);
    if (am == null) return;
    PendingIntent pi = PendingIntent.getBroadcast(c, 9, new Intent(c, WatchdogReceiver.class),
        PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    long now = System.currentTimeMillis();
    boolean session = MarketSession.inWindow(c, now);
    long at = session ? now + EVERY_MS : MarketSession.nextStart(c, now);
    // The next session's start must not slip in Doze: exact when the phone allows it, else the closest inexact.
    if (!session && (Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms())) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
    else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
  }

  static void cancel(Context c) {
    AlarmManager am = c.getSystemService(AlarmManager.class);
    if (am == null) return;
    am.cancel(PendingIntent.getBroadcast(c, 9, new Intent(c, WatchdogReceiver.class),
        PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
  }

  @Override
  public void onReceive(Context c, Intent i) {
    if (!TradeAlertService.enabled(c)) return;
    try { TradeAlertService.start(c); }              // starts it in the session; schedules the next tick either way
    catch (Exception e) { schedule(c); }             // tried again on the next tick
  }
}
