package in.tradelock.app;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Full-screen "trade entered" alert, shown over the lock screen while the trade alarm rings. */
public class AlarmActivity extends Activity {
  static final String ACTION_CLOSE = "in.tradelock.app.ALARM_CLOSE";

  private final BroadcastReceiver close = new BroadcastReceiver() {
    @Override public void onReceive(Context c, Intent i) { finish(); }
  };

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    if (Build.VERSION.SDK_INT >= 27) {
      setShowWhenLocked(true);
      setTurnScreenOn(true);
      KeyguardManager km = getSystemService(KeyguardManager.class);
      if (km != null) km.requestDismissKeyguard(this, null);
    } else {
      getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
          | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD);
    }
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

    float dp = getResources().getDisplayMetrics().density;
    LinearLayout col = new LinearLayout(this);
    col.setOrientation(LinearLayout.VERTICAL);
    col.setGravity(Gravity.CENTER);
    col.setPadding((int) (24 * dp), (int) (48 * dp), (int) (24 * dp), (int) (48 * dp));
    col.setBackgroundColor(Color.parseColor("#05090F"));

    TextView title = new TextView(this);
    title.setText(getIntent().getStringExtra("title"));
    title.setTextColor(Color.parseColor("#F5B942"));
    title.setTextSize(26);
    title.setTypeface(Typeface.DEFAULT_BOLD);
    title.setGravity(Gravity.CENTER);
    col.addView(title);

    TextView body = new TextView(this);
    body.setText(getIntent().getStringExtra("body"));
    body.setTextColor(Color.WHITE);
    body.setTextSize(19);
    body.setGravity(Gravity.CENTER);
    body.setLineSpacing(6 * dp, 1f);
    body.setPadding(0, (int) (24 * dp), 0, (int) (40 * dp));
    col.addView(body);

    Button stop = new Button(this);
    stop.setText("STOP ALARM");
    stop.setTextSize(22);
    stop.setTypeface(Typeface.DEFAULT_BOLD);
    stop.setTextColor(Color.parseColor("#2A1D03"));
    GradientDrawable bg = new GradientDrawable();
    bg.setColor(Color.parseColor("#F5B942"));
    bg.setCornerRadius(18 * dp);
    stop.setBackground(bg);
    stop.setOnClickListener(v -> {
      startService(new Intent(this, TradeAlertService.class).setAction(TradeAlertService.ACTION_SILENCE));
      finish();
    });
    col.addView(stop, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, (int) (72 * dp)));

    Button open = new Button(this);
    open.setText("Stop and open TradeLock");
    open.setAllCaps(false);
    open.setTextColor(Color.parseColor("#38EBB4"));
    open.setBackgroundColor(Color.TRANSPARENT);
    open.setOnClickListener(v -> {
      startService(new Intent(this, TradeAlertService.class).setAction(TradeAlertService.ACTION_SILENCE));
      startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP));
      finish();
    });
    col.addView(open);
    setContentView(col);

    IntentFilter f = new IntentFilter(ACTION_CLOSE);
    if (Build.VERSION.SDK_INT >= 33) registerReceiver(close, f, Context.RECEIVER_NOT_EXPORTED);
    else registerReceiver(close, f);
  }

  // Back does not dismiss the alarm: only the Stop buttons do.
  @Override public void onBackPressed() { }

  @Override protected void onDestroy() { unregisterReceiver(close); super.onDestroy(); }
}
