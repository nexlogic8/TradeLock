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
    /** false: drawn only when inside the bars' own range (OI levels never stretch the chart). */
    val fit: Boolean = true,
    /** Outlined label (coloured text and border on the chart's background) instead of a filled pill. */
    val outlined: Boolean = false,
    /**
     * Broker-style order label at the right end of the line instead of the pill: cells side by side in one bordered box
     * ([TP][SL][ 65 ][ +9.75 INR ][ ✕ ]), as on the web. A cell's `act` is reported by onAction when tapped; "remove"
     * removes the level (onRemove). A draggable level is picked up by the box (any cell without an act).
     */
    val cells: List<LabelCell>? = null,
)

/** One cell of a broker-style level label. */
data class LabelCell(val text: String, val fg: Color, val bg: Color? = null, val act: String? = null)

/** Open interest at one strike, drawn as two bars beside the price axis (calls above, puts below). */
data class OiBar(val price: Double, val ce: Double, val pe: Double)

/** Empty bars kept right of the live bar when the chart opens (and after a double tap). */
private const val LIVE_GAP = -6f

private val TIME =DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.of("Asia/Kolkata"))

/** Price ↔ y of the last frame, and where each level's ✕ was drawn (for touches). */
private class ChartGeometry {
    var hi = 0.0; var lo = 0.0; var top = 0f; var plotBottom = 0f
    val removeHits = mutableListOf<Pair<String, androidx.compose.ui.geometry.Rect>>()
    /** Where a draggable level can be picked up: its label pill and its grip dots. */
    val dragHits = mutableListOf<Pair<String, androidx.compose.ui.geometry.Rect>>()
    /** Tappable cells of broker-style labels (add TP / SL, exit). */
    val actionHits = mutableListOf<Pair<String, androidx.compose.ui.geometry.Rect>>()
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
    /** A tapped label cell's act (ChartLevel.cells): "add-tp", "add-sl", "exit"... */
    onAction: (String) -> Unit = {},
    /** Open interest by strike (the index chart): bars growing left from the price axis. */
    oiBars: List<OiBar> = emptyList(),
    /** Bar length in seconds and the clock now: the time left in the live bar shows under its price tag. */
    intervalSec: Int = 0, nowMs: Long = 0,
    /** Indicators drawn over the candles. */
    studies: List<Study> = Study.DEFAULT,
    /** Strategy signals: arrows and dots on their candles (a marker between candles goes on the next one). */
    markers: List<ChartMarker> = emptyList(),
) {
    val measurer = rememberTextMeasurer()
    var visible by remember { mutableFloatStateOf(60f) }      // bars across the width
    // Bars hidden on the right: 0 = the live bar at the axis; negative = that many empty bars of space after it.
    var scrollBack by remember { mutableFloatStateOf(LIVE_GAP) }
    // Price range set by hand (low, high): null = fit the visible bars. Set by a vertical drag; a double tap clears it.
    var manual by remember { mutableStateOf<Pair<Double, Double>?>(null) }
    var cross by remember { mutableStateOf<Offset?>(null) }
    var drag by remember { mutableStateOf<Pair<String, Double>?>(null) }   // level being dragged → its price now
    val geo = remember { ChartGeometry() }
    val haptic = androidx.compose.ui.platform.LocalHapticFeedback.current
    val currentLevels by androidx.compose.runtime.rememberUpdatedState(levels)
    val move by androidx.compose.runtime.rememberUpdatedState(onMove)
    val remove by androidx.compose.runtime.rememberUpdatedState(onRemove)
    val longPress by androidx.compose.runtime.rememberUpdatedState(onLongPress)
    val action by androidx.compose.runtime.rememberUpdatedState(onAction)
    val latestSize by androidx.compose.runtime.rememberUpdatedState(candles.size)
    val axis = TextStyle(color = Tl.dim, fontSize = 10.sp, fontFamily = FontFamily.Monospace)

    // Indicator lines (the chart's own Indicators list; EMA 9 / 21 by default).
    val lines = remember(candles, studies) { studies.flatMap { computeStudy(it, candles) } }
    val tagged = lines.filter { it.tag }.take(4)

    Canvas(
        modifier.fillMaxWidth().then(if (fill) Modifier.fillMaxHeight() else Modifier.height(height))
            // Two fingers zoom; one finger sideways scrolls the bars, up / down moves the prices, and up / down on the price
            // axis stretches the price scale.
            // (The tap detector consumes every touch-down, so this one does not require an unconsumed down; a level being
            // dragged — set by the inner handler before this one sees the event — keeps it out instead.)
            .pointerInput(Unit) {
                awaitEachGesture {
                    val first = awaitFirstDown(requireUnconsumed = false)
                    if (drag != null) return@awaitEachGesture
                    // On the price axis: up / down stretches or squeezes the price scale.
                    val onAxis = first.position.x > size.width - 58.dp.toPx()
                    var claimed = false
                    var vertical = false
                    var travel = Offset.Zero
                    while (true) {
                        val ev = awaitPointerEvent()
                        if (drag != null) break
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
                                claimed = true
                                vertical = onAxis || kotlin.math.abs(travel.y) > kotlin.math.abs(travel.x)
                            }
                            if (claimed) {
                                cross = null
                                val plotH = (geo.plotBottom - geo.top).coerceAtLeast(1f)
                                val (mLo, mHi) = manual ?: (geo.lo to geo.hi)
                                val range = mHi - mLo
                                when {
                                    // axis: drag down = more price range (candles shrink), up = less (candles grow)
                                    onAxis && range > 0 -> {
                                        val mid = (mHi + mLo) / 2
                                        val half = (range / 2 * kotlin.math.exp(d.y / plotH * 1.6)).coerceIn(mid.coerceAtLeast(1.0) * 0.00002, mid.coerceAtLeast(1.0) * 2)
                                        manual = (mid - half) to (mid + half)
                                    }
                                    // chart, vertical: move the prices up / down (kept until a double tap)
                                    vertical && range > 0 -> { val s = d.y / plotH * range; manual = (mLo + s) to (mHi + s) }
                                    else -> {
                                        val barW = size.width * 0.86f / visible
                                        // free in both directions: back through history, or forward into empty space (up to 60% of the width)
                                        scrollBack = (scrollBack + d.x / barW).coerceIn(-visible * 0.6f, max(0f, latestSize - 10f))
                                    }
                                }
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
                        val act = if (hit == null) geo.actionHits.firstOrNull { it.second.inflate(4.dp.toPx()).contains(p) } else null
                        if (hit != null) { haptic.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress); remove(hit.first) }
                        else if (act != null) { haptic.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress); action(act.first) }
                        else cross = if (cross == null) p else null
                    },
                    // double tap: back to the live bar (with its gap) at the normal zoom
                    onDoubleTap = { cross = null; scrollBack = LIVE_GAP; visible = 60f; manual = null },
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
        val gapBars = max(0f, -scrollBack)                         // empty space right of the live bar
        val start = max(0, end - (visible - gapBars).roundToInt().coerceAtLeast(5))
        val view = candles.subList(start, end)
        val barW = right / visible
        val bodyW = (barW * 0.62f).coerceAtLeast(1.5f)
        var hi = view.maxOf { it.high }; var lo = view.minOf { it.low }
        levels.forEach { if (it.fit && it.price in (lo - (hi - lo)) .. (hi + (hi - lo))) { hi = max(hi, it.price); lo = min(lo, it.price) } }
        val pad = (hi - lo).coerceAtLeast(hi * 0.0005) * 0.08
        hi += pad; lo -= pad
        manual?.let { (a, b) -> lo = a; hi = b }   // the hand-set price range wins over the fit
        val maxVol = view.maxOf { it.volume }.coerceAtLeast(1.0)
        fun x(i: Int) = right - (end - 1 - i + 0.5f + gapBars) * barW
        fun y(p: Double) = (top + (hi - p) / (hi - lo) * (volTop - 6.dp.toPx() - top)).toFloat()
        geo.hi = hi; geo.lo = lo; geo.top = top; geo.plotBottom = volTop - 6.dp.toPx(); geo.removeHits.clear(); geo.dragHits.clear(); geo.actionHits.clear()

        // grid + price labels (a label under the last price / EMA tags is left out)
        val tagYs = buildList {
            add(y(candles.last().close).coerceIn(top, volTop))
            if (scrollBack <= 0.5f) tagged.mapNotNull { it.values.lastOrNull() }.filter { it in lo..hi }.forEach { add(y(it)) }
        }
        val step = niceStep((hi - lo) / 5)
        var g = ceil(lo / step) * step
        while (g <= hi) {
            val yy = y(g)
            drawLine(Tl.line, Offset(0f, yy), Offset(right, yy), 1f, pathEffect = PathEffect.dashPathEffect(floatArrayOf(2f, 6f)))
            if (tagYs.none { kotlin.math.abs(it - yy) < 16.dp.toPx() }) {
                val t = measurer.measure("%.${decimals}f".format(g), axis)
                drawText(t, topLeft = Offset(right + 6.dp.toPx(), yy - t.size.height / 2f))
            }
            g += step
        }
        // time labels: about every 120 dp
        val every = max(1, (120.dp.toPx() / barW).roundToInt())
        for (i in start until end) if ((i - start) % every == 0) {
            val t = measurer.measure(TIME.format(Instant.ofEpochSecond(candles[i].time)), axis)
            drawText(t, topLeft = Offset((x(i) - t.size.width / 2).coerceIn(0f, right - t.size.width), bottom + 3.dp.toPx()))
        }
        // open interest by strike: calls (red) above puts (teal), longest bar = a third of the plot
        if (oiBars.isNotEmpty()) {
            val inView = oiBars.filter { it.price in lo..hi }
            val maxOi = inView.maxOfOrNull { max(it.ce, it.pe) }?.takeIf { it > 0 }
            if (maxOi != null) {
                val gap = if (inView.size > 1) inView.zipWithNext { a, b -> kotlin.math.abs(y(a.price) - y(b.price)) }.min() else 24.dp.toPx()
                val h = (gap * 0.36f).coerceIn(2.dp.toPx(), 9.dp.toPx())
                val maxW = right * 0.3f
                inView.forEach { b ->
                    val yy = y(b.price)
                    val wc = (b.ce / maxOi * maxW).toFloat(); val wp = (b.pe / maxOi * maxW).toFloat()
                    if (wc > 0) drawRect(Tl.red.copy(alpha = 0.32f), Offset(right - wc, yy - h - 0.5f), Size(wc, h))
                    if (wp > 0) drawRect(Tl.mint.copy(alpha = 0.28f), Offset(right - wp, yy + 0.5f), Size(wp, h))
                }
            }
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
            drawRect(col, Offset(cx - bodyW / 2, min(yo, yc)), Size(bodyW, max(1.2f, kotlin.math.abs(yc - yo))))   // square corners
        }
        // indicator lines (a null value breaks the line: Supertrend's two sides)
        lines.forEach { l ->
            val p = Path(); var pen = false
            for (i in start until min(end, l.values.size)) {
                val e = l.values[i]
                if (e == null) { pen = false; continue }
                if (!pen) { p.moveTo(x(i), y(e)); pen = true } else p.lineTo(x(i), y(e))
            }
            drawPath(p, l.color.copy(alpha = 0.9f), style = Stroke(1.6.dp.toPx()))
        }
        // strategy markers: on the first candle at or after the signal's time (same session)
        if (markers.isNotEmpty()) {
            val times = candles.map { it.time }
            markers.forEach { m ->
                var a = 0; var b = times.size
                while (a < b) { val mid = (a + b) / 2; if (times[mid] < m.time) a = mid + 1 else b = mid }
                if (a !in start until end || Math.floorDiv(times[a] + 19_800, 86_400L) != Math.floorDiv(m.time + 19_800, 86_400L)) return@forEach
                val k = candles[a]; val cx = x(a); val s = 5.dp.toPx()
                val yy = if (m.up) y(k.low) + 7.dp.toPx() else y(k.high) - 7.dp.toPx()
                if (m.dot) drawCircle(m.color, 3.5.dp.toPx(), Offset(cx, yy))
                else {
                    val tri = Path().apply {
                        if (m.up) { moveTo(cx, yy - s); lineTo(cx - s, yy + s); lineTo(cx + s, yy + s) } else { moveTo(cx, yy + s); lineTo(cx - s, yy - s); lineTo(cx + s, yy - s) }
                        close()
                    }
                    drawPath(tri, m.color)
                }
                val t = measurer.measure(m.text, axis.copy(color = m.color, fontSize = 8.sp, fontWeight = FontWeight.SemiBold))
                val tx = (cx - t.size.width / 2).coerceIn(0f, right - t.size.width)
                drawText(t, topLeft = Offset(tx, if (m.up) yy + s + 2.dp.toPx() else yy - s - 2.dp.toPx() - t.size.height))
            }
        }
        // the view's highest high and lowest low, marked on their bars
        run {
            val hiI = (start until end).maxByOrNull { candles[it].high } ?: return@run
            val loI = (start until end).minByOrNull { candles[it].low } ?: return@run
            listOf(Triple(hiI, candles[hiI].high, true), Triple(loI, candles[loI].low, false)).forEach { (i, p, isHi) ->
                val cx = x(i); val yy = y(p)
                val t = measurer.measure("%.${decimals}f".format(p), axis.copy(color = Tl.muted))
                val leftSide = cx > right * 0.6f
                val tx = if (leftSide) cx - 8.dp.toPx() - t.size.width else cx + 8.dp.toPx()
                drawCircle(Tl.muted, 2.5.dp.toPx(), Offset(cx, yy))
                drawLine(Tl.muted.copy(alpha = 0.6f), Offset(cx, yy), Offset(if (leftSide) cx - 6.dp.toPx() else cx + 6.dp.toPx(), yy), 1f)
                drawText(t, topLeft = Offset(tx, if (isHi) yy - t.size.height - 1.dp.toPx() else yy + 1.dp.toPx()))
            }
        }
        // levels
        val refLabels = mutableListOf<Float>()   // tops of the reference-level labels drawn so far
        levels.forEach { l0 ->
            val dragging = drag?.first != null && drag?.first == l0.id
            val l = if (dragging) l0.copy(price = drag!!.second) else l0
            if (l.outlined && (l.price < lo || l.price > hi)) {
                // off the chart: a pill on the top / bottom edge pointing to where it is
                val up = l.price > hi
                val ot = measurer.measure("${if (up) "↑" else "↓"} ${l.label} ${"%.0f".format(l.price)}", axis.copy(color = l.color, fontWeight = FontWeight.SemiBold, fontSize = 10.sp))
                val oh = ot.size.height + 6f
                val stack = levels.filter { it.outlined && (if (up) it.price > hi else it.price < lo) }.sortedBy { if (up) it.price else -it.price }.indexOf(l0)
                val yy = if (up) top + oh / 2 + stack * (oh + 3f) else volTop - 8.dp.toPx() - oh / 2 - stack * (oh + 3f)
                val x0 = right - ot.size.width - 18.dp.toPx()   // on the right, clear of the alert / order pills on the left
                drawRoundRect(Tl.bg.copy(alpha = 0.9f), Offset(x0, yy - oh / 2), Size(ot.size.width + 12.dp.toPx(), oh), CornerRadius(7.dp.toPx()))
                drawRoundRect(l.color.copy(alpha = 0.5f), Offset(x0, yy - oh / 2), Size(ot.size.width + 12.dp.toPx(), oh), CornerRadius(7.dp.toPx()), style = Stroke(1.dp.toPx()))
                drawText(ot, topLeft = Offset(x0 + 6.dp.toPx(), yy - ot.size.height / 2f))
                return@forEach
            }
            if (l.price < lo || l.price > hi) return@forEach
            val yy = y(l.price)
            drawLine(l.color, Offset(0f, yy), Offset(right, yy), (if (dragging) 2.5 else 1.5).dp.toPx(), pathEffect = if (l.dashed) PathEffect.dashPathEffect(floatArrayOf(10f, 7f)) else null)
            l.cells?.let { cells ->
                // broker-style box at the right end of the line: cells side by side, one border in the line's colour
                val st = axis.copy(fontWeight = FontWeight.Bold, fontSize = 11.sp, fontFamily = FontFamily.Default)
                val ms = cells.map { c -> measurer.measure(if (dragging && c.act == null && c.bg == l.color) "${c.text} ${"%.${decimals}f".format(l.price)}" else c.text, st.copy(color = c.fg)) }
                val pad = 7.dp.toPx(); val h = 22.dp.toPx(); val ws = ms.map { it.size.width + pad * 2 }
                val x0 = right - 6.dp.toPx() - ws.sum(); var x = x0
                drawRoundRect(Color(0xFF080D15), Offset(x0, yy - h / 2), Size(ws.sum(), h), CornerRadius(5.dp.toPx()))
                cells.forEachIndexed { i, c ->
                    val w = ws[i]
                    c.bg?.let { drawRect(it, Offset(x, yy - h / 2), Size(w, h)) }
                    if (i > 0) drawRect(l.color.copy(alpha = 0.45f), Offset(x, yy - h / 2 + 4), Size(1f, h - 8))
                    drawText(ms[i], topLeft = Offset(x + pad, yy - ms[i].size.height / 2f))
                    val r = androidx.compose.ui.geometry.Rect(x, yy - h / 2 - 4.dp.toPx(), x + w, yy + h / 2 + 4.dp.toPx())
                    when {
                        c.act == "remove" && l.id != null -> geo.removeHits += l.id to r
                        c.act != null -> geo.actionHits += c.act to r
                        l.draggable && l.id != null -> geo.dragHits += l.id to r
                    }
                    x += w
                }
                drawRoundRect(l.color, Offset(x0, yy - h / 2), Size(ws.sum(), h), CornerRadius(5.dp.toPx()), style = Stroke(1.dp.toPx()))
                if (l.draggable && l.id != null) {
                    // grip at the left end: "this line moves"
                    drawRoundRect(l.color, Offset(6.dp.toPx(), yy - 4.dp.toPx()), Size(18.dp.toPx(), 8.dp.toPx()), CornerRadius(4.dp.toPx()))
                    for (k in 0..2) drawCircle(Color(0xFF05121A), 1.2.dp.toPx(), Offset(11.dp.toPx() + k * 4.dp.toPx(), yy))
                    geo.dragHits += l.id to androidx.compose.ui.geometry.Rect(0f, yy - 14.dp.toPx(), 34.dp.toPx(), yy + 14.dp.toPx())
                }
                return@forEach
            }
            val label = if (dragging) "${l.label.substringBefore(' ')} ${"%.${decimals}f".format(l.price)}" else l.label
            val t = measurer.measure(label, axis.copy(color = Color(0xFF0B0F14), fontWeight = FontWeight.Bold))
            val pillH = t.size.height + 8f
            val x0 = 8.dp.toPx()
            val closeW = if (l.removable) 22.dp.toPx() else 0f
            if (l.outlined) {
                // reference levels (OI, OR, previous day): a small label at the right end, moved down when it would cover another
                val ot = measurer.measure(label, axis.copy(color = l.color, fontWeight = FontWeight.SemiBold, fontSize = 9.sp))
                val oh = ot.size.height + 6f; val ow = ot.size.width + 10.dp.toPx()
                val lx = right - ow - 4.dp.toPx()
                var ly = yy - oh / 2
                while (refLabels.any { r -> kotlin.math.abs(r - ly) < oh + 1 }) ly += oh + 1
                refLabels += ly
                drawRoundRect(Tl.bg.copy(alpha = 0.92f), Offset(lx, ly), Size(ow, oh), CornerRadius(6.dp.toPx()))
                drawRoundRect(l.color.copy(alpha = 0.6f), Offset(lx, ly), Size(ow, oh), CornerRadius(6.dp.toPx()), style = Stroke(1.dp.toPx()))
                drawText(ot, topLeft = Offset(lx + 5.dp.toPx(), ly + 3f))
                return@forEach
            }
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
        // EMA values: small tags on the price axis in each line's colour (under the last price tag)
        val tagX = right + 2.dp.toPx(); val tagW = size.width - right - 2.dp.toPx()
        tagged.map { it.values.lastOrNull() to it.color }.forEach { (v, col) ->
            if (v == null || v < lo || v > hi || scrollBack > 0.5f) return@forEach
            val yy = y(v)
            val t = measurer.measure("%.${decimals}f".format(v), axis.copy(color = Color(0xFF0B0F14), fontWeight = FontWeight.Bold, fontSize = 9.sp))
            drawRoundRect(col, Offset(tagX, yy - t.size.height / 2f - 2), Size(tagW, t.size.height + 4f), CornerRadius(4f))
            drawText(t, topLeft = Offset(tagX + 4.dp.toPx(), yy - t.size.height / 2f))
        }
        // last price, with the time left in the live bar under it
        val last = candles.last(); val lc = if (last.close >= last.open) Tl.green else Tl.red
        val ly = y(last.close).coerceIn(top, volTop)
        drawLine(lc.copy(alpha = 0.7f), Offset(0f, ly), Offset(right, ly), 1f, pathEffect = PathEffect.dashPathEffect(floatArrayOf(4f, 4f)))
        val lt = measurer.measure("%.${decimals}f".format(last.close), axis.copy(color = Color.White, fontWeight = FontWeight.Bold, fontSize = 11.sp))
        val left = if (intervalSec > 0 && nowMs > 0) (last.time + intervalSec - nowMs / 1000).takeIf { it in 0..intervalSec.toLong() } else null
        val ct = left?.let { measurer.measure("%02d:%02d".format(it / 60, it % 60), axis.copy(color = Color.White.copy(alpha = 0.85f), fontSize = 9.sp)) }
        val tagH = lt.size.height + 6f + (ct?.size?.height ?: 0)
        drawRoundRect(lc, Offset(tagX, ly - lt.size.height / 2f - 3), Size(tagW, tagH), CornerRadius(5f))
        drawText(lt, topLeft = Offset(right + 6.dp.toPx(), ly - lt.size.height / 2f))
        ct?.let { drawText(it, topLeft = Offset(right + 6.dp.toPx(), ly + lt.size.height / 2f)) }
        // crosshair
        cross?.let { p ->
            val i = (end - 1 - floor((right - p.x) / barW - gapBars).toInt()).coerceIn(start, end - 1)
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
