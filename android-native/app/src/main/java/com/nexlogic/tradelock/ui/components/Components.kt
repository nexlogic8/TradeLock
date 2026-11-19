package com.nexlogic.tradelock.ui.components

import androidx.compose.ui.unit.IntOffset
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.RowScope
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.Spring
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.scale
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.nexlogic.tradelock.ui.theme.Tl
import com.nexlogic.tradelock.ui.theme.TlType
import kotlinx.coroutines.launch

/**
 * A glass card (the AI Algo Trading look, on every screen): deep gradient fill, a soft light in the top corner and a
 * light gradient edge. [accent] tints the corner light and adds a short bar at the left edge.
 */
@Composable
fun TlCard(
    modifier: Modifier = Modifier,
    shape: Shape = RoundedCornerShape(22.dp),
    accent: Color? = null,
    padding: Dp = 18.dp,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(
        modifier
            .shadow(14.dp, shape, ambientColor = Color.Black, spotColor = Color.Black)
            .clip(shape)
            .background(Tl.glass)
            .drawBehind {
                val glow = (accent ?: Tl.violet).copy(alpha = if (accent != null) 0.14f else 0.07f)
                val r = size.width * 0.7f
                drawCircle(Brush.radialGradient(listOf(glow, Color.Transparent), center = Offset(size.width * 0.15f, 0f), radius = r), radius = r, center = Offset(size.width * 0.15f, 0f))
                if (accent != null) drawRoundRect(accent, size = size.copy(width = 3.dp.toPx(), height = size.height * 0.64f), cornerRadius = CornerRadius(2.dp.toPx()),
                    topLeft = Offset(0f, size.height * 0.18f), alpha = 0.95f)
            }
            .border(1.dp, Tl.edgeOff, shape)
            .padding(padding),
        content = content,
    )
}

/** The screen background: near-black with two faint aurora lights at the top (mint left, violet right). */
fun Modifier.ambient(): Modifier = this.background(Tl.bg).drawBehind {
    val r = size.width * 0.9f
    drawCircle(Brush.radialGradient(listOf(Color(0x162DE0C0), Color.Transparent), center = Offset(0f, 0f), radius = r), radius = r, center = Offset(0f, 0f))
    drawCircle(Brush.radialGradient(listOf(Color(0x12A78BFA), Color.Transparent), center = Offset(size.width, size.height * 0.08f), radius = r), radius = r, center = Offset(size.width, size.height * 0.08f))
}

/** The back key on a page header: a glass square with a gradient edge. */
@Composable
fun BackKey(onBack: () -> Unit) {
    val shape = RoundedCornerShape(14.dp)
    Box(Modifier.size(44.dp).tactile(onBack).clip(shape).background(Tl.glass).border(1.dp, Tl.edgeOff, shape), contentAlignment = Alignment.Center) {
        Icon(Icons.AutoMirrored.Rounded.ArrowBack, "Back", tint = Tl.text)
    }
}

/** Page header: back key (when [onBack]), the aurora title, an optional subtitle, and [trailing] actions on the right. */
@Composable
fun PageHeader(title: String, sub: String? = null, onBack: (() -> Unit)? = null, modifier: Modifier = Modifier, trailing: @Composable RowScope.() -> Unit = {}) {
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        if (onBack != null) { BackKey(onBack); Spacer(Modifier.width(12.dp)) }
        Column(Modifier.weight(1f)) {
            Text(title, style = TlType.page, maxLines = 1, overflow = TextOverflow.Ellipsis)
            sub?.let { Text(it, style = TlType.small, color = Tl.muted, maxLines = 2, overflow = TextOverflow.Ellipsis) }
        }
        trailing()
    }
}

/** A section title with an optional note on the right. */
@Composable
fun SectionHeader(title: String, sub: String? = null, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth().padding(start = 4.dp, end = 4.dp, top = 8.dp), verticalAlignment = Alignment.Bottom) {
        Text(title, style = TlType.title.copy(fontSize = 18.sp), color = Tl.text, modifier = Modifier.weight(1f))
        sub?.let { Text(it, style = TlType.small, color = Tl.dim) }
    }
}

/** A tinted icon tile: gradient fill, tinted edge. */
@Composable
fun IconBadge(icon: ImageVector, c: Color, size: Dp = 42.dp) {
    val shape = RoundedCornerShape(14.dp)
    Box(Modifier.size(size).clip(shape).background(Brush.linearGradient(listOf(c.copy(alpha = 0.28f), c.copy(alpha = 0.06f)))).border(1.dp, c.copy(alpha = 0.35f), shape),
        contentAlignment = Alignment.Center) { Icon(icon, null, tint = c, modifier = Modifier.size(size * 0.5f)) }
}

/** A small capsule label ("PAPER", "LIVE"). */
@Composable
fun TagChip(text: String, c: Color) =
    Text(text, style = TlType.eyebrow.copy(fontSize = 9.sp), color = c, modifier = Modifier.clip(CircleShape).background(c.copy(alpha = 0.14f)).padding(horizontal = 8.dp, vertical = 3.dp))

/** A live dot with an expanding ring while [active]. */
@Composable
fun LivePulse(c: Color, active: Boolean = true) {
    val t = rememberInfiniteTransition(label = "pulse")
    val r by t.animateFloat(1f, 2.4f, infiniteRepeatable(tween(1200), RepeatMode.Restart), label = "r")
    Box(Modifier.size(16.dp), contentAlignment = Alignment.Center) {
        if (active) Canvas(Modifier.fillMaxSize()) { drawCircle(c.copy(alpha = (2.4f - r) / 2.4f * 0.6f), radius = 3.5.dp.toPx() * r) }
        Dot(c, 7.dp)
    }
}

/** A KPI tile: icon + label, a big number, and a footnote. */
@Composable
fun StatTile(label: String, value: String, modifier: Modifier = Modifier, icon: ImageVector? = null, tint: Color = Tl.mint, foot: String? = null, valueColor: Color = Tl.text) {
    val shape = RoundedCornerShape(18.dp)
    Column(modifier.clip(shape).background(Tl.glass).border(1.dp, Tl.edgeOff, shape).padding(14.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (icon != null) { Icon(icon, null, tint = tint, modifier = Modifier.size(14.dp)); Spacer(Modifier.width(6.dp)) }
            Text(label, style = TlType.small, color = Tl.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Spacer(Modifier.height(8.dp))
        Text(value, style = TlType.num.copy(fontSize = 19.sp, fontWeight = FontWeight.Bold), color = valueColor, maxLines = 1)
        foot?.let { Spacer(Modifier.height(3.dp)); Text(it, style = TlType.small.copy(fontSize = 11.sp), color = Tl.dim, maxLines = 1, overflow = TextOverflow.Ellipsis) }
    }
}

@Composable
fun Eyebrow(text: String, modifier: Modifier = Modifier, color: Color = Tl.muted) =
    Text(text.uppercase(), modifier = modifier, style = TlType.eyebrow, color = color, maxLines = 1)

/** Presses in like a physical key (scale + a light haptic tick). */
@Composable
fun Modifier.tactile(onClick: () -> Unit, enabled: Boolean = true, haptic: Boolean = true): Modifier {
    val source = remember { MutableInteractionSource() }
    val pressed by source.collectIsPressedAsState()
    val s by animateFloatAsState(if (pressed) 0.955f else 1f, spring(dampingRatio = 0.55f, stiffness = Spring.StiffnessMedium), label = "press")
    val h = LocalHapticFeedback.current
    return this
        .scale(s)
        .then(Modifier.clickableNoRipple(source, enabled) { if (haptic) h.performHapticFeedback(HapticFeedbackType.TextHandleMove); onClick() })
}

@Composable
private fun Modifier.clickableNoRipple(source: MutableInteractionSource, enabled: Boolean, onClick: () -> Unit) =
    this.then(Modifier.clickable(interactionSource = source, indication = null, enabled = enabled, onClick = onClick))

/** A small pill switch that slides with a spring. */
@Composable
fun PillSwitch(on: Boolean, tint: Color, modifier: Modifier = Modifier, compact: Boolean = false) {
    val w = if (compact) 40.dp else 46.dp
    val h = if (compact) 24.dp else 26.dp
    val knob = h - 6.dp
    val x by animateDpAsState(if (on) w - h else 0.dp, spring(dampingRatio = 0.6f, stiffness = Spring.StiffnessMediumLow), label = "knob")
    val track by animateColorAsState(if (on) tint else Tl.raised, tween(220), label = "track")
    Box(modifier.size(w, h).clip(CircleShape).background(track).border(1.dp, Color(0x22FFFFFF), CircleShape).padding(3.dp)) {
        Box(Modifier.offset { IntOffset(x.roundToPx(), 0) }.size(knob).shadow(3.dp, CircleShape).clip(CircleShape).background(if (on) Color(0xFF0A1512) else Color(0xFFE8EDF2)))
    }
}

/** Header tile with a switch: Protection / Algo. */
@Composable
fun SwitchTile(label: String, icon: ImageVector, on: Boolean, tint: Color, deep: Color, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val bg by animateColorAsState(if (on) deep else Tl.surface, tween(260), label = "tilebg")
    val border by animateColorAsState(if (on) tint.copy(alpha = 0.55f) else Tl.lineHi, tween(260), label = "tileborder")
    val shape = RoundedCornerShape(16.dp)
    Row(
        modifier
            .height(52.dp)
            .tactile(onClick)
            .shadow(8.dp, shape)
            .clip(shape)
            .background(Brush.verticalGradient(listOf(bg.copy(alpha = 0.95f), bg.copy(alpha = 0.7f))))
            .border(1.dp, border, shape)
            .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
    ) {
        Icon(icon, null, tint = if (on) tint else Tl.muted, modifier = Modifier.size(17.dp))
        Spacer(Modifier.width(6.dp))
        Text(label, style = TlType.label.copy(fontSize = 14.5.sp), color = if (on) tint else Tl.muted, maxLines = 1, softWrap = false, modifier = Modifier.weight(1f, fill = false))
        Spacer(Modifier.width(8.dp))
        PillSwitch(on, tint, compact = true)
    }
}

/** Header tile without a switch: Dhan / P&L. */
@Composable
fun ChipTile(modifier: Modifier = Modifier, onClick: () -> Unit, content: @Composable () -> Unit) {
    val shape = RoundedCornerShape(16.dp)
    Row(
        modifier
            .height(52.dp)
            .tactile(onClick)
            .shadow(8.dp, shape)
            .clip(shape)
            .background(Tl.cardBrush)
            .border(1.dp, Tl.lineHi, shape)
            .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
    ) { content() }
}

/**
 * An odometer: each character rolls up (value rising) or down (falling) into place, so live P&L reads as motion,
 * not flicker.
 */
@Composable
fun RollingText(text: String, style: TextStyle, color: Color, modifier: Modifier = Modifier, rising: Boolean = true) {
    Row(modifier) {
        text.forEachIndexed { i, ch ->
            AnimatedContent(
                targetState = ch,
                transitionSpec = {
                    val dir = if (rising) 1 else -1
                    (slideInVertically(tween(220)) { it * dir } + fadeIn(tween(220)))
                        .togetherWith(slideOutVertically(tween(220)) { -it * dir } + fadeOut(tween(160)))
                },
                label = "digit$i",
            ) { c -> Text(c.toString(), style = style, color = color) }
        }
    }
}

/**
 * Hold to confirm: a fill sweeps across while the finger stays down (1.2 s); lifting early cancels.
 * Used for irreversible actions (the kill switch).
 */
@Composable
fun HoldToConfirm(label: String, holdingLabel: String, tint: Color, modifier: Modifier = Modifier, enabled: Boolean = true, onConfirm: () -> Unit) {
    val progress = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    val haptic = LocalHapticFeedback.current
    val shape = RoundedCornerShape(16.dp)
    Box(
        modifier
            .height(54.dp)
            .clip(shape)
            .background(tint.copy(alpha = 0.12f))
            .border(1.dp, tint.copy(alpha = 0.5f), shape)
            .pointerInput(enabled) {
                if (!enabled) return@pointerInput
                awaitEachGesture {
                    awaitFirstDown()
                    haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                    val job = scope.launch {
                        progress.animateTo(1f, tween(1200, easing = LinearEasing))
                        haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                        onConfirm()
                        progress.snapTo(0f)
                    }
                    waitForUpOrCancellation()
                    if (progress.value < 1f) { job.cancel(); scope.launch { progress.animateTo(0f, tween(250)) } }
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.align(Alignment.CenterStart).fillMaxHeight().fillMaxWidth(progress.value).background(tint.copy(alpha = 0.85f)))
        Text(if (progress.value > 0f) holdingLabel else label, style = TlType.label, color = if (progress.value > 0.5f) Color(0xFF14040A) else tint)
    }
}

@Composable
fun Dot(color: Color, size: Dp = 8.dp) = Box(Modifier.size(size).clip(CircleShape).background(color))

@Composable
fun Screen(content: @Composable BoxScope.() -> Unit) = Box(Modifier.fillMaxSize().background(Tl.bg), content = content)

@Composable
fun Divider() = Box(Modifier.fillMaxWidth().height(1.dp).background(Tl.line))

@Composable
fun SectionGap() = Spacer(Modifier.height(14.dp))

@Composable
fun Row2(left: @Composable (Modifier) -> Unit, right: @Composable (Modifier) -> Unit) =
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        left(Modifier.weight(1f)); right(Modifier.weight(1f))
    }

@Composable
fun Padded(content: @Composable ColumnScope.() -> Unit) = Column(Modifier.padding(horizontal = 16.dp), content = content)
