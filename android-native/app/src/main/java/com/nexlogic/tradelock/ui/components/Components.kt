package com.nexlogic.tradelock.ui.components

import androidx.compose.animation.AnimatedContent
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

/** A raised card: soft top light, hairline edge, deep shadow. */
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
            .background(Tl.cardBrush)
            .border(1.dp, Tl.edgeBrush, shape)
            .drawBehind {
                if (accent != null) drawRoundRect(accent, size = size.copy(width = 3.dp.toPx()), cornerRadius = CornerRadius(2.dp.toPx()),
                    topLeft = androidx.compose.ui.geometry.Offset(0f, size.height * 0.18f).let { it }, alpha = 0.95f)
            }
            .padding(padding),
        content = content,
    )
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
        Box(Modifier.offset(x = x).size(knob).shadow(3.dp, CircleShape).clip(CircleShape).background(if (on) Color(0xFF0A1512) else Color(0xFFE8EDF2)))
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
