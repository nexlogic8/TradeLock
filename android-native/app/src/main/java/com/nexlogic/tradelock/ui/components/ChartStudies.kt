package com.nexlogic.tradelock.ui.components

import androidx.compose.ui.graphics.Color
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sign
import kotlin.math.sqrt

// Chart indicators and strategy signals for Power Scalper, ported from the web app (web/js/pages/chart-studies.js and
// scalper-chart-signals.js) so both draw the same lines and arrows. They only draw on the charts; Algo Trading has
// its own fixed rules on the server.

/** An indicator type: its label, its parameters (name, default, min, max) and the colours of its lines. */
enum class StudyType(val label: String, val title: String, val params: List<StudyParam>, val colors: List<Color>) {
    EMA("EMA", "Exponential moving average", listOf(StudyParam("Length", 9.0, 1.0, 500.0, 1.0)), listOf(Color(0xFF4EA1FF))),
    SMA("SMA", "Simple moving average", listOf(StudyParam("Length", 20.0, 1.0, 500.0, 1.0)), listOf(Color(0xFFE879F9))),
    VWAP("VWAP", "Volume-weighted average price (each session)", emptyList(), listOf(Color(0xFFF59E0B))),
    BB("BB", "Bollinger Bands", listOf(StudyParam("Length", 20.0, 2.0, 500.0, 1.0), StudyParam("Std dev", 2.0, 0.5, 10.0, 0.5)),
        listOf(Color(0xFF7C9CFF), Color(0xFFF59E0B), Color(0xFF7C9CFF))),
    SUPERTREND("Supertrend", "Supertrend", listOf(StudyParam("ATR length", 10.0, 1.0, 200.0, 1.0), StudyParam("Factor", 3.0, 0.5, 20.0, 0.5)),
        listOf(Color(0xFF22C55E), Color(0xFFEF4444))),
}
data class StudyParam(val name: String, val default: Double, val min: Double, val max: Double, val step: Double)

/** One indicator on a chart: its type and parameter values. */
data class Study(val type: StudyType, val p: List<Double> = type.params.map { it.default }) {
    val name get() = when (type) {
        StudyType.VWAP -> "VWAP"
        StudyType.BB, StudyType.SUPERTREND -> "${type.label} ${fmt(p[0])} ${fmt(p[1])}"
        else -> "${type.label} ${fmt(p[0])}"
    }
    /** EMA 9 and EMA 21 get the chart's usual blue / amber; other EMAs the type colour. */
    fun color(i: Int) = if (type == StudyType.EMA && p[0] == 21.0) Color(0xFFFFBA52) else if (type == StudyType.EMA && p[0] == 9.0) Color(0xFF5AA9FF) else type.colors[i]
    fun encode() = (listOf(type.name) + p.map { fmt(it) }).joinToString(":")
    companion object {
        fun decode(s: String): Study? = runCatching {
            val parts = s.split(":"); val t = StudyType.valueOf(parts[0])
            Study(t, t.params.mapIndexed { i, d -> (parts.getOrNull(i + 1)?.toDoubleOrNull() ?: d.default).coerceIn(d.min, d.max) })
        }.getOrNull()
        fun decodeList(s: String?): List<Study>? = s?.split(";")?.mapNotNull { if (it.isBlank()) null else decode(it) }
        fun encodeList(l: List<Study>) = l.joinToString(";") { it.encode() }
        val DEFAULT = listOf(Study(StudyType.EMA, listOf(9.0)), Study(StudyType.EMA, listOf(21.0)))
    }
}
private fun fmt(d: Double) = if (d == Math.floor(d)) d.toLong().toString() else d.toString()

/** A line to draw: one value per candle (null = gap). */
class StudyLine(val values: List<Double?>, val color: Color, val label: String, val tag: Boolean = true)

private const val IST = 19_800L
private fun istDay(t: Long) = Math.floorDiv(t + IST, 86_400L)

/** EMA seeded with the first value (as the web chart). */
fun emaSeeded(v: List<Double>, n: Int): List<Double> {
    val k = 2.0 / (n + 1); var e: Double? = null
    return v.map { x -> (if (e == null) x else x * k + e!! * (1 - k)).also { e = it } }
}
private fun smaOf(v: List<Double>, n: Int): List<Double?> {
    var sum = 0.0
    return v.mapIndexed { i, x -> sum += x; if (i >= n) sum -= v[i - n]; if (i >= n - 1) sum / n else null }
}
private fun rmaOf(v: List<Double>, n: Int): List<Double?> {
    var r: Double? = null; var sum = 0.0
    return v.mapIndexed { i, x ->
        if (r == null) { sum += x; if (i == n - 1) r = sum / n; r } else { r = (r!! * (n - 1) + x) / n; r }
    }
}

fun computeStudy(s: Study, c: List<Candle>): List<StudyLine> {
    if (c.isEmpty()) return emptyList()
    val close = c.map { it.close }
    return when (s.type) {
        StudyType.EMA -> listOf(StudyLine(emaSeeded(close, s.p[0].toInt()), s.color(0), s.name))
        StudyType.SMA -> listOf(StudyLine(smaOf(close, s.p[0].toInt()), s.color(0), s.name))
        StudyType.VWAP -> {
            var day = Long.MIN_VALUE; var pv = 0.0; var vol = 0.0
            listOf(StudyLine(c.map { k ->
                val d = istDay(k.time); if (d != day) { day = d; pv = 0.0; vol = 0.0 }
                val src = (k.high + k.low + k.close) / 3; pv += src * k.volume; vol += k.volume
                if (vol > 0) pv / vol else src
            }, s.color(0), "VWAP"))
        }
        StudyType.BB -> {
            val n = s.p[0].toInt(); val mult = s.p[1]; val mid = smaOf(close, n)
            val dev = mid.mapIndexed { i, m -> m?.let { var q = 0.0; for (j in i - n + 1..i) q += (close[j] - it) * (close[j] - it); sqrt(q / n) } }
            listOf(
                StudyLine(mid.mapIndexed { i, m -> m?.let { it + mult * dev[i]!! } }, s.color(0), "BB up", tag = false),
                StudyLine(mid, s.color(1), s.name),
                StudyLine(mid.mapIndexed { i, m -> m?.let { it - mult * dev[i]!! } }, s.color(2), "BB low", tag = false),
            )
        }
        StudyType.SUPERTREND -> {
            val n = s.p[0].toInt(); val factor = s.p[1]
            val tr = c.mapIndexed { i, k -> if (i == 0) k.high - k.low else max(k.high - k.low, max(abs(k.high - c[i - 1].close), abs(k.low - c[i - 1].close))) }
            val atr = rmaOf(tr, n); val up = MutableList<Double?>(c.size) { null }; val down = MutableList<Double?>(c.size) { null }
            var fu: Double? = null; var fl: Double? = null; var dir = 1
            c.forEachIndexed { i, k ->
                val a = atr[i] ?: return@forEachIndexed
                val hl2 = (k.high + k.low) / 2; val bu = hl2 + factor * a; val bl = hl2 - factor * a; val prev = c.getOrNull(i - 1)?.close ?: k.close
                fu = if (fu == null || bu < fu!! || prev > fu!!) bu else fu
                fl = if (fl == null || bl > fl!! || prev < fl!!) bl else fl
                if (dir == 1 && k.close < fl!!) dir = -1 else if (dir == -1 && k.close > fu!!) dir = 1
                if (dir == 1) up[i] = fl else down[i] = fu
            }
            listOf(StudyLine(up, s.color(0), s.name), StudyLine(down, s.color(1), s.name))
        }
    }
}

// ---- strategy signals -----------------------------------------------------------------------------------

/** An arrow (or dot) on a candle: [up] = arrow up under the bar, else arrow down over it. */
data class ChartMarker(val time: Long, val up: Boolean, val color: Color, val text: String, val dot: Boolean = false)

/** The chart strategies, as on the web (key, label). */
val STRATEGIES = listOf("orb" to "ORB 5m", "hammer" to "Hammer 1m", "emaCross" to "EMA 9/21", "ema25" to "EMA 5/9 1m", "ema35" to "EMA 3/5 1m")

private val UP = Color(0xFF2BD67B); private val DOWN = Color(0xFFFF5C7A); private val ORB = Color(0xFFFFBA52); private val CROSS = Color(0xFF5AA9FF); private val SKIP = Color(0xFF8B95A7)

private data class Sig(val time: Long, val ce: Boolean)

private fun crossSignals(done: List<Candle>, fast: Int, slow: Int): List<Sig> {
    val cl = done.map { it.close }; val f = emaSeeded(cl, fast); val s = emaSeeded(cl, slow); val out = mutableListOf<Sig>()
    for (i in 1 until done.size) {
        val was = sign(f[i - 1] - s[i - 1]); val now = sign(f[i] - s[i])
        if (was != 0.0 && now != 0.0 && was != now) out += Sig(done[i].time, now > 0)
    }
    return out
}

private fun hammerSignals(rows: List<Candle>, barSec: Long, nowS: Long): List<Sig> {
    if (rows.size < 46) return emptyList()
    val cl = rows.map { it.close }; val e45 = emaSeeded(cl, 45); val e105 = emaSeeded(cl, 105); val out = mutableListOf<Sig>()
    fun touches(k: Candle, a: Double, b: Double) = max(k.open, k.close) >= min(a, b) && min(k.open, k.close) <= max(a, b)
    for (i in 44 until rows.size - 1) {
        val k = rows[i]; val prev = rows[i - 1]; val conf = rows[i + 1]
        if (k.time + barSec > nowS || conf.time + barSec > nowS || istDay(k.time) != istDay(conf.time)) continue
        val body = abs(k.close - k.open); if (body <= 0) continue
        val bLo = min(k.open, k.close); val bHi = max(k.open, k.close)
        val clear = !touches(prev, e45[i - 1], e105[i - 1])
        if (bLo > e45[i] && k.low <= e45[i] && bLo - k.low >= body && clear && conf.high > k.high) { out += Sig(conf.time, true); continue }
        if (bHi < e45[i] && k.high >= e45[i] && k.high - bHi >= body && clear && conf.low < k.low) out += Sig(conf.time, false)
    }
    return out
}

private class OrbSig(val breakoutAt: Long, val time: Long, val ce: Boolean, val skip: String?)

/** Opening range (09:15–09:20) of each session in the candles: day → (high, low). */
fun openingRanges(rows: List<Candle>, nowS: Long): Map<Long, Pair<Double, Double>> =
    rows.groupBy { istDay(it.time) }.mapNotNull { (day, bars) ->
        val start = day * 86_400 - IST + 9 * 3600 + 15 * 60; val end = start + 300
        val inR = bars.filter { it.time in start until end }
        if (inR.isEmpty() || end > nowS || inR.first().time != start) null
        else (inR.maxOf { it.high } to inR.minOf { it.low }).takeIf { it.first > it.second }?.let { day to it }
    }.toMap()

private fun orbFilter(rows: List<Candle>, time: Long, ce: Boolean): String? {
    val done = rows.filter { it.time <= time }; if (done.size < 2) return null
    val cl = done.map { it.close }
    var gain = 0.0; var loss = 0.0; var rsi: Double? = null
    for (i in 1 until cl.size) {
        val ch = cl[i] - cl[i - 1]; val g = max(0.0, ch); val l = max(0.0, -ch)
        if (i <= 14) { gain += g; loss += l; if (i == 14) { gain /= 14; loss /= 14 } } else { gain = (gain * 13 + g) / 14; loss = (loss * 13 + l) / 14 }
        if (i >= 14) rsi = if (loss == 0.0) 100.0 else 100 - 100 / (1 + gain / loss)
    }
    if (rsi != null && (rsi >= 75 || rsi <= 25)) return "RSI ${"%.1f".format(rsi)}"
    val e9 = emaSeeded(cl, 9).last(); val e21 = emaSeeded(cl, 21).last()
    return if ((if (ce) e9 - e21 else e21 - e9) < cl.last() * 0.0002) "EMA 9/21" else null
}

private fun orbSignals(rows: List<Candle>, barSec: Long, nowS: Long): List<OrbSig> {
    if (barSec != 60L && barSec != 300L) return emptyList()
    val ranges = openingRanges(rows, nowS); val out = mutableListOf<OrbSig>()
    rows.groupBy { istDay(it.time) }.forEach { (day, bars) ->
        val (hi, lo) = ranges[day] ?: return@forEach
        val end = day * 86_400 - IST + 9 * 3600 + 20 * 60
        val b = bars.filter { it.time in end..nowS }
        val armed = mutableMapOf(true to true, false to true)
        for (i in b.indices) {
            val k = b[i]; if (k.time + barSec > nowS) continue
            val ce = when { k.close > hi -> true; k.close < lo -> false; else -> { armed[true] = true; armed[false] = true; null } } ?: continue
            if (armed[ce] != true) continue
            val conf = b.getOrNull(i + 1) ?: break
            if (conf.time + barSec > nowS) break
            val broke = if (ce) conf.high > k.high else conf.low < k.low
            val colour = if (ce) conf.close > conf.open else conf.close < conf.open
            val span = conf.high - conf.low
            if (broke && colour && span > 0 && abs(conf.close - conf.open) >= 0.3 * span) {
                out += OrbSig(k.time, conf.time, ce, if (barSec == 300L) orbFilter(rows, conf.time, ce) else null)
                armed[ce] = false; armed[!ce] = true
            }
        }
    }
    return out
}

/**
 * Markers of the switched-on strategies from the index candles [spot] (at [spotSec] a bar). [chart] = "spot" for the
 * index chart (CE arrows up, PE arrows down), or "CE" / "PE" for an option chart (only its own side, as BUY arrows).
 */
fun strategyMarkers(on: Set<String>, spot: List<Candle>, spotSec: Long, nowMs: Long, chart: String): List<ChartMarker> {
    if (on.isEmpty() || spot.size < 3) return emptyList()
    val nowS = nowMs / 1000; val done = spot.filter { it.time + spotSec <= nowS }; val out = mutableListOf<ChartMarker>()
    fun add(s: Sig, label: String, color: Color? = null) {
        if (chart == "spot") out += ChartMarker(s.time, s.ce, color ?: if (s.ce) UP else DOWN, "${if (s.ce) "CE" else "PE"} · $label")
        else if (chart == (if (s.ce) "CE" else "PE")) out += ChartMarker(s.time, true, color ?: if (s.ce) UP else DOWN, "BUY $chart · $label")
    }
    if ("emaCross" in on && spotSec == 300L) crossSignals(done, 9, 21).forEach { add(it, "EMA 9/21", CROSS) }
    if ("ema25" in on && spotSec == 60L) crossSignals(done, 5, 9).forEach { add(it, "EMA 5/9") }
    if ("ema35" in on && spotSec == 60L) crossSignals(done, 3, 5).forEach { add(it, "EMA 3/5") }
    if ("hammer" in on && spotSec == 60L) hammerSignals(spot, spotSec, nowS).forEach { add(it, "Hammer") }
    if ("orb" in on) orbSignals(spot, spotSec, nowS).forEach { s ->
        val side = if (s.ce) "CE" else "PE"
        if (chart == "spot") {
            out += ChartMarker(s.breakoutAt, !s.ce, ORB, "ORB ${if (s.ce) "HIGH" else "LOW"} BREAK", dot = true)
            out += if (s.skip != null) ChartMarker(s.time, s.ce, SKIP, "$side SKIPPED · ${s.skip}", dot = true)
                   else ChartMarker(s.time, s.ce, if (s.ce) UP else DOWN, "$side BUY · 5M ORB")
        } else if (chart == side) {
            out += if (s.skip != null) ChartMarker(s.time, true, SKIP, "SKIPPED $side · ${s.skip}", dot = true)
                   else ChartMarker(s.time, true, if (s.ce) UP else DOWN, "BUY $side · 5M ORB")
        }
    }
    return out
}

/** High / low of the last complete session before today in the candles, or null. */
fun previousDayRange(rows: List<Candle>, nowMs: Long): Pair<Double, Double>? {
    val today = istDay(nowMs / 1000)
    val last = rows.map { istDay(it.time) }.filter { it < today }.maxOrNull() ?: return null
    val day = rows.filter { istDay(it.time) == last }
    return day.maxOf { it.high } to day.minOf { it.low }
}

/** Today's opening range (09:15–09:20 IST) in these candles, or null before 09:20 / without the 09:15 bar. */
fun todaysOpeningRange(rows: List<Candle>, nowMs: Long): Pair<Double, Double>? = openingRanges(rows, nowMs / 1000)[istDay(nowMs / 1000)]
