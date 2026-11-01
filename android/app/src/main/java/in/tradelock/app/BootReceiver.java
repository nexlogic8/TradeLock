package in.tradelock.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Restarts the trade alarm after a phone restart or an app update, if it was on. */
public class BootReceiver extends BroadcastReceiver {
  @Override
  public void onReceive(Context c, Intent i) {
    String a = String.valueOf(i.getAction());
    if ((Intent.ACTION_BOOT_COMPLETED.equals(a) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) && TradeAlertService.enabled(c)) {
      try { TradeAlertService.start(c); } catch (Exception ignored) { /* started again when the app opens */ }
    }
  }
}
