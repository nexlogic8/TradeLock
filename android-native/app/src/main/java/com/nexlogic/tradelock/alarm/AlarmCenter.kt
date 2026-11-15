package com.nexlogic.tradelock.alarm

import android.annotation.SuppressLint
import android.app.Activity
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings

/**
 * The phone alarm for Algo Trading entries and price alerts (TradeAlertService rings it, full screen, through
 * silent and Do Not Disturb). Here: whether it runs, what the phone still needs to allow, and ringing it now.
 */
object AlarmCenter {
    /** One thing the alarm needs from the phone. */
    data class Need(val key: String, val title: String, val detail: String, val ok: Boolean)

    fun needs(c: Context): List<Need> {
        val nm = c.getSystemService(NotificationManager::class.java)
        val pm = c.getSystemService(Context.POWER_SERVICE) as PowerManager
        val sdk = Build.VERSION.SDK_INT
        return listOf(
            Need("notifications", "Notifications", "Shows the alarm and its Stop button", sdk < 33 || c.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED),
            Need("fullScreen", "Full-screen alert", "Opens the alarm over the lock screen", sdk < 34 || nm.canUseFullScreenIntent()),
            Need("overlay", "Display over other apps", "Lets the alarm open from the background", Settings.canDrawOverlays(c)),
            Need("dnd", "Do Not Disturb access", "Rings even on silent and in DND", nm.isNotificationPolicyAccessGranted),
            Need("battery", "No battery limit", "Keeps watching while the phone sleeps", pm.isIgnoringBatteryOptimizations(c.packageName)),
        )
    }
    fun missing(c: Context) = needs(c).filterNot { it.ok }

    /** Opens the system screen for the next missing permission (one per call). */
    @SuppressLint("BatteryLife")
    fun askNext(a: Activity) {
        val pkg = Uri.parse("package:${a.packageName}")
        try {
            when (missing(a).firstOrNull()?.key) {
                "notifications" -> a.requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 7)
                "fullScreen" -> if (Build.VERSION.SDK_INT >= 34) a.startActivity(Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, pkg))
                "overlay" -> a.startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, pkg))
                "dnd" -> a.startActivity(Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS))
                "battery" -> a.startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, pkg))
            }
        } catch (_: Exception) {
            a.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg))
        }
    }

    fun running(c: Context) = TradeAlertService.enabled(c)

    /** Watch in the background while Algo Trading is on or a price alert is waiting; stop otherwise. */
    fun sync(c: Context, want: Boolean) {
        if (want == running(c)) return
        if (want) TradeAlertService.start(c) else TradeAlertService.stop(c)
    }

    /** Ring the alarm now (STOP ALARM ends it). */
    fun ring(c: Context, title: String, body: String) {
        val i = Intent(c, TradeAlertService::class.java).setAction(TradeAlertService.ACTION_RING).putExtra("title", title).putExtra("body", body)
        if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i) else c.startService(i)
    }

    fun test(c: Context) = ring(c, "TEST · TRADE ENTERED", "This is how an Algo Trading entry or a price alert will ring.\nPress STOP ALARM to end it.")
}
