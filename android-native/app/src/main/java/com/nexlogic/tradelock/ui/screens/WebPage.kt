package com.nexlogic.tradelock.ui.screens

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.nexlogic.tradelock.data.Api
import com.nexlogic.tradelock.ui.theme.Tl

/**
 * A TradeLock page that isn't native yet, shown inside the app with the same session. The page's own header and
 * tab bar are hidden: the native app provides them.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun WebPage(path: String, bottomPad: PaddingValues, onLeave: () -> Unit) {
    var loading by remember(path) { mutableStateOf(true) }
    var view by remember { mutableStateOf<WebView?>(null) }
    BackHandler { val v = view; if (v != null && v.canGoBack()) v.goBack() else onLeave() }

    Box(Modifier.fillMaxSize().background(Tl.bg).statusBarsPadding().padding(bottom = bottomPad.calculateBottomPadding())) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { ctx ->
                // Hand the app's session to the web view (same tl_sid cookie).
                val cm = CookieManager.getInstance()
                cm.setAcceptCookie(true)
                Api.cookies.header().split("; ").filter { it.isNotBlank() }.forEach { cm.setCookie(Api.BASE, "$it; Path=/; Secure") }
                cm.flush()
                WebView(ctx).apply {
                    setBackgroundColor(android.graphics.Color.parseColor("#06080C"))
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    settings.userAgentString = settings.userAgentString + " TradeLockNative"
                    webViewClient = object : WebViewClient() {
                        override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest) = r.url.host != android.net.Uri.parse(Api.BASE).host
                        override fun onPageStarted(v: WebView, url: String?, favicon: Bitmap?) { loading = true }
                        override fun onPageFinished(v: WebView, url: String?) {
                            v.evaluateJavascript(HIDE_CHROME, null)
                            loading = false
                        }
                    }
                    loadUrl("${Api.BASE}/$path")
                    view = this
                }
            },
            update = { v -> if (!v.url.orEmpty().contains("/$path")) v.loadUrl("${Api.BASE}/$path") },
        )
        AnimatedVisibility(loading, exit = fadeOut(), modifier = Modifier.align(Alignment.TopCenter)) {
            LinearProgressIndicator(Modifier.fillMaxWidth().height(2.dp), color = Tl.mint, trackColor = Tl.bg)
        }
    }
}

private const val HIDE_CHROME = """(function(){
  if (document.getElementById('tl-native')) return;
  var s = document.createElement('style'); s.id = 'tl-native';
  s.textContent = '.topbar,.tabbar,.side,.menu-btn{display:none!important} .main{padding-bottom:16px!important} body{background:#06080C}';
  document.head.appendChild(s);
})();"""
