package in.tradelock.app;

import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.os.CancellationSignal;
import android.util.Log;
import android.util.Base64;
import android.view.View;
import android.widget.FrameLayout;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.GetCredentialCancellationException;
import androidx.credentials.exceptions.GetCredentialException;

import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;

import org.json.JSONObject;

import java.util.Arrays;
import java.io.File;
import java.io.FileOutputStream;
import java.util.HashSet;
import java.util.Set;

/**
 * TradeLock runs entirely inside this activity's own WebView (Android System WebView), never in an
 * external browser. Pages come from https://tradelock.in. Links to other apps (UPI, WhatsApp,
 * Telegram, phone, email) are handed to those apps; everything else stays inside TradeLock.
 */
public class MainActivity extends ComponentActivity {

  /** Web links that should open the matching app instead of loading inside TradeLock. */
  private static final Set<String> HANDOFF_HOSTS = new HashSet<>(Arrays.asList(
      "wa.me", "api.whatsapp.com", "web.whatsapp.com", "t.me", "telegram.me",
      "twitter.com", "x.com", "play.google.com", "www.youtube.com", "youtube.com"));

  private WebView web;
  private FrameLayout root;
  private boolean offline;
  private int topInset;

  private void applyWebInsets() {
    // Insets are in physical pixels; CSS wants density-independent pixels.
    float css = topInset / getResources().getDisplayMetrics().density;
    web.evaluateJavascript("document.documentElement.style.setProperty('--android-top-inset','" + css + "px');document.documentElement.classList.add('android-app')", null);
  }

  @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

    web = new WebView(this);
    web.setBackgroundColor(Color.parseColor("#05090F"));
    web.setOverScrollMode(View.OVER_SCROLL_NEVER);
    // A WebView ignores its own padding, so it sits inside a container that takes the system-bar insets.
    root = new FrameLayout(this);
    root.setBackgroundColor(Color.parseColor("#05090F"));
    root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
    setContentView(root);

    // Keep the page clear of the status bar, navigation bar and keyboard (edge-to-edge on Android 15+).
    ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
      Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.ime());
      topInset = bars.top;
      // Let drawer backgrounds cover the full screen; web content uses --android-top-inset.
      v.setPadding(bars.left, 0, bars.right, bars.bottom);
      applyWebInsets();
      return WindowInsetsCompat.CONSUMED;
    });

    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setDatabaseEnabled(true);
    // Off: with overview mode a page wider than the phone (a wide table) made the WebView rescale the whole
    // screen. The pages size themselves to the phone (viewport meta, maximum-scale=1).
    s.setLoadWithOverviewMode(false);
    s.setUseWideViewPort(true);
    s.setSupportZoom(false);
    s.setTextZoom(100);   // same text size as the website design, whatever the phone's font setting
    s.setBuiltInZoomControls(false);
    s.setMediaPlaybackRequiresUserGesture(true);
    s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    s.setSupportMultipleWindows(false);          // target=_blank opens here and goes through the link rules
    s.setJavaScriptCanOpenWindowsAutomatically(false);
    s.setUserAgentString(s.getUserAgentString() + " TradeLockApp/" + BuildConfig.VERSION_NAME);

    CookieManager cookies = CookieManager.getInstance();
    cookies.setAcceptCookie(true);
    cookies.setAcceptThirdPartyCookies(web, true);   // Razorpay checkout frame

    web.addJavascriptInterface(new Bridge(), "TradeLockApp");
    web.setWebChromeClient(new WebChromeClient());
    web.setWebViewClient(new Client());

    getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
      @Override public void handleOnBackPressed() {
        if (!offline && web.canGoBack()) web.goBack();
        else finish();
      }
    });

    if (state != null) web.restoreState(state);
    else web.loadUrl(startUrl(getIntent()));
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    Uri data = intent.getData();
    if (data != null && isOurs(data)) web.loadUrl(data.toString());
  }

  @Override protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); web.saveState(out); }
  @Override protected void onPause() { super.onPause(); CookieManager.getInstance().flush(); }
  @Override protected void onDestroy() { web.destroy(); super.onDestroy(); }

  private String startUrl(Intent intent) {
    Uri data = intent != null ? intent.getData() : null;
    return data != null && isOurs(data) ? data.toString() : BuildConfig.HOME_URL;
  }

  private static boolean isOurs(Uri uri) {
    return "https".equals(uri.getScheme()) && BuildConfig.HOST.equalsIgnoreCase(uri.getHost());
  }

  /** Open a link in the app that handles it (UPI app, WhatsApp...). */
  private boolean handOff(Uri uri) {
    try {
      Intent i;
      if ("intent".equals(uri.getScheme())) {
        i = Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME);
        i.addCategory(Intent.CATEGORY_BROWSABLE);
        i.setComponent(null);
        i.setSelector(null);
      } else {
        i = new Intent(Intent.ACTION_VIEW, uri);
      }
      startActivity(i);
    } catch (ActivityNotFoundException | java.net.URISyntaxException e) {
      // e.g. a UPI app is not installed: the payment page offers other methods.
    }
    return true;
  }

  private class Client extends WebViewClient {
    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
      Uri uri = req.getUrl();
      String scheme = uri.getScheme() == null ? "" : uri.getScheme();
      if (scheme.equals("http") || scheme.equals("https")) {
        String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase();
        if (HANDOFF_HOSTS.contains(host)) return handOff(uri);
        return false;   // tradelock.in, Razorpay and bank pages stay inside TradeLock
      }
      return handOff(uri);   // upi:, intent:, tel:, mailto:, whatsapp:, tg:...
    }

    @Override
    public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
      if (req.isForMainFrame()) {
        offline = true;
        view.loadUrl("file:///android_asset/offline.html");
      }
    }

    @Override
    public void onPageFinished(WebView view, String url) {
      if (url != null && url.startsWith("https://")) offline = false;
      applyWebInsets();
    }
  }

  /** Called from the page as window.TradeLockApp.*. */
  private class Bridge {
    @JavascriptInterface
    public void retry() {
      runOnUiThread(() -> { offline = false; web.loadUrl(BuildConfig.HOME_URL); });
    }

    /**
     * Colour of the strip behind the status bar (and navigation bar), set by the page so it matches
     * whatever is on top: the page background, or the profile panel when it is open.
     */
    @JavascriptInterface
    public void setBarColor(String color, boolean lightBackground) {
      runOnUiThread(() -> {
        try {
          root.setBackgroundColor(Color.parseColor(color));
          WindowCompat.getInsetsController(getWindow(), root).setAppearanceLightStatusBars(lightBackground);
          WindowCompat.getInsetsController(getWindow(), root).setAppearanceLightNavigationBars(lightBackground);
        } catch (IllegalArgumentException ignored) { /* not a colour */ }
      });
    }

    /** Shares the generated referral card to the requested app with only the referral URL as text. */
    @JavascriptInterface
    public void shareReferral(String app, String imageDataUrl, String referralLink) {
      runOnUiThread(() -> {
        try {
          int comma = imageDataUrl.indexOf(',');
          if (comma < 0) return;
          byte[] png = Base64.decode(imageDataUrl.substring(comma + 1), Base64.DEFAULT);
          File dir = new File(getCacheDir(), "shared");
          if (!dir.exists() && !dir.mkdirs()) return;
          File image = new File(dir, "tradelock-referral.png");
          try (FileOutputStream out = new FileOutputStream(image)) { out.write(png); }
          Uri uri = FileProvider.getUriForFile(MainActivity.this, BuildConfig.APPLICATION_ID + ".fileprovider", image);
          Intent share = new Intent(Intent.ACTION_SEND)
              .setType("image/png")
              .putExtra(Intent.EXTRA_STREAM, uri)
              .putExtra(Intent.EXTRA_TEXT, referralLink)
              .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
          if ("whatsapp".equals(app)) share.setPackage("com.whatsapp");
          else if ("telegram".equals(app)) share.setPackage("org.telegram.messenger");
          try {
            startActivity(share);
          } catch (ActivityNotFoundException missingPreferredApp) {
            String alternate = "whatsapp".equals(app) ? "com.whatsapp.w4b"
                : "telegram".equals(app) ? "org.telegram.messenger.web" : null;
            if (alternate != null) {
              try {
                share.setPackage(alternate);
                startActivity(share);
                return;
              } catch (ActivityNotFoundException ignored) { /* use the chooser below */ }
            }
            share.setPackage(null);
            startActivity(Intent.createChooser(share, "Share referral"));
          }
        } catch (Exception e) {
          Log.w("TradeLock", "Could not share referral image", e);
        }
      });
    }

    /** Stable per-device ID for this app (survives reinstall): one free trial per phone. */
    @JavascriptInterface
    public String deviceId() {
      String id = Settings.Secure.getString(getContentResolver(), Settings.Secure.ANDROID_ID);
      return id == null ? "" : id;
    }

    // ---- Trade entry alarm (TradeAlertService) ----

    /** Algo Trading is on: keep watching for automatic entries, with the app open or closed. */
    @JavascriptInterface
    public void startTradeAlerts() { runOnUiThread(() -> TradeAlertService.start(MainActivity.this)); }

    @JavascriptInterface
    public void stopTradeAlerts() { runOnUiThread(() -> TradeAlertService.stop(MainActivity.this)); }

    /** A price alert fired while the app is open: ring the real alarm with its text (Stop to end it). */
    @JavascriptInterface
    public void ringAlarm(String title, String body) {
      runOnUiThread(() -> {
        Intent i = new Intent(MainActivity.this, TradeAlertService.class).setAction(TradeAlertService.ACTION_RING)
            .putExtra("title", title == null || title.isEmpty() ? "PRICE ALERT" : title).putExtra("body", body == null ? "" : body);
        if (android.os.Build.VERSION.SDK_INT >= 26) startForegroundService(i); else startService(i);
      });
    }

    /** Rings the real alarm once (Stop to end it), to check sound, vibration and the full-screen alert. */
    @JavascriptInterface
    public void testTradeAlarm() {
      runOnUiThread(() -> {
        Intent i = new Intent(MainActivity.this, TradeAlertService.class).setAction(TradeAlertService.ACTION_RING)
            .putExtra("title", "TEST · TRADE ENTERED").putExtra("body", "This is how an Algo Trading entry will ring.\nPress STOP ALARM to end it.");
        if (android.os.Build.VERSION.SDK_INT >= 26) startForegroundService(i); else startService(i);
      });
    }

    /** What the alarm still needs from the phone, as JSON for the page. */
    @JavascriptInterface
    public String tradeAlertStatus() {
      try { return alertStatus().toString(); } catch (Exception e) { return "{}"; }
    }

    /** Asks for the next missing permission (one system screen per call). */
    @JavascriptInterface
    public void setupTradeAlerts() { runOnUiThread(MainActivity.this::nextAlertPermission); }

    /** Shows the phone's Google account picker; the result goes to window.__tlGoogle(token, error). */
    @JavascriptInterface
    public void googleSignIn() {
      runOnUiThread(MainActivity.this::startGoogleSignIn);
    }
  }

  private JSONObject alertStatus() throws org.json.JSONException {
    android.app.NotificationManager nm = getSystemService(android.app.NotificationManager.class);
    android.os.PowerManager pm = (android.os.PowerManager) getSystemService(POWER_SERVICE);
    int sdk = android.os.Build.VERSION.SDK_INT;
    JSONObject o = new JSONObject();
    o.put("enabled", TradeAlertService.enabled(this));
    o.put("notifications", sdk < 33 || checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == android.content.pm.PackageManager.PERMISSION_GRANTED);
    o.put("fullScreen", sdk < 34 || nm.canUseFullScreenIntent());
    o.put("dnd", sdk < 23 || nm.isNotificationPolicyAccessGranted());
    o.put("battery", sdk < 23 || pm.isIgnoringBatteryOptimizations(getPackageName()));
    o.put("overlay", sdk < 23 || Settings.canDrawOverlays(this));   // lets the alarm screen open from the background
    return o;
  }

  private void nextAlertPermission() {
    try {
      JSONObject s = alertStatus();
      int sdk = android.os.Build.VERSION.SDK_INT;
      Uri pkg = Uri.parse("package:" + getPackageName());
      if (!s.getBoolean("notifications")) requestPermissions(new String[] { android.Manifest.permission.POST_NOTIFICATIONS }, 7);
      else if (!s.getBoolean("fullScreen") && sdk >= 34) startActivity(new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, pkg));
      else if (!s.getBoolean("overlay")) startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, pkg));
      else if (!s.getBoolean("dnd")) startActivity(new Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS));
      else if (!s.getBoolean("battery")) {
        @SuppressLint("BatteryLife") Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, pkg);
        startActivity(i);
      }
    } catch (Exception e) {
      Log.w("TradeAlerts", "permission screen unavailable", e);
      startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName())));
    }
  }

  // Back from a permission screen: let the page refresh what is still missing.
  @Override protected void onResume() {
    super.onResume();
    if (web != null) web.evaluateJavascript("window.__tlAlertsChanged && window.__tlAlertsChanged()", null);
  }

  private void startGoogleSignIn() {
    GetSignInWithGoogleOption option = new GetSignInWithGoogleOption.Builder(BuildConfig.GOOGLE_WEB_CLIENT_ID).build();
    GetCredentialRequest request = new GetCredentialRequest.Builder().addCredentialOption(option).build();
    CredentialManager.create(this).getCredentialAsync(this, request, new CancellationSignal(),
        ContextCompat.getMainExecutor(this),
        new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
          @Override public void onResult(GetCredentialResponse res) {
            Credential c = res.getCredential();
            if (c instanceof CustomCredential && GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(c.getType())) {
              String token = GoogleIdTokenCredential.createFrom(c.getData()).getIdToken();
              sendGoogle(token, null);
            } else {
              sendGoogle(null, "Google sign-in returned an unexpected response.");
            }
          }
          @Override public void onError(GetCredentialException e) {
            Log.w("TradeLockAuth", "Google sign-in failed: " + e.getType() + " / " + e.getMessage());
            sendGoogle(null, e instanceof GetCredentialCancellationException
                ? "Google sign-in was cancelled." : "Google sign-in is not available on this device right now (" + e.getType() + ").");
          }
        });
  }

  private void sendGoogle(String token, String error) {
    String js = "window.__tlGoogle && window.__tlGoogle(" + (token == null ? "null" : JSONObject.quote(token)) + ","
        + (error == null ? "null" : JSONObject.quote(error)) + ")";
    web.evaluateJavascript(js, null);
  }
}
