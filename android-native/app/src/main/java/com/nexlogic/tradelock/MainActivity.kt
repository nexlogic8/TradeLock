package com.nexlogic.tradelock

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import com.nexlogic.tradelock.data.AppViewModel
import com.nexlogic.tradelock.data.Session
import com.nexlogic.tradelock.ui.AppRoot
import com.nexlogic.tradelock.ui.theme.TradeLockTheme

class MainActivity : ComponentActivity() {
    private val vm: AppViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        val splash = installSplashScreen()
        super.onCreate(savedInstanceState)
        // Keep the launch screen until we know whether the user is signed in (no login flash).
        splash.setKeepOnScreenCondition { vm.session.value == Session.Loading }
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
        )
        setContent { TradeLockTheme { AppRoot(vm) } }
    }
}
