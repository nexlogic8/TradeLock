package com.nexlogic.tradelock.ui.components

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.nexlogic.tradelock.data.PnlPoint
import com.nexlogic.tradelock.ui.hhmm
import com.nexlogic.tradelock.ui.inr
import com.nexlogic.tradelock.ui.theme.Tl
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.max

/**
 * Intraday P&L after charges, 09:15 → the session end: the curve with a soft fill, zero line, the day's
 * stop-loss and target as dashed lines, and a pulsing dot on the latest value.
 */
@Composable
fun PnlChart(points: List<PnlPoint>, stopLoss: Double?, target: Double?, modifier: Modifier = Modifier) {
    val measurer = rememberTextMeasurer()
    val pulse by rememberInfiniteTransition(label = "pulse").animateFloat(0.25f, 1f, infiniteRepeatable(tween(1100), RepeatMode.Reverse), label = "p")
    val axisStyle = TextStyle(color = Tl.dim, fontSize = 10.sp, fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace)

    // Press and drag (the touch version of hover): a vertical line snaps to the nearest point with its time and P&L.
    var touchX by remember { mutableStateOf<Float?>(null) }
    Canvas(modifier.fillMaxWidth().height(220.dp).pointerInput(Unit) {
        awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false)
            touchX = down.position.x
            do {
                val e = awaitPointerEvent()
                val ch = e.changes.firstOrNull() ?: break
                touchX = ch.position.x
                // A mostly sideways drag reads the chart; a vertical one is left to the page scroll.
                if (abs(ch.position.x - ch.previousPosition.x) > abs(ch.position.y - ch.previousPosition.y)) ch.consume()
            } while (e.changes.any { it.pressed })
            touchX = null
        }
    }) {
        val open = 9 * 60 + 15
        val lastMin = points.lastOrNull()?.minute ?: open
        val close = max(15 * 60 + 30, ceil(lastMin / 30.0).toInt() * 30)
        val values = points.map { it.net }
        // Scale: include zero, the lines in force and the curve, padded; round to a "nice" step.
        val hi0 = listOfNotNull(values.maxOrNull(), target, 0.0).max()
        val lo0 = listOfNotNull(values.minOrNull(), stopLoss?.let { -it }, 0.0).min()
        val span = max(hi0 - lo0, 1000.0)
        val step = niceStep(span / 4)
        val hi = ceil((hi0 + span * 0.08) / step) * step
        val lo = -ceil((-lo0 + span * 0.08) / step) * step

        val left = 44.dp.toPx(); val right = size.width - 8.dp.toPx()
        val top = 8.dp.toPx(); val bottom = size.height - 20.dp.toPx()
        fun x(m: Int) = left + (m - open).toFloat() / (close - open) * (right - left)
        fun y(v: Double) = (bottom - (v - lo) / (hi - lo) * (bottom - top)).toFloat()

        // grid + y labels
        var g = lo
        while (g <= hi + 0.1) {
            val yy = y(g)
            drawLine(if (abs(g) < 0.5) Tl.lineHi else Tl.line, Offset(left, yy), Offset(right, yy), 1f,
                pathEffect = if (abs(g) < 0.5) null else PathEffect.dashPathEffect(floatArrayOf(2f, 6f)))
            val label = if (abs(g) < 0.5) "0" else (if (g < 0) "−" else "") + "₹" + compact(abs(g))
            val t = measurer.measure(label, axisStyle)
            drawText(t, topLeft = Offset(left - t.size.width - 6.dp.toPx(), yy - t.size.height / 2f))
            g += step
        }
        // x labels every 2.5 h
        var m = open
        while (m <= close) {
            val t = measurer.measure(hhmm(m), axisStyle)
            drawText(t, topLeft = Offset((x(m) - t.size.width / 2f).coerceIn(left - 10f, right - t.size.width), bottom + 5.dp.toPx()))
            m += 150
        }
        // stop-loss / target
        val dash = PathEffect.dashPathEffect(floatArrayOf(10f, 8f))
        stopLoss?.let { drawLine(Tl.red.copy(alpha = 0.8f), Offset(left, y(-it)), Offset(right, y(-it)), 2f, pathEffect = dash) }
        target?.let { drawLine(Tl.mint.copy(alpha = 0.8f), Offset(left, y(it)), Offset(right, y(it)), 2f, pathEffect = dash) }

        if (points.isEmpty()) return@Canvas
        val line = Path(); val fill = Path()
        points.forEachIndexed { i, p ->
            val px = x(p.minute); val py = y(p.net)
            if (i == 0) { line.moveTo(px, py); fill.moveTo(px, y(0.0)); fill.lineTo(px, py) } else { line.lineTo(px, py); fill.lineTo(px, py) }
        }
        val last = points.last()
        fill.lineTo(x(last.minute), y(0.0)); fill.close()
        val c = if (last.net >= 0) Tl.mint else Tl.red
        // Two-tone around zero: green above the zero line, red below it (line and fill). The split sits just under zero,
        // so a flat ₹0 stretch stays green and only real losses turn red.
        val f = ((y(0.0) + 1.5.dp.toPx() - y(hi)) / (y(lo) - y(hi))).coerceIn(0f, 1f)
        drawPath(fill, Brush.verticalGradient(0f to Tl.mint.copy(alpha = 0.30f), f to Tl.mint.copy(alpha = 0.02f), f to Tl.red.copy(alpha = 0.02f), 1f to Tl.red.copy(alpha = 0.30f),
            startY = y(hi), endY = y(lo)))
        drawPath(line, Brush.verticalGradient(0f to Tl.mint, f to Tl.mint, f to Tl.red, 1f to Tl.red, startY = y(hi), endY = y(lo)),
            style = Stroke(width = 2.5.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
        val dot = Offset(x(last.minute), y(last.net))
        drawCircle(c.copy(alpha = 0.25f * pulse), radius = 12.dp.toPx(), center = dot)
        drawCircle(c, radius = 4.5.dp.toPx(), center = dot)
        // the latest value beside the dot
        val t = measurer.measure(inr(last.net, sign = true), axisStyle.copy(color = c, fontSize = 11.sp))
        val tx = (dot.x + 10.dp.toPx()).let { if (it + t.size.width > size.width) dot.x - 10.dp.toPx() - t.size.width else it }
        drawText(t, topLeft = Offset(tx, dot.y - t.size.height / 2f))

        touchX?.let { tx0 ->
            val i = points.indices.minBy { abs(x(points[it].minute) - tx0) }
            val p = points[i]; val px = x(p.minute); val py = y(p.net); val pc = if (p.net >= 0) Tl.mint else Tl.red
            drawLine(pc.copy(alpha = 0.7f), Offset(px, top), Offset(px, bottom), 1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(6f, 6f)))
            drawCircle(pc.copy(alpha = 0.22f), radius = 11.dp.toPx(), center = Offset(px, py))
            drawCircle(pc, radius = 5.dp.toPx(), center = Offset(px, py))
            drawCircle(Tl.bg, radius = 5.dp.toPx(), center = Offset(px, py), style = Stroke(2.dp.toPx()))
            // The card: time, then the P&L in its colour, beside the line (left of it near the right edge).
            val t1 = measurer.measure(hhmm(p.minute) + " IST", axisStyle.copy(color = Tl.muted, fontSize = 11.sp))
            val t2 = measurer.measure(inr(p.net, sign = true), axisStyle.copy(color = pc, fontSize = 14.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.Bold))
            val pad = 10.dp.toPx(); val w = max(t1.size.width, t2.size.width) + pad * 2 + 4.dp.toPx(); val h = t1.size.height + t2.size.height + pad * 1.6f
            val cx = if (px + 12.dp.toPx() + w <= size.width) px + 12.dp.toPx() else px - 12.dp.toPx() - w
            val cy = (py - h / 2f).coerceIn(top, bottom - h)
            drawRoundRect(Tl.raised.copy(alpha = 0.96f), Offset(cx, cy), androidx.compose.ui.geometry.Size(w, h), androidx.compose.ui.geometry.CornerRadius(10.dp.toPx()))
            drawRoundRect(Tl.lineHi, Offset(cx, cy), androidx.compose.ui.geometry.Size(w, h), androidx.compose.ui.geometry.CornerRadius(10.dp.toPx()), style = Stroke(1f))
            drawRoundRect(pc, Offset(cx, cy + pad * 0.8f), androidx.compose.ui.geometry.Size(3.dp.toPx(), h - pad * 1.6f), androidx.compose.ui.geometry.CornerRadius(2.dp.toPx()))
            drawText(t1, topLeft = Offset(cx + pad + 4.dp.toPx(), cy + pad * 0.8f))
            drawText(t2, topLeft = Offset(cx + pad + 4.dp.toPx(), cy + pad * 0.8f + t1.size.height))
        }
    }
}

private fun niceStep(raw: Double): Double {
    val steps = doubleArrayOf(500.0, 1000.0, 2000.0, 2500.0, 5000.0, 10000.0, 20000.0, 25000.0, 50000.0, 100000.0, 200000.0, 500000.0)
    return steps.firstOrNull { it >= raw } ?: (ceil(raw / 100000.0) * 100000.0)
}

private fun compact(v: Double): String = when {
    v >= 1e7 -> "%.1fCr".format(v / 1e7).replace(".0", "")
    v >= 1e5 -> "%.1fL".format(v / 1e5).replace(".0", "")
    v >= 1e3 -> "%.0fk".format(v / 1e3)
    else -> "%.0f".format(v)
}
