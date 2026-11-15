package com.nexlogic.tradelock.ui

import kotlin.math.abs
import kotlin.math.roundToLong

/** Indian digit grouping: 3,31,325.10 */
fun groupIndian(n: Long): String {
    val s = n.toString()
    if (s.length <= 3) return s
    val last3 = s.takeLast(3)
    val rest = s.dropLast(3).reversed().chunked(2).joinToString(",").reversed()
    return "$rest,$last3"
}

/** ₹ amount. dp = decimals; sign = show + for gains (− always shown for losses). */
fun inr(v: Double?, dp: Int = 0, sign: Boolean = false): String {
    if (v == null || v.isNaN()) return "₹–"
    val neg = v < 0
    val a = abs(v)
    val body = if (dp == 0) groupIndian(a.roundToLong()) else {
        val scaled = (a * Math.pow(10.0, dp.toDouble())).roundToLong()
        val whole = scaled / Math.pow(10.0, dp.toDouble()).toLong()
        val frac = (scaled % Math.pow(10.0, dp.toDouble()).toLong()).toString().padStart(dp, '0')
        "${groupIndian(whole)}.$frac"
    }
    val zero = a < (if (dp == 0) 0.5 else 0.005)
    val prefix = when { zero -> ""; neg -> "−"; sign -> "+"; else -> "" }
    return "$prefix₹$body"
}

fun paise(p: Long?) = inr(p?.let { it / 100.0 }, dp = 2)

/** "28s ago", "3m ago", "2h ago" */
fun ago(ms: Long?): String {
    if (ms == null) return ""
    val s = ((System.currentTimeMillis() - ms) / 1000).coerceAtLeast(0)
    return when { s < 60 -> "${s}s ago"; s < 3600 -> "${s / 60}m ago"; s < 86400 -> "${s / 3600}h ago"; else -> "${s / 86400}d ago" }
}

fun hhmm(minute: Int) = "%02d:%02d".format(minute / 60, minute % 60)
