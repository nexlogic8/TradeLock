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

    Canvas(modifier.fillMaxWidth().height(220.dp)) {
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
        val up = last.net >= 0
        val c = if (up) Tl.mint else Tl.red
        drawPath(fill, Brush.verticalGradient(
            if (up) listOf(c.copy(alpha = 0.28f), c.copy(alpha = 0.0f)) else listOf(c.copy(alpha = 0.0f), c.copy(alpha = 0.28f)),
            startY = if (up) y(hi) else y(0.0), endY = if (up) y(0.0) else y(lo)))
        drawPath(line, c, style = Stroke(width = 2.5.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
        val dot = Offset(x(last.minute), y(last.net))
        drawCircle(c.copy(alpha = 0.25f * pulse), radius = 12.dp.toPx(), center = dot)
        drawCircle(c, radius = 4.5.dp.toPx(), center = dot)
        // the latest value beside the dot
        val t = measurer.measure(inr(last.net, sign = true), axisStyle.copy(color = c, fontSize = 11.sp))
        val tx = (dot.x + 10.dp.toPx()).let { if (it + t.size.width > size.width) dot.x - 10.dp.toPx() - t.size.width else it }
        drawText(t, topLeft = Offset(tx, dot.y - t.size.height / 2f))
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
