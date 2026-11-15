package com.nexlogic.tradelock.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.nexlogic.tradelock.data.Api
import com.nexlogic.tradelock.data.ApiError
import com.nexlogic.tradelock.data.AppViewModel
import com.nexlogic.tradelock.data.Session
import com.nexlogic.tradelock.data.arr
import com.nexlogic.tradelock.data.el
import com.nexlogic.tradelock.data.long
import com.nexlogic.tradelock.data.num
import com.nexlogic.tradelock.data.obj
import com.nexlogic.tradelock.data.str
import com.nexlogic.tradelock.ui.components.Eyebrow
import com.nexlogic.tradelock.ui.components.TlCard
import com.nexlogic.tradelock.ui.components.tactile
import com.nexlogic.tradelock.ui.inr
import com.nexlogic.tradelock.ui.theme.Tl
import com.nexlogic.tradelock.ui.theme.TlType
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.LocalDate
import java.time.ZoneId
import kotlin.math.abs
import kotlin.math.max

/** The strategies a phone run can start (the server fills every setting it isn't sent with its defaults). */
private data class BtStrategy(val key: String, val label: String, val history: Boolean, val publicToo: Boolean = false, val extra: Map<String, String> = emptyMap())
private val STRATS = listOf(
    BtStrategy("gap", "Gap open 09:15", true, publicToo = true, extra = mapOf("entryMode" to "open")),
    BtStrategy("gapRetest", "Gap retest 09:15 · paper", true, publicToo = true),
    BtStrategy("ema915", "EMA 9/15 5m · 30°", true),
    BtStrategy("strangle", "CE + PE at a target price", true),
    BtStrategy("overnight", "Overnight ATM CE + PE", true),
    BtStrategy("orb5", "Nifty 5-min ORB", false),
)
private val INDICES = listOf("NIFTY" to "NIFTY 50", "BANKNIFTY" to "BANK NIFTY", "SENSEX" to "SENSEX")
private val RANGES = listOf(1L to "1M", 2L to "2M", 6L to "6M", 12L to "1Y", 60L to "5Y")
private val LABEL = STRATS.associate { it.key to it.label }

/** One scenario's numbers, whichever strategy produced them (gap: best + worst case; others: one summary). */
private data class Scenario(val label: String, val s: JsonObject, val months: List<JsonObject>, val trades: List<JsonObject>)

private fun scenarios(m: JsonObject): List<Scenario> {
    fun sc(label: String, o: JsonObject?) = o?.let {
        Scenario(it.str("label") ?: label, it.obj("summary") ?: it, it.arr("months").mapNotNull { x -> x as? JsonObject }, it.arr("trades").mapNotNull { x -> x as? JsonObject })
    }
    val both = listOfNotNull(sc("Best case", m.obj("best")), sc("Worst case", m.obj("worst")))
    if (both.isNotEmpty()) return both
    val sum = m.obj("optionSummary") ?: m.obj("option") ?: m.obj("summary") ?: m
    return listOf(Scenario("Result", sum, m.arr("months").mapNotNull { it as? JsonObject }, m.arr("trades").mapNotNull { it as? JsonObject }))
}

@Composable
fun BacktestScreen(vm: AppViewModel, onBack: () -> Unit, onOpen: (String) -> Unit) {
    BackHandler { onBack() }
    val session by vm.session.collectAsState()
    val admin = (session as? Session.SignedIn)?.user?.admin == true
    val strats = STRATS.filter { admin || it.publicToo }
    var strategy by remember { mutableStateOf(strats.first()) }
    var index by remember { mutableStateOf("NIFTY") }
    var months by remember { mutableStateOf(1L) }
    var running by remember { mutableStateOf(false) }
    var elapsed by remember { mutableIntStateOf(0) }
    var error by remember { mutableStateOf<String?>(null) }
    var result by remember { mutableStateOf<JsonObject?>(null) }
    var saved by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { runCatching { Api.getList("/scalper/backtest-runs") }.onSuccess { r -> saved = (r["items"] as? JsonArray)?.mapNotNull { it as? JsonObject } ?: emptyList() } }
    LaunchedEffect(running) { elapsed = 0; while (running) { delay(1000); elapsed++ } }

    fun run() {
        if (running) return
        running = true; error = null; result = null
        val end = LocalDate.now(ZoneId.of("Asia/Kolkata"))
        val start = end.minusMonths(months)
        scope.launch {
            try {
                val body = buildJsonObject {
                    put("strategy", if (strategy.key == "gapRetest") "gap" else strategy.key)
                    put("startDate", start.toString()); put("endDate", end.toString())
                    if (strategy.history) put("underlying", index)
                    if (strategy.key == "gapRetest") put("entryMode", "retest")
                    strategy.extra.forEach { (k, v) -> put(k, v) }
                }
                val r = Api.postLong("/scalper/backtest-runs", body)
                result = r
                saved = listOf(r) + saved.filter { it.long("id") != r.long("id") }
            } catch (e: ApiError) { error = e.message }
            running = false
        }
    }

    LazyColumn(Modifier.fillMaxSize().background(Tl.bg).statusBarsPadding().navigationBarsPadding(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(44.dp).tactile(onBack).clip(RoundedCornerShape(14.dp)).background(Tl.surface), contentAlignment = Alignment.Center) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, null, tint = Tl.text) }
                Spacer(Modifier.width(12.dp))
                Text("Backtest", fontSize = 26.sp, fontWeight = FontWeight.ExtraBold, color = Tl.text, modifier = Modifier.weight(1f))
                Text("All settings", style = TlType.label, color = Tl.mint, modifier = Modifier.tactile({ onOpen("backtest?web=1") }).padding(6.dp))
            }
        }
        // ---- what to test ----
        item {
            TlCard(Modifier.fillMaxWidth(), padding = 16.dp) {
                Eyebrow("Strategy")
                Spacer(Modifier.height(8.dp))
                strats.forEach { s ->
                    val on = s == strategy
                    Row(Modifier.fillMaxWidth().padding(vertical = 3.dp).tactile({ strategy = s; result = null; error = null }).clip(RoundedCornerShape(12.dp))
                        .background(if (on) Tl.mint.copy(alpha = 0.12f) else Color.Transparent).padding(horizontal = 12.dp, vertical = 11.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(10.dp).clip(CircleShape).background(if (on) Tl.mint else Tl.lineHi))
                        Spacer(Modifier.width(12.dp))
                        Text(s.label, style = TlType.label, color = if (on) Tl.mint else Tl.text)
                    }
                }
                if (strategy.history) {
                    Spacer(Modifier.height(12.dp)); Eyebrow("Index"); Spacer(Modifier.height(8.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { INDICES.forEach { (k, l) -> BtChip(l, index == k) { index = k; result = null } } }
                }
                Spacer(Modifier.height(12.dp)); Eyebrow("Period · up to today"); Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.horizontalScroll(rememberScrollState())) { RANGES.forEach { (m, l) -> BtChip(l, months == m) { months = m; result = null } } }
                Spacer(Modifier.height(10.dp))
                Text("Runs with the strategy's default settings (as the live strategy). Change capital, stops and timing under All settings.", style = TlType.small, color = Tl.dim)
                Spacer(Modifier.height(14.dp))
                if (running) Row(Modifier.fillMaxWidth().height(54.dp).clip(RoundedCornerShape(16.dp)).background(Tl.surfaceHi), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center) {
                    CircularProgressIndicator(Modifier.size(20.dp), color = Tl.mint, strokeWidth = 2.5.dp); Spacer(Modifier.width(12.dp))
                    Text("Testing… ${elapsed}s", style = TlType.label, color = Tl.mint)
                } else PrimaryButton("Run backtest") { run() }
                error?.let { Spacer(Modifier.height(8.dp)); Text(it, style = TlType.small, color = Tl.red) }
            }
        }
        // ---- the result ----
        result?.let { r -> resultItems(r) }
        // ---- saved runs ----
        if (saved.isNotEmpty()) {
            item { Eyebrow("Saved runs", Modifier.padding(start = 4.dp, top = 8.dp)) }
            saved.take(20).forEach { run ->
                item(key = "run${run.long("id")}") {
                    val sc = scenarios(run.obj("metrics") ?: JsonObject(emptyMap())).first()
                    val net = sc.s.num("net") ?: sc.s.num("totalPnl")
                    Row(Modifier.fillMaxWidth().tactile({ result = run }, haptic = false).clip(RoundedCornerShape(16.dp)).background(if (result?.long("id") == run.long("id")) Tl.surfaceHi else Tl.surface)
                        .padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("#${run.long("id")} · ${LABEL[run.str("strategy")] ?: run.str("strategy")}" + (run.obj("metrics")?.obj("settings")?.str("underlying")?.let { " · $it" } ?: ""), style = TlType.label.copy(fontSize = 14.sp), color = Tl.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text("${run.str("startDate")} → ${run.str("endDate")}", style = TlType.small, color = Tl.muted)
                        }
                        net?.let { Text(big(it, sign = true), style = TlType.num, color = Tl.money(it)) }
                    }
                }
            }
        }
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.resultItems(run: JsonObject) {
    val m = run.obj("metrics") ?: return
    item {
        Row(Modifier.padding(start = 4.dp, top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Eyebrow("Backtest #${run.long("id")} · ${run.str("startDate")} → ${run.str("endDate")}", Modifier.weight(1f))
        }
    }
    m.obj("coverage")?.let { c -> item { Text("History stored ${c.str("from")} → ${c.str("to")}", style = TlType.small, color = Tl.dim, modifier = Modifier.padding(horizontal = 4.dp)) } }
    scenarios(m).forEachIndexed { i, sc ->
        item(key = "sc$i") { ScenarioCard(sc) }
    }
    val trades = scenarios(m).first().trades
    if (trades.isNotEmpty()) {
        item { Eyebrow("Trades · ${trades.size}" + if (scenarios(m).size > 1) " · ${scenarios(m).first().label}" else "", Modifier.padding(start = 4.dp, top = 6.dp)) }
        trades.asReversed().take(100).forEachIndexed { i, t -> item(key = "t$i") { TradeRow(t) } }
    }
}

@Composable
private fun ScenarioCard(sc: Scenario) {
    val s = sc.s
    val net = s.num("net") ?: s.num("totalPnl") ?: s.num("totalPoints")
    TlCard(Modifier.fillMaxWidth(), padding = 18.dp) {
        Text(sc.label, style = TlType.small.copy(fontWeight = FontWeight.SemiBold), color = Tl.muted)
        Spacer(Modifier.height(4.dp))
        net?.let { Text(if (s.num("net") == null && s.num("totalPnl") == null) "%+.2f pts".format(it) else big(it, sign = true), style = TlType.hero, color = Tl.money(it), maxLines = 1) }
        val start = s.num("startCapital") ?: s.num("capital"); val end = s.num("endCapital")
        if (start != null && end != null) Text("${big(start)} → ${big(end)}" + (s.num("returnPct")?.let { " · ${ret(it)}" } ?: ""), style = TlType.num.copy(fontSize = 14.sp), color = Tl.text, maxLines = 1)
        Spacer(Modifier.height(12.dp))
        val facts = listOfNotNull(
            s.num("trades")?.let { "Trades" to "${it.toInt()}" },
            s.num("winRate")?.let { "Win rate" to "%.0f%%".format(if (it <= 1) it * 100 else it) } ?: s.num("wins")?.let { "Wins" to "${it.toInt()}" },
            s.num("maxDrawdownPct")?.let { "Max drawdown" to "%.1f%%".format(it) },
            s.num("charges")?.let { "Charges" to big(it) },
            s.num("averageWin")?.let { "Avg win" to big(it, sign = true) },
            s.num("averageLoss")?.let { "Avg loss" to big(it, sign = true) },
            s.num("stops")?.let { "Stops hit" to "${it.toInt()}" },
            s.num("skipped")?.takeIf { it > 0 }?.let { "Skipped" to "${it.toInt()}" },
        )
        facts.chunked(3).forEach { row ->
            Row(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                row.forEach { (k, v) -> Column(Modifier.weight(1f)) { Text(k, style = TlType.small.copy(fontSize = 11.sp), color = Tl.dim); Text(v, style = TlType.num.copy(fontSize = 14.sp), color = Tl.text, maxLines = 1, overflow = TextOverflow.Ellipsis) } }
                repeat(3 - row.size) { Spacer(Modifier.weight(1f)) }
            }
        }
        if (sc.months.size >= 2) {
            Spacer(Modifier.height(12.dp)); Eyebrow("By month"); Spacer(Modifier.height(8.dp))
            MonthBars(sc.months)
        }
    }
}

/** Net P&L per month as bars, green up / red down from a zero line. */
@Composable
private fun MonthBars(months: List<JsonObject>) {
    val vals = months.map { it.num("net") ?: 0.0 }
    val maxAbs = vals.maxOf { abs(it) }.takeIf { it > 0 } ?: 1.0
    Canvas(Modifier.fillMaxWidth().height(90.dp)) {
        val zero = size.height / 2; val w = size.width / vals.size
        drawLine(Tl.lineHi, Offset(0f, zero), Offset(size.width, zero), 1f)
        vals.forEachIndexed { i, v ->
            val h = (abs(v) / maxAbs * (size.height / 2 - 4)).toFloat()
            val c = if (v >= 0) Tl.green else Tl.red
            drawRect(c.copy(alpha = 0.85f), Offset(i * w + w * 0.18f, if (v >= 0) zero - h else zero), Size(max(2f, w * 0.64f), max(1f, h)))
        }
    }
    Row(Modifier.fillMaxWidth()) {
        Text(months.first().str("month") ?: "", style = TlType.small.copy(fontSize = 10.sp), color = Tl.dim, modifier = Modifier.weight(1f))
        Text(months.last().str("month") ?: "", style = TlType.small.copy(fontSize = 10.sp), color = Tl.dim)
    }
}

@Composable
private fun TradeRow(t: JsonObject) {
    val pnl = t.num("net") ?: t.num("pnl") ?: t.obj("option")?.num("pnl") ?: t.num("points")
    val side = t.str("side") ?: t.str("direction") ?: ""
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Tl.surface).padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text("${t.str("day") ?: ""} · $side" + (t.num("strike")?.let { " ${"%.0f".format(it)}" } ?: ""), style = TlType.label.copy(fontSize = 14.sp), color = if (side.contains("PE")) Tl.red else Tl.text)
            val entry = t.num("entry"); val exit = t.num("exit")
            Text(listOfNotNull(entry?.let { "%.2f".format(it) + (exit?.let { e -> " → %.2f".format(e) } ?: "") }, t.num("lots")?.let { "${it.toInt()} lots" }, t.str("exitReason") ?: t.str("reason")).joinToString(" · "),
                style = TlType.small.copy(fontSize = 11.sp), color = Tl.muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        pnl?.let { Text(big(it, sign = true), style = TlType.num.copy(fontSize = 14.sp), color = Tl.money(it)) }
    }
}

@Composable
private fun BtChip(label: String, on: Boolean, onClick: () -> Unit) =
    Box(Modifier.tactile(onClick).clip(CircleShape).background(if (on) Tl.mint.copy(alpha = 0.14f) else Tl.surfaceHi)
        .border(1.dp, if (on) Tl.mint.copy(alpha = 0.6f) else Tl.lineHi, CircleShape).padding(horizontal = 14.dp, vertical = 8.dp)) {
        Text(label, style = TlType.small.copy(fontWeight = FontWeight.SemiBold, fontSize = 13.sp), color = if (on) Tl.mint else Tl.muted)
    }

/** Money that stays on one line: ₹2,517.73 Cr, ₹14.28 L, else the full amount. */
private fun big(v: Double, sign: Boolean = false): String {
    val a = abs(v); val s = if (v < 0) "−" else if (sign && v > 0) "+" else ""
    return when { a >= 1e7 -> "$s₹%,.2f Cr".format(a / 1e7); a >= 1e5 -> "$s₹%.2f L".format(a / 1e5); else -> inr(v, sign = sign) }
}
/** A return: +54% · or as a multiple once it runs past 1,000%: ×25,178. */
private fun ret(p: Double) = if (abs(p) >= 1000) "×%,.0f".format(1 + p / 100) else "%+.0f%%".format(p)
