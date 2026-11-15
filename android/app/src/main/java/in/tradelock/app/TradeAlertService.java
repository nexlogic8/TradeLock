package in.tradelock.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.util.Log;
import android.webkit.CookieManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Trade alarm for Algo Trading. A foreground service (it keeps running with the app closed) asks
 * tradelock.in for new automatic entries every few seconds during market hours. Only then: outside the
 * session (nights, weekends, NSE holidays, from the server's calendar) it stops completely, with no
 * notification, polling or wake lock, and one alarm starts it 5 minutes before the next open (MarketSession). On a new entry it rings
 * like an alarm: looping alarm tone at full alarm volume and continuous vibration until Stop is pressed,
 * with a full-screen alert over the lock screen. The alarm audio stream plays in silent and vibrate mode;
 * with Do Not Disturb access it also switches DND off while ringing and restores it afterwards.
 */
public class TradeAlertService extends Service {
  static final String ACTION_START = "in.tradelock.app.ALERTS_START";
  static final String ACTION_STOP_SERVICE = "in.tradelock.app.ALERTS_STOP";
  static final String ACTION_RING = "in.tradelock.app.ALARM_RING";        // test alarm / ring now
  static final String ACTION_SILENCE = "in.tradelock.app.ALARM_SILENCE";  // Stop button
  static final String CH_WATCH = "trade_watch", CH_ALARM = "trade_alarm_v2";
  static final int ID_WATCH = 41, ID_ALARM = 42;
  static final String PREFS = "trade_alerts";

  private static final String TAG = "TradeAlerts";
  private static final long MARKET_POLL_MS = 4_000, IDLE_POLL_MS = 60_000;
  private static final long FRESH_MS = 10 * 60_000;   // never ring for an entry older than this

  private volatile Thread poller;
  private MediaPlayer player;
  private Vibrator vibrator;
  private PowerManager.WakeLock wake;
  private int savedAlarmVolume = -1, savedFilter = -1;

  static boolean enabled(Context c) { return c.getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("enabled", false); }

  static void start(Context c) {
    c.getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("enabled", true).apply();
    WatchdogReceiver.schedule(c);   // during the session: restarts the service if the phone stops it; else: wakes it at the next open
    if (!MarketSession.inWindow(c, System.currentTimeMillis())) {   // market closed: nothing runs until then
      // ...and no watch notification left over (e.g. from a service an app update ended without removing it).
      NotificationManager nm = c.getSystemService(NotificationManager.class);
      if (nm != null) nm.cancel(ID_WATCH);
      return;
    }
    Intent i = new Intent(c, TradeAlertService.class).setAction(ACTION_START);
    if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i);
  }

  static void stop(Context c) {
    c.getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("enabled", false).apply();
    WatchdogReceiver.cancel(c);
    c.startService(new Intent(c, TradeAlertService.class).setAction(ACTION_STOP_SERVICE));
  }

  static void channels(Context c) {
    if (Build.VERSION.SDK_INT < 26) return;
    NotificationManager nm = c.getSystemService(NotificationManager.class);
    NotificationChannel watch = new NotificationChannel(CH_WATCH, "Algo Trading watch", NotificationManager.IMPORTANCE_LOW);
    watch.setDescription("Shown while TradeLock watches for automatic trade entries.");
    watch.setShowBadge(false);
    nm.createNotificationChannel(watch);
    NotificationChannel alarm = new NotificationChannel(CH_ALARM, "Trade entry alarm", NotificationManager.IMPORTANCE_HIGH);
    alarm.setDescription("Rings and vibrates when Algo Trading enters a trade.");
    alarm.setSound(null, null);          // the service plays the alarm tone itself, on the alarm stream
    alarm.enableVibration(false);        // ...and vibrates itself, continuously
    alarm.setBypassDnd(true);            // takes effect once Do Not Disturb access is granted
    alarm.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
    nm.createNotificationChannel(alarm);
    nm.deleteNotificationChannel("trade_alarm_v1");   // created before DND access, so it could not bypass DND
  }

  /**
   * Android 15+: an app's setInterruptionFilter only drives the app's own "Do Not Disturb (TradeLock)"
   * rule, never the user's DND. Version 1.4.x left that rule on; switch it off. (No effect on the user's DND.)
   */
  static void clearOwnDndRule(Context c) {
    NotificationManager nm = c.getSystemService(NotificationManager.class);
    if (Build.VERSION.SDK_INT >= 35 && nm.isNotificationPolicyAccessGranted()) {
      try { nm.setInterruptionFilter(NotificationManager.INTERRUPTION_FILTER_ALL); } catch (Exception ignored) { }
    }
  }

  @Override public IBinder onBind(Intent intent) { return null; }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    channels(this);
    clearOwnDndRule(this);
    String action = intent == null ? ACTION_START : String.valueOf(intent.getAction());
    if (ACTION_STOP_SERVICE.equals(action)) { silence(); stopPolling(); stopForeground(true); stopSelf(); return START_NOT_STICKY; }
    goForeground("Watching for Algo Trading entries");
    if (ACTION_SILENCE.equals(action)) {
      silence();
      if (!enabled(this)) { stopForeground(true); stopSelf(); return START_NOT_STICKY; }   // a test alarm with alerts off
      startPolling();
      return START_STICKY;
    }
    if (ACTION_RING.equals(action)) {
      ring(intent.getStringExtra("title"), intent.getStringExtra("body"));
      return START_STICKY;
    }
    if (!enabled(this)) { stopForeground(true); stopSelf(); return START_NOT_STICKY; }
    startPolling();
    return START_STICKY;   // restarted by Android if it is killed
  }

  @Override public void onDestroy() { silence(); stopPolling(); super.onDestroy(); }

  private void goForeground(String text) {
    Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    Notification n = builder(CH_WATCH).setContentTitle("TradeLock Algo Trading").setContentText(text)
        .setSmallIcon(R.drawable.ic_stat_tradelock).setOngoing(true)
        .setContentIntent(PendingIntent.getActivity(this, 1, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT)).build();
    if (Build.VERSION.SDK_INT >= 34) startForeground(ID_WATCH, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
    else startForeground(ID_WATCH, n);
  }

  // TradeLock padlock in the status bar (ic_stat_tradelock), tinted mint in the notification shade.
  private Notification.Builder builder(String channel) {
    Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, channel) : new Notification.Builder(this);
    return b.setColor(0xFF23D3A3);
  }

  // ---- polling --------------------------------------------------------------------------------------

  private synchronized void startPolling() {
    if (poller != null && poller.isAlive()) return;
    poller = new Thread(this::pollLoop, "trade-alerts");
    poller.start();
  }

  private synchronized void stopPolling() {
    if (poller != null) poller.interrupt();
    poller = null;
    if (wake != null && wake.isHeld()) wake.release();
  }

  private void pollLoop() {
    PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
    wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "TradeLock:tradeAlerts");
    String lastStatus = "";
    while (!Thread.currentThread().isInterrupted()) {
      if (!MarketSession.inWindow(this, System.currentTimeMillis())) { sleepUntilNextSession(); return; }
      // Fast polls with the CPU kept awake only while Algo Trading is on; otherwise a slow check is enough
      // (it notices Algo Trading being switched on from another device within a minute).
      // Fast polls (CPU kept awake) while Algo Trading is on or a price alert waits.
      boolean algo = MarketSession.algoOn(this) || getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("alertsActive", false);
      if (algo && !wake.isHeld()) wake.acquire(7 * 60 * 60_000L);
      if (!algo && wake.isHeld()) wake.release();
      String status;
      try { status = checkOnce(); } catch (Exception e) { status = "Waiting for connection…"; Log.w(TAG, "poll failed", e); }
      // The first poll of a holiday (or any closed day) brings the server's calendar: stop right there.
      if (!MarketSession.inWindow(this, System.currentTimeMillis())) { sleepUntilNextSession(); return; }
      algo = MarketSession.algoOn(this) || getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("alertsActive", false);
      String text = (algo ? "Watching for entries · " : "Algo Trading is off · ") + status;
      if (!text.equals(lastStatus)) { lastStatus = text; updateWatch(text); }
      try { Thread.sleep(algo ? MARKET_POLL_MS : IDLE_POLL_MS); } catch (InterruptedException e) { break; }
    }
    if (wake.isHeld()) wake.release();
  }

  /** Market closed: stop completely (notification, polling, wake lock) until the alarm at the next session. */
  private void sleepUntilNextSession() {
    if (wake != null && wake.isHeld()) wake.release();
    long now = System.currentTimeMillis();
    String why = MarketSession.closedReason(this, now);
    Log.i(TAG, "market closed" + (why.isEmpty() ? "" : " (" + why + ")") + "; sleeping until " + new java.util.Date(MarketSession.nextStart(this, now)));
    WatchdogReceiver.schedule(this);
    synchronized (this) { poller = null; }
    stopForeground(true);
    stopSelf();
  }

  private void updateWatch(String text) {
    NotificationManager nm = getSystemService(NotificationManager.class);
    Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    nm.notify(ID_WATCH, builder(CH_WATCH).setContentTitle("TradeLock Algo Trading").setContentText(text)
        .setSmallIcon(R.drawable.ic_stat_tradelock).setOngoing(true)
        .setContentIntent(PendingIntent.getActivity(this, 1, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT)).build());
  }

  /** One request to /api/algo/entries. Rings for each new, fresh entry. Returns a short status line. */
  private String checkOnce() throws Exception {
    SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
    long after = p.getLong("lastId", -1);   // -1 = first start: take the latest id, never ring for old trades
    long alertsAfter = p.getLong("lastAlertId", -1);   // price alerts from the chart, the same way
    String cookie = CookieManager.getInstance().getCookie("https://" + BuildConfig.HOST);
    if (cookie == null || cookie.isEmpty()) return "open TradeLock and sign in";
    HttpURLConnection http = (HttpURLConnection) new URL("https://" + BuildConfig.HOST + "/api/algo/entries?after=" + after + "&alertsAfter=" + alertsAfter).openConnection();
    http.setConnectTimeout(8_000);
    http.setReadTimeout(8_000);
    http.setRequestProperty("Cookie", cookie);
    http.setRequestProperty("Accept", "application/json");
    http.setRequestProperty("User-Agent", "TradeLockApp/" + BuildConfig.VERSION_NAME + " (trade alarm)");
    int code = http.getResponseCode();
    if (code == 401) return "signed out: open TradeLock and sign in";
    if (code != 200) return "server busy (" + code + ")";
    JSONObject res = new JSONObject(read(http.getInputStream()));
    MarketSession.save(this, res.optJSONObject("session"), res.optBoolean("algoOn", true));
    long latest = res.optLong("latestId", 0), serverTime = res.optLong("serverTime", System.currentTimeMillis());
    // Price alerts: poll fast while any wait; ring for each one fired since the last.
    p.edit().putBoolean("alertsActive", res.optBoolean("alertsActive", false)).apply();
    long latestAlert = res.optLong("latestAlertId", 0);
    if (alertsAfter < 0) p.edit().putLong("lastAlertId", latestAlert).apply();
    else {
      JSONArray alerts = res.optJSONArray("alerts");
      long seenAlert = alertsAfter;
      for (int i = 0; alerts != null && i < alerts.length(); i++) {
        JSONObject a = alerts.getJSONObject(i);
        seenAlert = Math.max(seenAlert, a.optLong("id"));
        if (serverTime - a.optLong("triggeredAt") > FRESH_MS) continue;
        ring("PRICE ALERT · " + a.optString("symbol"),
            ("below".equals(a.optString("dir")) ? "Fell to " : "Reached ") + a.optDouble("price") + "\nTraded at " + a.optDouble("triggeredPrice"));
      }
      if (latestAlert < alertsAfter) seenAlert = latestAlert;
      p.edit().putLong("lastAlertId", seenAlert).apply();
    }
    if (after < 0) { p.edit().putLong("lastId", latest).apply(); return "connected"; }
    JSONArray entries = res.optJSONArray("entries");
    long seen = after;
    for (int i = 0; entries != null && i < entries.length(); i++) {
      JSONObject e = entries.getJSONObject(i);
      seen = Math.max(seen, e.optLong("id"));
      if (serverTime - e.optLong("createdAt") > FRESH_MS) continue;
      String strategy = e.optString("strategy", "ORB 5m");
      if (strategy.isEmpty() || "null".equals(strategy)) strategy = "ORB 5m";
      ring("TRADE ENTERED · " + e.optString("direction") + " · " + strategy,
          e.optString("symbol") + "\n" + e.optInt("lots") + " lots (" + e.optInt("qty") + " qty) @ " + e.optDouble("entryPrice")
              + "\nStop-loss " + e.optDouble("slPrice"));
    }
    // Rows deleted or the database restored: ids restart lower, so follow the server's latest id down,
    // or new entries with reused ids would never ring.
    if (latest < after) seen = latest;
    p.edit().putLong("lastId", seen).apply();
    return "connected";
  }

  private static String read(InputStream in) throws Exception {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    byte[] buf = new byte[4096];
    for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
    return out.toString("UTF-8");
  }

  // ---- the alarm ------------------------------------------------------------------------------------

  /** Ring until silenced: full-screen alert, alarm tone at full alarm volume, continuous vibration. */
  synchronized void ring(String title, String body) {
    if (title == null) title = "TRADE ENTERED";
    if (body == null) body = "";
    NotificationManager nm = getSystemService(NotificationManager.class);
    AudioManager audio = (AudioManager) getSystemService(AUDIO_SERVICE);
    // Do Not Disturb, Android 6-14: with access granted, let everything through while it rings (restored
    // on Stop). Android 15+ cannot change the user's DND from an app; there the alarm-usage audio (allowed
    // in DND by default) and the DND-bypassing alarm channel get it through.
    if (Build.VERSION.SDK_INT >= 23 && Build.VERSION.SDK_INT < 35 && nm.isNotificationPolicyAccessGranted() && savedFilter < 0) {
      int f = nm.getCurrentInterruptionFilter();
      if (f != NotificationManager.INTERRUPTION_FILTER_ALL) { savedFilter = f; nm.setInterruptionFilter(NotificationManager.INTERRUPTION_FILTER_ALL); }
    }
    // The alarm stream ignores silent / vibrate ringer modes; turn it all the way up while ringing.
    if (savedAlarmVolume < 0) {
      savedAlarmVolume = audio.getStreamVolume(AudioManager.STREAM_ALARM);
      audio.setStreamVolume(AudioManager.STREAM_ALARM, audio.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0);
    }
    AudioAttributes attrs = new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build();
    if (player == null) {
      try {
        Uri tone = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
        if (tone == null) tone = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        player = new MediaPlayer();
        player.setAudioAttributes(attrs);
        player.setDataSource(this, tone);
        player.setLooping(true);
        player.prepare();
        player.start();
      } catch (Exception e) { Log.w(TAG, "alarm tone failed", e); player = null; }
    }
    if (vibrator == null) {
      vibrator = Build.VERSION.SDK_INT >= 31 ? ((VibratorManager) getSystemService(VIBRATOR_MANAGER_SERVICE)).getDefaultVibrator()
          : (Vibrator) getSystemService(VIBRATOR_SERVICE);
      long[] pattern = { 0, 900, 400 };
      if (Build.VERSION.SDK_INT >= 26) vibrator.vibrate(VibrationEffect.createWaveform(pattern, 0), attrs);
      else vibrator.vibrate(pattern, 0);
    }
    Intent full = new Intent(this, AlarmActivity.class).putExtra("title", title).putExtra("body", body)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_USER_ACTION);
    PendingIntent fullPi = PendingIntent.getActivity(this, 2, full, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    PendingIntent stopPi = PendingIntent.getService(this, 3, new Intent(this, TradeAlertService.class).setAction(ACTION_SILENCE),
        PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    Notification.Builder b = builder(CH_ALARM).setContentTitle(title).setContentText(body.replace("\n", " · "))
        .setStyle(new Notification.BigTextStyle().bigText(body)).setSmallIcon(R.drawable.ic_stat_tradelock)
        .setCategory(Notification.CATEGORY_ALARM).setPriority(Notification.PRIORITY_MAX).setOngoing(true)
        .setVisibility(Notification.VISIBILITY_PUBLIC).setFullScreenIntent(fullPi, true).setContentIntent(fullPi)
        .addAction(new Notification.Action.Builder(null, "STOP ALARM", stopPi).build());
    nm.notify(ID_ALARM, b.build());
    // Also open the alarm screen directly: always allowed while TradeLock is on screen, and from the
    // background once "Display over other apps" is granted (the full-screen notification covers the rest).
    try { startActivity(full); } catch (Exception e) { Log.w(TAG, "alarm screen blocked; notification shown", e); }
  }

  synchronized void silence() {
    if (player != null) { try { player.stop(); } catch (Exception ignored) { } player.release(); player = null; }
    if (vibrator != null) { vibrator.cancel(); vibrator = null; }
    AudioManager audio = (AudioManager) getSystemService(AUDIO_SERVICE);
    if (savedAlarmVolume >= 0) { audio.setStreamVolume(AudioManager.STREAM_ALARM, savedAlarmVolume, 0); savedAlarmVolume = -1; }
    NotificationManager nm = getSystemService(NotificationManager.class);
    if (savedFilter >= 0 && Build.VERSION.SDK_INT >= 23 && Build.VERSION.SDK_INT < 35 && nm.isNotificationPolicyAccessGranted()) nm.setInterruptionFilter(savedFilter);
    savedFilter = -1;
    nm.cancel(ID_ALARM);
    sendBroadcast(new Intent(AlarmActivity.ACTION_CLOSE).setPackage(getPackageName()));
  }
}
