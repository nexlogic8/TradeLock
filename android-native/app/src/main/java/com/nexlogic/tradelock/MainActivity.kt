package com.nexlogic.tradelock

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import com.nexlogic.tradelock.data.AppViewModel
import com.nexlogic.tradelock.data.RazorpayPay
import com.nexlogic.tradelock.data.Session
import com.nexlogic.tradelock.ui.AppRoot
import com.nexlogic.tradelock.ui.theme.TradeLockTheme
import com.razorpay.Checkout
import com.razorpay.PaymentData
import com.razorpay.PaymentResultWithDataListener

// PaymentResultWithDataListener: Razorpay Checkout (wallet top-ups) reports its result to the activity that opened it.
class MainActivity : ComponentActivity(), PaymentResultWithDataListener {
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
        Checkout.preload(applicationContext)   // the payment screen opens faster
        setContent { TradeLockTheme { AppRoot(vm) } }
    }

    // Razorpay's own hand-back of the Checkout result (the SDK also calls the listener directly; RazorpayPay ignores a repeat).
    @Deprecated("Activity result API")
    @Suppress("DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: android.content.Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        runCatching { Checkout.handleActivityResult(this, requestCode, resultCode, data, this, null) }
    }

    override fun onPaymentSuccess(razorpayPaymentId: String?, data: PaymentData?) = RazorpayPay.onSuccess(data)
    override fun onPaymentError(code: Int, description: String?, data: PaymentData?) = RazorpayPay.onError(code, description)
}
