package com.nexlogic.tradelock.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.nexlogic.tradelock.ui.theme.Tl
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt

/** One bar; time = epoch seconds (start of the bar). */
data class Candle(val time: Long, val open: Double, val high: Double, val low: Double, val close: Double, val volume: Double = 0.0)

/** A horizontal level drawn across the chart (an open position's entry, a price alert…). */
data class ChartLevel(
    val price: Double, val color: Color, val label: String, val dashed: Boolean = true,
    /** Set for a level that can be dragged (and removed with its ✕): TP, SL, a limit order, an alert. */
    val id: String? = null, val draggable: Boolean = false, val removable: Boolean = false,
)

private val TIME = DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.of("Asia/Kolkata"))

/** Price ↔ y of the last frame, and where each level's ✕ was drawn (for touches). */
private class ChartGeometry {
    var hi = 0.0; var lo = 0.0; var top = 0f; var plotBottom = 0f
    val removeHits = mutableListOf<Pair<String, androidx.compose.ui.geometry.Rect>>()
    /** Where a draggable level can be picked up: its label pill and its grip dots. */
    val dragHits = mutableListOf<Pair<String, androidx.compose.ui.geometry.Rect>>()
    fun price(y: Float) = if (plotBottom > top) hi - (y - top) / (plotBottom - top) * (hi - lo) else 0.0
    fun y(p: Double) = (top + (hi - p) / (hi - lo) * (plotBottom - top)).toFloat()
}

/**
 * Native candlestick chart: pinch to zoom, drag to scroll back, tap to show a crosshair with the bar's OHLC.
 * Draws volume, EMA 9 / 21, the last price line with its label, and levels: a draggable level moves with the finger
 * (onMove when let go), its ✕ removes it (onRemove), and a long press anywhere asks for an action at that price.
 */
@Composable
fun CandleChart(
    candles: List<Candle>, modifier: Modifier = Modifier, height: Dp = 240.dp, levels: List<ChartLevel> = emptyList(), decimals: Int = 2,
    /** Take all the height the parent gives (a weighted slot) instead of a fixed height. */
    fill: Boolean = false,
    onMove: (String, Double) -> Unit = { _, _ -> }, onRemove: (String) -> Unit = {}, onLongPress: ((Double) -> Unit)? = null,
) {
    val measurer = rememberTextMeasurer()
    var visible by remember { mutableFloatStateOf(60f) }      // bars across the width
    var scrollBack by remember { mutableFloatStateOf(0f) }    // bars hidden on the right (0 = live edge)
    var cross by remember { mutableStateOf<Offset?>(null) }
    var drag by remember { mutableStateOf<Pair<String, Double>?>(null) }   // level being dragged → its price now
    val geo = remember { ChartGeometry() }
    val haptic = androidx.compose.ui.platform.LocalHapticFeedback.current
    val currentLevels by androidx.compose.runtime.rememberUpdatedState(levels)
    val move by androidx.compose.runtime.rememberUpdatedState(onMove)
    val remove by androidx.compose.runtime.rememberUpdatedState(onRemove)
    val longPress by androidx.compose.runtime.rememberUpdatedState(onLongPress)
    val axis = TextStyle(color = Tl.dim, fontSize = 10.sp, fontFamily = FontFamily.Monospace)

    val ema9 = remember(candles) { ema(candles, 9) }
    val ema21 = remember(candles) { ema(candles, 21) }

    Canvas(
        modifier.fillMaxWidth().then(if (fill) Modifier.fillMaxHeight() else Modifier.height(height))
            // Two fingers zoom; one finger moving sideways scrolls the bars. A vertical swipe is left to the page.
            .pointerInput(candles.size) {
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = true)
                    var claimed = false
                    var travel = Offset.Zero
                    while (true) {
                        val ev = awaitPointerEvent()
                        if (ev.changes.any { it.isConsumed } && !claimed) break
                        val pressed = ev.changes.filter { it.pressed }
                        if (pressed.isEmpty()) break
                        if (pressed.size >= 2) {
                            val a = pressed[0]; val b = pressed[1]
                            val before = (a.previousPosition - b.previousPosition).getDistance()
                            val now = (a.position - b.position).getDistance()
                            if (before > 0f && now > 0f) visible = (visible * before / now).coerceIn(15f, 300f)
                            claimed = true; cross = null
                            ev.changes.forEach { it.consume() }
                        } else {
                            val ch = pressed[0]
                            val d = ch.position - ch.previousPosition
                            travel += d
                            if (!claimed && travel.getDistance() > viewConfiguration.touchSlop) {
                                if (kotlin.math.abs(travel.x) > kotlin.math.abs(travel.y)) claimed = true else break
                            }
                            if (claimed) {
                                cross = null
                                val barW = size.width * 0.86f / visible
                                scrollBack = (scrollBack + d.x / barW).coerceIn(0f, max(0f, candles.size - 10f))
                                ch.consume()
                            }
                        }
                    }
                }
            }
            .pointerInput(Unit) {
                detectTapGestures(
                    onTap = { p ->
                        val hit = geo.removeHits.firstOrNull { it.second.inflate(8.dp.toPx()).contains(p) }
                        if (hit != null) { haptic.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress); remove(hit.first) }
                        else cross = if (cross == null) p else null
                    },
                    onLongPress = { p -> longPress?.let { cb -> haptic.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress); cb(geo.price(p.y)) } },
                )
            }
            // Inner-most handler: claims a touch that starts on a draggable level before zoom / scroll see it.
            .pointerInput(Unit) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    // Picked up only by its label pill or grip dots (not anywhere on the line), so scrolling the page never moves one.
                    if (geo.removeHits.any { h -> h.second.inflate(6.dp.toPx()).contains(down.position) }) return@awaitEachGesture
                    val hitId = geo.dragHits.firstOrNull { h -> h.second.inflate(6.dp.toPx()).contains(down.position) }?.first ?: return@awaitEachGesture
                    val target = currentLevels.firstOrNull { it.id == hitId && it.draggable } ?: return@awaitEachGesture
                    down.consume()
                    haptic.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.TextHandleMove)
                    drag = target.id!! to target.price
                    while (true) {
                        val ev = awaitPointerEvent()
                        val ch = ev.changes.firstOrNull { it.id == down.id } ?: break
                        if (!ch.pressed) break
                        ch.consume()
                        drag = target.id to geo.price(ch.position.y)
                    }
                    val end = drag
                    drag = null
                    if (end != null && kotlin.math.abs(end.second - target.price) > 1e-9) move(end.first, end.second)
                }
            },
    ) {
        val right = size.width - 58.dp.toPx()
        val top = 6.dp.toPx(); val bottom = size.height - 18.dp.toPx()
        val volTop = bottom - (bottom - top) * 0.16f
        if (candles.isEmpty()) {
            val t = measurer.measure("Waiting for candles…", axis.copy(fontSize = 12.sp))
            drawText(t, topLeft = Offset((size.width - t.size.width) / 2, (size.height - t.size.height) / 2)); return@Canvas
        }
        val n = candles.size
        val end = (n - scrollBack).roundToInt().coerceIn(1, n)
        val start = max(0, end - visible.roundToInt())
        val view = candles.subList(start, end)
        val barW = right / visible
        val bodyW = (barW * 0.62f).coerceAtLeast(1.5f)
        var hi = view.maxOf { it.high }; var lo = view.minOf { it.low }
        levels.forEach { if (it.price in (lo - (hi - lo)) .. (hi + (hi - lo))) { hi = max(hi, it.price); lo = min(lo, it.price) } }
        val pad = (hi - lo).coerceAtLeast(hi * 0.0005) * 0.08
        hi += pad; lo -= pad
        val maxVol = view.maxOf { it.volume }.coerceAtLeast(1.0)
        fun x(i: Int) = right - (end - 1 - i + 0.5f) * barW
        fun y(p: Double) = (top + (hi - p) / (hi - lo) * (volTop - 6.dp.toPx() - top)).toFloat()
        geo.hi = hi; geo.lo = lo; geo.top = top; geo.plotBottom = volTop - 6.dp.toPx(); geo.removeHits.clear(); geo.dragHits.clear()

        // grid + price labels
        val step = niceStep((hi - lo) / 5)
        var g = ceil(lo / step) * step
        while (g <= hi) {
            val yy = y(g)
            drawLine(Tl.line, Offset(0f, yy), Offset(right, yy), 1f, pathEffect = PathEffect.dashPathEffect(floatArrayOf(2f, 6f)))
            val t = measurer.measure("%.${decimals}f".format(g), axis)
            drawText(t, topLeft = Offset(right + 6.dp.toPx(), yy - t.size.height / 2f))
            g += step
        }
        // time labels: about every 120 dp
        val every = max(1, (120.dp.toPx() / barW).roundToInt())
        for (i in start until end) if ((i - start) % every == 0) {
            val t = measurer.measure(TIME.format(Instant.ofEpochSecond(candles[i].time)), axis)
            drawText(t, topLeft = Offset((x(i) - t.size.width / 2).coerceIn(0f, right - t.size.width), bottom + 3.dp.toPx()))
        }
        // volume + candles
        for (i in start until end) {
            val c = candles[i]; val up = c.close >= c.open; val col = if (up) Tl.green else Tl.red
            val cx = x(i)
            if (c.volume > 0) {
                val vh = ((c.volume / maxVol) * (bottom - volTop)).toFloat()
                drawRect(col.copy(alpha = 0.22f), Offset(cx - bodyW / 2, bottom - vh), Size(bodyW, vh))
            }
            drawLine(col, Offset(cx, y(c.high)), Offset(cx, y(c.low)), 1.2.dp.toPx())
            val yo = y(c.open); val yc = y(c.close)
            drawRoundRect(col, Offset(cx - bodyW / 2, min(yo, yc)), Size(bodyW, max(1.2f, kotlin.math.abs(yc - yo))), CornerRadius(1.5f))
        }
        // EMA 9 / 21
        fun line(v: List<Double?>, c: Color) {
            val p = Path(); var startedAt = false
            for (i in start until end) { val e = v[i] ?: continue; if (!startedAt) { p.moveTo(x(i), y(e)); startedAt = true } else p.lineTo(x(i), y(e)) }
            drawPath(p, c, style = Stroke(1.6.dp.toPx()))
        }
        line(ema9, Color(0xFF5AA9FF)); line(ema21, Tl.amber.copy(alpha = 0.85f))
        // levels
        levels.forEach { l0 ->
            val dragging = drag?.first != null && drag?.first == l0.id
            val l = if (dragging) l0.copy(price = drag!!.second) else l0
            if (l.price < lo || l.price > hi) return@forEach
            val yy = y(l.price)
            drawLine(l.color, Offset(0f, yy), Offset(right, yy), (if (dragging) 2.5 else 1.5).dp.toPx(), pathEffect = if (l.dashed) PathEffect.dashPathEffect(floatArrayOf(10f, 7f)) else null)
            val label = if (dragging) "${l.label.substringBefore(' ')} ${"%.${decimals}f".format(l.price)}" else l.label
            val t = measurer.measure(label, axis.copy(color = Color(0xFF0B0F14), fontWeight = FontWeight.Bold))
            val pillH = t.size.height + 8f
            val x0 = 8.dp.toPx()
            val closeW = if (l.removable) 22.dp.toPx() else 0f
            drawRoundRect(l.color, Offset(x0, yy - pillH / 2), Size(t.size.width + 14.dp.toPx() + closeW, pillH), CornerRadius(pillH / 2))
            drawText(t, topLeft = Offset(x0 + 7.dp.toPx(), yy - t.size.height / 2f))
            if (l.removable && l.id != null) {
                // the ✕ inside the pill, after a thin divider
                val cx = x0 + t.size.width + 14.dp.toPx() + closeW / 2 - 2.dp.toPx()
                drawLine(Color(0x550B0F14), Offset(cx - closeW / 2 + 1, yy - pillH / 2 + 4), Offset(cx - closeW / 2 + 1, yy + pillH / 2 - 4), 1f)
                val r = 3.5.dp.toPx()
                drawLine(Color(0xFF0B0F14), Offset(cx - r, yy - r), Offset(cx + r, yy + r), 1.8.dp.toPx())
                drawLine(Color(0xFF0B0F14), Offset(cx - r, yy + r), Offset(cx + r, yy - r), 1.8.dp.toPx())
                geo.removeHits += l.id to androidx.compose.ui.geometry.Rect(cx - closeW / 2, yy - pillH / 2, cx + closeW / 2, yy + pillH / 2)
            }
            if (l.draggable) {
                // grip dots on the right end of the line: "this one moves"
                for (k in -1..1) drawCircle(l.color, 2.2.dp.toPx(), Offset(right - 14.dp.toPx() + k * 6.dp.toPx(), yy))
                if (l.id != null) {
                    geo.dragHits += l.id to androidx.compose.ui.geometry.Rect(x0, yy - pillH / 2, x0 + t.size.width + 14.dp.toPx(), yy + pillH / 2)   // the pill (before its ✕)
                    geo.dragHits += l.id to androidx.compose.ui.geometry.Rect(right - 36.dp.toPx(), yy - 14.dp.toPx(), right, yy + 14.dp.toPx())      // the grip
                }
            }
        }
        // last price
        val last = candles.last(); val lc = if (last.close >= last.open) Tl.green else Tl.red
        val ly = y(last.close).coerceIn(top, volTop)
        drawLine(lc.copy(alpha = 0.7f), Offset(0f, ly), Offset(right, ly), 1f, pathEffect = PathEffect.dashPathEffect(floatArrayOf(4f, 4f)))
        val lt = measurer.measure("%.${decimals}f".format(last.close), axis.copy(color = Color.White, fontWeight = FontWeight.Bold))
        drawRoundRect(lc, Offset(right + 2.dp.toPx(), ly - lt.size.height / 2f - 3), Size(size.width - right - 2.dp.toPx(), lt.size.height + 6f), CornerRadius(5f))
        drawText(lt, topLeft = Offset(right + 6.dp.toPx(), ly - lt.size.height / 2f))
        // crosshair
        cross?.let { p ->
            val i = (end - 1 - floor((right - p.x) / barW).toInt()).coerceIn(start, end - 1)
            val c = candles[i]; val cx = x(i)
            drawLine(Tl.muted.copy(alpha = 0.6f), Offset(cx, top), Offset(cx, bottom), 1f)
            drawLine(Tl.muted.copy(alpha = 0.6f), Offset(0f, p.y), Offset(right, p.y), 1f)
            val info = "${TIME.format(Instant.ofEpochSecond(c.time))}  O ${"%.2f".format(c.open)}  H ${"%.2f".format(c.high)}  L ${"%.2f".format(c.low)}  C ${"%.2f".format(c.close)}"
            val t = measurer.measure(info, axis.copy(color = Tl.text))
            drawRoundRect(Tl.raised, Offset(6.dp.toPx(), top), Size(t.size.width + 12.dp.toPx(), t.size.height + 8f), CornerRadius(8f))
            drawText(t, topLeft = Offset(12.dp.toPx(), top + 4f))
        }
    }
}

fun ema(c: List<Candle>, n: Int): List<Double?> {
    if (c.size < n) return List(c.size) { null }
    val k = 2.0 / (n + 1); val out = MutableList<Double?>(c.size) { null }
    var e = c.take(n).sumOf { it.close } / n; out[n - 1] = e
    for (i in n until c.size) { e = c[i].close * k + e * (1 - k); out[i] = e }
    return out
}

private fun niceStep(raw: Double): Double {
    if (raw <= 0) return 1.0
    val mag = 10.0.pow(floor(log10(raw)))
    val f = raw / mag
    return mag * when { f <= 1 -> 1.0; f <= 2 -> 2.0; f <= 2.5 -> 2.5; f <= 5 -> 5.0; else -> 10.0 }
}
