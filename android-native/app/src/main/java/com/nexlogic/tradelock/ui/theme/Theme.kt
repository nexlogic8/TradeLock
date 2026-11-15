package com.nexlogic.tradelock.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/** TradeLock's dark, premium palette: near-black layers, one mint accent, amber for Algo, red / green only for money. */
object Tl {
    val bg = Color(0xFF06080C)
    val surface = Color(0xFF0D1117)
    val surfaceHi = Color(0xFF141A23)
    val raised = Color(0xFF1A212C)
    val line = Color(0xFF1E2631)
    val lineHi = Color(0xFF2A3442)
    val text = Color(0xFFF2F5F8)
    val muted = Color(0xFF8E98A8)
    val dim = Color(0xFF5D6777)
    val mint = Color(0xFF2DE0C0)
    val mintDeep = Color(0xFF0B4F45)
    val amber = Color(0xFFFFBA52)
    val amberDeep = Color(0xFF4A3410)
    val red = Color(0xFFFF5C7A)
    val green = Color(0xFF2BD67B)
    val violet = Color(0xFFA78BFA)

    /** Card fill: a faint top light, like a surface catching light from above. */
    val cardBrush = Brush.verticalGradient(listOf(Color(0xFF151B24), Color(0xFF0D1117)))
    val edgeBrush = Brush.verticalGradient(listOf(Color(0x33FFFFFF), Color(0x08FFFFFF)))
    val mintBrush = Brush.verticalGradient(listOf(Color(0xFF4BF0D2), Color(0xFF1FC7A8)))

    fun money(v: Double): Color = if (v > 0.004) green else if (v < -0.004) red else text
}

private val Num = FontFamily.Monospace

object TlType {
    val hero = TextStyle(fontFamily = Num, fontWeight = FontWeight.Bold, fontSize = 34.sp, letterSpacing = (-0.5).sp)
    val big = TextStyle(fontFamily = Num, fontWeight = FontWeight.Bold, fontSize = 24.sp, letterSpacing = (-0.3).sp)
    val num = TextStyle(fontFamily = Num, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
    val numSm = TextStyle(fontFamily = Num, fontWeight = FontWeight.Medium, fontSize = 12.sp)
    val title = TextStyle(fontWeight = FontWeight.Bold, fontSize = 20.sp, letterSpacing = (-0.2).sp)
    val label = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
    val body = TextStyle(fontWeight = FontWeight.Normal, fontSize = 14.sp, lineHeight = 20.sp)
    val small = TextStyle(fontWeight = FontWeight.Normal, fontSize = 12.sp, lineHeight = 16.sp)
    /** Small spaced capitals: "TODAY'S P&L". */
    val eyebrow = TextStyle(fontWeight = FontWeight.Bold, fontSize = 11.sp, letterSpacing = 1.6.sp)
}

@Composable
fun TradeLockTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = Tl.mint, onPrimary = Color(0xFF032A23),
            secondary = Tl.amber, background = Tl.bg, onBackground = Tl.text,
            surface = Tl.surface, onSurface = Tl.text, surfaceVariant = Tl.surfaceHi, onSurfaceVariant = Tl.muted,
            outline = Tl.line, error = Tl.red,
        ),
        content = content,
    )
}
