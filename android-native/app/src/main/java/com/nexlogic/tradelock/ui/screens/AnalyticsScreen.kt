package com.nexlogic.tradelock.ui.screens

import com.nexlogic.tradelock.ui.components.ambient
import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material.icons.rounded.Share
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.nexlogic.tradelock.data.Api
import com.nexlogic.tradelock.data.ApiError
import com.nexlogic.tradelock.data.AppViewModel
import com.nexlogic.tradelock.data.arr
import com.nexlogic.tradelock.data.long
import com.nexlogic.tradelock.data.num
import com.nexlogic.tradelock.data.obj
import com.nexlogic.tradelock.data.str
import com.nexlogic.tradelock.ui.components.Eyebrow
import com.nexlogic.tradelock.ui.components.TlCard
import com.nexlogic.tradelock.ui.components.tactile
import com.nexlogic.tradelock.ui.inr
import com.nexlogic.tradelock.ui.paise
import com.nexlogic.tradelock.ui.theme.Tl
import com.nexlogic.tradelock.ui.theme.TlType
import kotlinx.serialization.json.JsonObject
import kotlin.math.max
import kotlin.math.min

@Composable
private fun BackHeader(title: String, onBack: () -> Unit) = Row(verticalAlignment = Alignment.CenterVertically) {
    Box(Modifier.size(44.dp).tactile(onBack).clip(RoundedCornerShape(14.dp)).background(Tl.glass).border(1.dp, Tl.edgeOff, RoundedCornerShape(14.dp)), contentAlignment = Alignment.Center) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, null, tint = Tl.text) }
    Spacer(Modifier.width(12.dp))
    Text(title, style = TlType.page)
}

@Composable
private fun Tile(k: String, v: String, sub: String?, modifier: Modifier, c: Color = Tl.text) = TlCard(modifier, padding = 14.dp, shape = RoundedCornerShape(18.dp)) {
    Text(k, style = TlType.small, color = Tl.muted, maxLines = 1)
    Spacer(Modifier.height(6.dp))
    Text(v, style = TlType.num.copy(fontSize = 19.sp, fontWeight = FontWeight.Bold), color = c, maxLines = 1)
    sub?.let { Text(it, style = TlType.small.copy(fontSize = 11.sp), color = Tl.dim, maxLines = 1) }
}

private fun pct(v: Double?) = v?.let { "${Math.round(it * 100)}%" } ?: "–"

/** The last 20 sessions: net P&L, win rate, rule adherence, limits that fired, and the cumulative curve. */
@Composable
fun AnalyticsScreen(vm: AppViewModel, onBack: () -> Unit) {
    BackHandler { onBack() }
    var d by remember { mutableStateOf<JsonObject?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { try { d = Api.get("/analytics?sessions=20") } catch (e: ApiError) { error = e.message } }

    Column(Modifier.fillMaxSize().ambient().statusBarsPadding().navigationBarsPadding().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        BackHeader("Analytics", onBack)
        val a = d ?: run { Box(Modifier.fillMaxWidth().padding(40.dp), contentAlignment = Alignment.Center) { if (error != null) Text(error!!, color = Tl.red) else CircularProgressIndicator(color = Tl.mint) }; return@Column }
        Text("Last ${a.num("sessions")?.toInt() ?: 0} sessions · ${a.str("from") ?: ""} → ${a.str("to") ?: ""}", style = TlType.small, color = Tl.muted)
        TlCard(Modifier.fillMaxWidth(), padding = 18.dp) {
            Eyebrow("Net P&L")
            val net = a.num("netPnl") ?: 0.0
            Text(inr(net, sign = true), style = TlType.hero, color = Tl.money(net))
            Spacer(Modifier.height(12.dp))
            val series = a.arr("series").mapNotNull { (it as? JsonObject)?.num("cumulative") }
            if (series.size >= 2) {
                val up = series.last() >= 0
                Canvas(Modifier.fillMaxWidth().height(150.dp)) {
                    val hi = max(series.max(), 0.0); val lo = min(series.min(), 0.0); val span = (hi - lo).takeIf { it > 0 } ?: 1.0
                    fun x(i: Int) = i * size.width / (series.size - 1)
                    fun y(v: Double) = ((hi - v) / span * size.height).toFloat()
                    drawLine(Tl.lineHi, Offset(0f, y(0.0)), Offset(size.width, y(0.0)), 1f)
                    val p = Path(); val f = Path()
                    series.forEachIndexed { i, v -> if (i == 0) { p.moveTo(x(i), y(v)); f.moveTo(x(i), y(0.0)); f.lineTo(x(i), y(v)) } else { p.lineTo(x(i), y(v)); f.lineTo(x(i), y(v)) } }
                    f.lineTo(x(series.lastIndex), y(0.0)); f.close()
                    val c = if (up) Tl.mint else Tl.red
                    drawPath(f, Brush.verticalGradient(listOf(c.copy(alpha = 0.25f), Color.Transparent)))
                    drawPath(p, c, style = Stroke(2.5.dp.toPx()))
                    drawCircle(c, 4.dp.toPx(), Offset(x(series.lastIndex), y(series.last())))
                }
                Text("Cumulative P&L, session by session", style = TlType.small, color = Tl.dim, modifier = Modifier.padding(top = 6.dp))
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Tile("Win rate", pct(a.num("winRate")), "${a.num("wins")?.toInt() ?: 0} of ${a.num("trades")?.toInt() ?: 0} trades", Modifier.weight(1f))
            Tile("Rules kept", pct(a.num("adherence")), "Sessions with no limit crossed", Modifier.weight(1f), Tl.mint)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Tile("Limits fired", "${a.num("limitsTriggered")?.toInt() ?: 0}", "TradeLock stepped in", Modifier.weight(1f), Tl.amber)
            Tile("Overtrading stopped", "${a.num("overtradingDaysAvoided")?.toInt() ?: 0}", "Days an order was blocked", Modifier.weight(1f))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Tile("Worst day", a.obj("worstDay")?.num("pnl")?.let { inr(it, sign = true) } ?: "–", a.obj("worstDay")?.str("day"), Modifier.weight(1f), Tl.red)
            Tile("Average loss day", a.num("avgLossDay")?.let { inr(it, sign = true) } ?: "–", null, Modifier.weight(1f), Tl.red)
        }
        Tile("Broker watch uptime", pct(a.num("uptime")), "Successful syncs with your broker", Modifier.fillMaxWidth())
    }
}

/** Refer & earn: your link, how many joined, and what it has earned. */
@Composable
fun AffiliateScreen(vm: AppViewModel, onBack: () -> Unit) {
    BackHandler { onBack() }
    var d by remember { mutableStateOf<JsonObject?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    val ctx = LocalContext.current
    val clip = LocalClipboardManager.current
    LaunchedEffect(Unit) { try { d = Api.get("/affiliate") } catch (e: ApiError) { error = e.message } }

    Column(Modifier.fillMaxSize().ambient().statusBarsPadding().navigationBarsPadding().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        BackHeader("Refer & earn", onBack)
        val a = d ?: run { Box(Modifier.fillMaxWidth().padding(40.dp), contentAlignment = Alignment.Center) { if (error != null) Text(error!!, color = Tl.red) else CircularProgressIndicator(color = Tl.mint) }; return@Column }
        val link = a.str("link") ?: ""
        Column(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(26.dp)).background(Brush.linearGradient(listOf(Color(0xFF0F3D35), Color(0xFF121826))))
                .border(1.dp, Tl.mint.copy(alpha = 0.25f), RoundedCornerShape(26.dp)).padding(22.dp),
        ) {
            Eyebrow("Your code", color = Tl.mint.copy(alpha = 0.8f))
            Text(a.str("code") ?: "", fontSize = 34.sp, fontWeight = FontWeight.Black, fontFamily = FontFamily.Monospace, color = Tl.text, letterSpacing = 2.sp)
            Spacer(Modifier.height(6.dp))
            Text("Earn ${paise(a.long("commissionPerPayment"))} every time a trader you refer pays for a month. It goes straight to your wallet.", style = TlType.body, color = Tl.muted)
            Spacer(Modifier.height(16.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(Modifier.weight(1f).height(52.dp).tactile({
                    ctx.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT,
                        "I use TradeLock to keep my trading disciplined: limits enforced at my broker. Join with my link: $link"), "Share your link"))
                }).clip(RoundedCornerShape(16.dp)).background(Tl.mintBrush), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center) {
                    Icon(Icons.Rounded.Share, null, tint = Color(0xFF04261F)); Spacer(Modifier.width(8.dp)); Text("Share", color = Color(0xFF04261F), fontWeight = FontWeight.Bold)
                }
                Row(Modifier.weight(1f).height(52.dp).tactile({ clip.setText(AnnotatedString(link)); vm.toast("Link copied.") }).clip(RoundedCornerShape(16.dp)).background(Tl.surfaceHi),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center) {
                    Icon(Icons.Rounded.ContentCopy, null, tint = Tl.mint); Spacer(Modifier.width(8.dp)); Text("Copy link", style = TlType.label, color = Tl.mint)
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Tile("Link clicks", "${a.num("clicks")?.toInt() ?: 0}", null, Modifier.weight(1f))
            Tile("On trial", "${a.num("trials")?.toInt() ?: 0}", null, Modifier.weight(1f))
            Tile("Paying", "${a.num("activeSubscribers")?.toInt() ?: 0}", null, Modifier.weight(1f), Tl.mint)
        }
        Tile("Earned so far", paise(a.long("walletCredited")), "Credited to your TradeLock wallet", Modifier.fillMaxWidth(), Tl.green)
        val refs = a.arr("referrals").mapNotNull { it as? JsonObject }
        if (refs.isNotEmpty()) {
            Eyebrow("Who joined", Modifier.padding(start = 4.dp, top = 4.dp))
            refs.forEach { r ->
                Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Tl.surface).padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(r.str("name") ?: "", style = TlType.label, color = Tl.text, modifier = Modifier.weight(1f))
                    val st = r.str("status") ?: ""
                    Text(st.uppercase(), style = TlType.eyebrow.copy(fontSize = 10.sp), color = if (st == "active") Tl.mint else Tl.amber,
                        modifier = Modifier.clip(CircleShape).background((if (st == "active") Tl.mint else Tl.amber).copy(alpha = 0.12f)).padding(horizontal = 8.dp, vertical = 4.dp))
                }
            }
        }
    }
}
