package com.nexlogic.tradelock.ui.screens

import com.nexlogic.tradelock.ui.components.ambient
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ShowChart
import androidx.compose.material.icons.rounded.AutoAwesome
import androidx.compose.material.icons.rounded.Bolt
import androidx.compose.material.icons.rounded.CallSplit
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.CropFree
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.Shield
import androidx.compose.material.icons.rounded.Speed
import androidx.compose.material.icons.rounded.Timeline
import androidx.compose.material.icons.rounded.Tune
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.nexlogic.tradelock.data.Api
import com.nexlogic.tradelock.data.ApiError
import com.nexlogic.tradelock.data.AppViewModel
import com.nexlogic.tradelock.data.Session
import com.nexlogic.tradelock.data.Toast
import com.nexlogic.tradelock.data.arr
import com.nexlogic.tradelock.data.bool
import com.nexlogic.tradelock.data.long
import com.nexlogic.tradelock.data.num
import com.nexlogic.tradelock.data.obj
import com.nexlogic.tradelock.data.str
import com.nexlogic.tradelock.ui.components.Dot
import com.nexlogic.tradelock.ui.components.PillSwitch
import com.nexlogic.tradelock.ui.components.tactile
import com.nexlogic.tradelock.ui.inr
import com.nexlogic.tradelock.ui.theme.Tl
import com.nexlogic.tradelock.ui.theme.TlType
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val INDICES = listOf("NIFTY" to "NIFTY 50", "BANKNIFTY" to "BANK NIFTY", "SENSEX" to "SENSEX")
private val LIVE = setOf("placing", "open", "closing")
private val ICE = Color(0xFF5AA9FF)
private val STATUS = mapOf("open" to ("Open" to Tl.mint), "closing" to ("Exiting" to ICE), "closed" to ("Closed" to Tl.muted),
    "skipped" to ("Skipped" to Tl.amber), "failed" to ("Failed" to Tl.red), "placing" to ("Placing" to ICE))
private val HHMMSS = DateTimeFormatter.ofPattern("HH:mm:ss").withZone(ZoneId.of("Asia/Kolkata"))

// The futuristic accents: amber (Algo) → violet → mint, on glass cards with a thin glowing edge.
private val AURORA = Brush.linearGradient(listOf(Color(0xFFFFC46B), Color(0xFFB794FF), Color(0xFF3DF2D0)))
private val GLASS = Brush.verticalGradient(listOf(Color(0xFF161D28), Color(0xFF0C1016)))
private val EDGE_ON = Brush.linearGradient(listOf(Color(0xCCFFBA52), Color(0x66A78BFA), Color(0x332DE0C0)))
private val EDGE_OFF = Brush.linearGradient(listOf(Color(0x33FFFFFF), Color(0x0FFFFFFF)))

/** Each strategy's look, short description and settings kind (server: scalper/algo-grid.js GRID_STRATEGIES). */
private data class StratInfo(val icon: ImageVector, val accent: Color, val tag: String, val timeframe: String, val settings: Boolean)
private val INFO = mapOf(
    "gap" to StratInfo(Icons.Rounded.Bolt, Color(0xFFFFBA52), "Opening gap · full capital", "1-minute", true),
    "strangle" to StratInfo(Icons.Rounded.CallSplit, Color(0xFFA78BFA), "Both sides daily · cheap far options", "1-minute", true),
    "orb" to StratInfo(Icons.Rounded.CropFree, Color(0xFF2DE0C0), "Opening-range breakout", "5-minute", false),
    "ema59" to StratInfo(Icons.AutoMirrored.Rounded.ShowChart, ICE, "Fast trend change", "1-minute", false),
    "ema915" to StratInfo(Icons.Rounded.Timeline, Color(0xFFFF7EB6), "Steep trend change · 30°", "5-minute", false),
)

/** How each strategy trades (the same rules as the website's Strategy page, shortened). */
private val RULES = mapOf(
    "gap" to listOf(
        "Signal" to "On the first tick after 09:15:00, the ATM CE or PE whose premium opened above its previous close (gap up) is bought. Both or neither gapped up: no trade. Or decide from the index pre-open (09:00–09:08).",
        "Entry" to "The ITM2 option (ITM3 with pre-open) of the nearest expiry, sized from this index's capital, within your funds and Risk rules capital per trade.",
        "Stop-loss" to "Its own stop % (of capital, or of the premium with fixed lots), placed at Dhan. At 0 the day's stop-loss left from your Risk rules sets it.",
        "Exit" to "At market at 09:16:00 (when Exit at 09:16 is on), or the stop-loss, or your cutoff. Cost to cost at 1R moves the stop to the entry.",
    ),
    "strangle" to listOf(
        "Entry" to "Every trading day from the entry time: buys BOTH the call and the put whose price is nearest the target, within the price band, out of the money, of the nearest expiry.",
        "Size" to "Equal lots of both, from this index's capital, within your Risk rules capital per trade and the max % of the thinner option's volume.",
        "Stop" to "Each option on its own: sold once a completed 1-minute candle closes the stop % below its entry. The other keeps running.",
        "Exit" to "Whatever is open is sold at the exit time, or at your Risk rules cutoff when that is earlier.",
    ),
    "orb" to listOf(
        "Opening range" to "High and low of the 09:15–09:20 index 5-minute candle.",
        "Breakout" to "A 5-minute candle closes beyond the range, the next one confirms it (green/red with a 30% body), RSI 14 between 25 and 75 and EMA 9 vs 21 agree.",
        "Entry" to "Market buy right after the confirming candle closes. Several trades a day.",
        "Stop-loss" to "1 tick below the low of the option's own 5-minute breakout candle, placed at Dhan.",
    ),
    "ema59" to listOf(
        "Signal" to "A completed 1-minute index candle where EMA 5 crosses above EMA 9 (CE) or below it (PE).",
        "Entry" to "Market buy of the ATM option of the next expiry right after that candle closes.",
        "Stop-loss" to "1 tick below the low of the option's own 1-minute crossover candle, placed at Dhan.",
        "Exit" to "The opposite crossover, the stop-loss or the cutoff.",
    ),
    "ema915" to listOf(
        "Signal" to "EMA 9 crosses EMA 15 on completed 5-minute index candles, with EMA 9 moving at 30° or steeper (its change ÷ ATR 14).",
        "Entry" to "Market buy of the ATM option on the first candle of the new trend that reaches 30° (up to 3 candles after the cross).",
        "Stop-loss" to "1 tick below the low of the option's own 5-minute signal candle, placed at Dhan.",
        "Exit" to "After the first opposite-colour 5-minute candle, the stop-loss or the cutoff.",
    ),
)
private val PUBLIC_GAP = listOf(
    "What it does" to "Trades the market open, at most once a day, fully automatically on your Dhan account.",
    "Stop-loss" to "Set from these settings or your Risk rules, and placed at your broker with every entry.",
    "Exit" to "Closed automatically by the strategy, by the stop-loss, or at your cutoff.",
)
private val STRANGLE_TARGETS = mapOf("NIFTY" to 4.0, "BANKNIFTY" to 20.0, "SENSEX" to 100.0)

private enum class AlgoAsk { None, Start, Locked }

@Composable
fun AlgoScreen(vm: AppViewModel, bottomPad: PaddingValues, onOpen: (String) -> Unit) {
    val session by vm.session.collectAsState()
    val dash by vm.dash.collectAsState()
    val admin = (session as? Session.SignedIn)?.user?.admin == true
    var data by remember { mutableStateOf<JsonObject?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var ask by remember { mutableStateOf(AlgoAsk.None) }
    var busyCell by remember { mutableStateOf<String?>(null) }
    var sheetFor by remember { mutableStateOf<String?>(null) }   // the strategy whose settings sheet is open
    val scope = rememberCoroutineScope()

    suspend fun load() { try { data = Api.get("/algo/live"); error = null } catch (e: ApiError) { error = e.message } }
    LaunchedEffect(Unit) { while (isActive) { load(); delay(15_000) } }
    // Follow the header switch at once.
    LaunchedEffect(dash?.broker?.algoOn) { if (data != null) load() }

    val d = data
    val a = d?.obj("account")
    val running = a?.bool("algoOn") == true
    val paper = a?.bool("paperMode") == true
    val ready = d?.bool("ready") == true
    val marketOpen = d?.bool("marketOpen") == true
    val trades = d?.arr("trades")?.mapNotNull { it as? JsonObject } ?: emptyList()

    fun toggleAlgo() {
        if (a == null) return
        if (running) { if (dash?.algoLocked == true) ask = AlgoAsk.Locked else { vm.setAlgo(false); scope.launch { delay(800); load() } } }
        else ask = AlgoAsk.Start
    }
    fun setPaper(on: Boolean) {
        val id = a?.str("id") ?: return
        if (on == paper) return
        scope.launch {
            try { Api.post("/brokers/$id/paper", buildJsonObject { put("on", on) }); load(); vm.toast(if (on) "Paper trading: no orders go to Dhan." else "Real trading: orders go to your Dhan account.", if (on) Toast.Tone.Ok else Toast.Tone.Warn) }
            catch (e: ApiError) { vm.toast(e.message, Toast.Tone.Error) }
        }
    }
    fun toggleCell(g: String, u: String, on: Boolean) {
        val id = a?.str("id") ?: return
        busyCell = "$g|$u"
        scope.launch {
            try { Api.post("/brokers/$id/algo-grid", buildJsonObject { put("strategy", g); put("index", u); put("on", on) }); load() }
            catch (e: ApiError) { vm.toast(e.message, Toast.Tone.Error) }
            busyCell = null
        }
    }

    LazyColumn(
        Modifier.fillMaxSize().ambient().statusBarsPadding(),
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 12.dp, bottom = bottomPad.calculateBottomPadding() + 24.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        item {
            Column(Modifier.padding(top = 6.dp, start = 2.dp)) {
                Text("AI Algo Trading", style = TextStyle(brush = AURORA, fontSize = 30.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = (-0.5).sp))
                Text("Automatic index option entries, guarded by your Risk rules", style = TlType.body, color = Tl.muted)
            }
        }
        if (d == null) {
            item { Box(Modifier.fillMaxWidth().padding(48.dp), contentAlignment = Alignment.Center) { if (error != null) Text(error!!, color = Tl.red, style = TlType.body) else CircularProgressIndicator(color = Tl.amber) } }
            return@LazyColumn
        }

        // ---- the core: state, Paper | Real, Start / Stop ----
        item {
            val on = activeStrategies(a)
            Glass(glow = running) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    AiCore(running = running, live = running && marketOpen)
                    Spacer(Modifier.width(16.dp))
                    Column(Modifier.weight(1f)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            val tint = if (running) Tl.amber else if (ready) Tl.muted else Tl.red
                            Pulse(tint, running)
                            Spacer(Modifier.width(8.dp))
                            Text(when { running && marketOpen -> "RUNNING"; running -> "ARMED"; ready -> "STANDBY"; else -> "SETUP NEEDED" }, style = TlType.eyebrow, color = tint)
                            if (paper) { Spacer(Modifier.width(8.dp)); Tag("PAPER", ICE) }
                        }
                        Spacer(Modifier.height(6.dp))
                        Text(if (running) (if (marketOpen) "Scanning the market" else "Starts at the next open") else if (ready) "No automatic orders" else "Finish the setup below",
                            style = TlType.title.copy(fontSize = 19.sp), color = Tl.text)
                        Spacer(Modifier.height(4.dp))
                        Text(if (on.isEmpty()) "No strategy is switched on yet." else on.joinToString("  ·  "), style = TlType.small, color = Tl.muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
                Spacer(Modifier.height(18.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    ModeSwitch(paper, realAllowed = a?.str("broker") != "paper") { setPaper(it) }
                    Spacer(Modifier.width(12.dp))
                    Box(Modifier.weight(1f)) {
                        when {
                            running -> DangerButton("Stop Algo Trading") { toggleAlgo() }
                            ready -> Box(Modifier.fillMaxWidth().height(54.dp).tactile({ toggleAlgo() }).clip(RoundedCornerShape(16.dp))
                                .background(Brush.horizontalGradient(listOf(Color(0xFFFFC46B), Color(0xFFFF9F43)))), contentAlignment = Alignment.Center) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Icon(Icons.Rounded.AutoAwesome, null, tint = Color(0xFF2A1A02), modifier = Modifier.size(18.dp)); Spacer(Modifier.width(8.dp))
                                    Text("Start Algo Trading", color = Color(0xFF2A1A02), fontWeight = FontWeight.Bold, fontSize = 16.sp)
                                }
                            }
                            else -> GhostButton("Setup needed", Modifier.fillMaxWidth()) { }
                        }
                    }
                }
            }
        }

        // ---- before it can start ----
        val missing = d.arr("readiness").mapNotNull { it as? JsonObject }
        if (missing.any { it.bool("ok") != true }) {
            item {
                Glass {
                    Text("Before it can start", style = TlType.label.copy(fontSize = 16.sp), color = Tl.text)
                    Spacer(Modifier.height(8.dp))
                    missing.forEach { r ->
                        val ok = r.bool("ok") == true
                        Row(Modifier.padding(vertical = 6.dp)) {
                            Icon(if (ok) Icons.Rounded.CheckCircle else Icons.Rounded.ErrorOutline, null, tint = if (ok) Tl.mint else Tl.amber, modifier = Modifier.size(20.dp))
                            Spacer(Modifier.width(10.dp))
                            Column {
                                Text(r.str("label") ?: "", style = TlType.label, color = Tl.text)
                                Text(r.str("detail") ?: "", style = TlType.small, color = Tl.muted)
                            }
                        }
                    }
                }
            }
        }

        // ---- today's numbers ----
        item {
            val b = d.obj("budget"); val r = d.obj("rules")
            val daily = b?.num("daily")?.takeIf { it > 0 }
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Kpi(Icons.Rounded.Shield, Tl.red, "Day stop-loss", daily?.let { inr(it) } ?: "Off",
                        if (daily == null) "Set on Risk rules" else if (b?.str("lossLimitMode") == "percent") "${b.num("lossLimitValue")?.let { trim(it) }}% of ${inr(b.num("capital"))}" else "Whole account", Modifier.weight(1f))
                    Kpi(Icons.Rounded.Speed, Tl.amber, "SL left · next trade", daily?.let { inr(b?.num("left")) } ?: "Off", "Today ${inr(b?.num("pnl"), sign = true)}", Modifier.weight(1f),
                        danger = daily != null && (b?.num("left") ?: 0.0) <= 0)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Kpi(Icons.Rounded.Timeline, Tl.mint, "Trades today", "${trades.count { it.num("entryPrice") != null }}", r?.num("tradeCap")?.let { "Cap ${it.toInt()} a day" } ?: "No trade cap", Modifier.weight(1f))
                    Kpi(Icons.Rounded.CheckCircle, Tl.violet, "Square-off", r?.str("squareOff") ?: "–",
                        if (r?.bool("locked") == true) "Account locked today" else if (r?.str("cutoff") != null) "Your cutoff" else "Default", Modifier.weight(1f))
                }
            }
        }

        // ---- strategies ----
        item { SectionTitle("Strategies", "Switch on an index, then tune it") }
        val strategies = a?.arr("gridStrategies")?.mapNotNull { it as? JsonObject }.orEmpty().filter { admin || it.str("key") == "gap" }
        strategies.forEach { s ->
            val g = s.str("key") ?: return@forEach
            item(key = "strat-$g") {
                StrategyCard(g, s, a?.obj("grid")?.obj(g), trades, busyCell, onToggle = { u, on -> toggleCell(g, u, on) }, onSettings = { sheetFor = g })
            }
        }

        // ---- risk rules: one master set (Risk rules), for Manual and Algo trades alike ----
        item {
            Glass(Modifier.tactile({ onOpen("rules") })) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconTile(Icons.Rounded.Shield, Tl.mint)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text("Guarded by your Risk rules", style = TlType.label, color = Tl.text)
                        Text("The same stop-loss, target, trades per day, losing streak and cutoff cover Manual and Algo trades. Tap to change them.", style = TlType.small, color = Tl.muted)
                    }
                }
            }
        }

        // ---- today ----
        item { SectionTitle("Today", if (trades.isEmpty()) null else "${trades.size} signal${if (trades.size == 1) "" else "s"}") }
        if (trades.isEmpty()) item { Text("No automatic trades yet today.", style = TlType.body, color = Tl.dim, modifier = Modifier.padding(horizontal = 4.dp)) }
        trades.forEachIndexed { i, t -> item(key = "t$i") { TradeCard(t, showDay = false) } }

        // ---- history ----
        val history = d.arr("history").mapNotNull { it as? JsonObject }
        if (history.isNotEmpty()) {
            val real = history.filter { it.num("pnl") != null && it.bool("paper") != true }
            val total = real.sumOf { it.num("pnl") ?: 0.0 }
            item {
                Row(Modifier.padding(start = 4.dp, top = 10.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("History", style = TlType.title.copy(fontSize = 18.sp), color = Tl.text, modifier = Modifier.weight(1f))
                    Text("${real.size} trades · ${real.count { (it.num("pnl") ?: 0.0) > 0 }} won · ", style = TlType.small, color = Tl.muted)
                    Text(inr(total, sign = true), style = TlType.numSm, color = Tl.money(total))
                }
            }
            history.take(30).forEachIndexed { i, t -> item(key = "h$i") { TradeCard(t, showDay = true) } }
        }
    }

    sheetFor?.let { g ->
        val s = a?.arr("gridStrategies")?.mapNotNull { it as? JsonObject }?.firstOrNull { it.str("key") == g }
        StrategySheet(g, s?.str("label") ?: s?.str("name") ?: g, a?.obj("grid")?.obj(g), admin, d?.obj("rules")?.str("squareOff"),
            onDismiss = { sheetFor = null },
            onToggle = { u, on -> toggleCell(g, u, on) },
            onSave = { u, cfg ->
                val id = a?.str("id")
                if (id == null) "No broker account." else try {
                    Api.post("/brokers/$id/algo-grid", buildJsonObject { put("strategy", g); put("index", u); put("cfg", cfg) })
                    load(); vm.toast("${s?.str("name") ?: g} · ${INDICES.first { it.first == u }.second} saved."); null
                } catch (e: ApiError) { e.message }
            })
    }

    when (ask) {
        AlgoAsk.None -> Unit
        AlgoAsk.Start -> ConfirmSheet("Start Algo Trading?",
            listOf(if (paper) "Paper: trades fill at live prices with the paper wallet. No order goes to Dhan." else "TradeLock places live orders on your ${dash?.broker?.label ?: "broker"} account automatically.",
                "Once on, it stays on until 15:30 during market hours.", "Your risk rules apply to every automatic trade."),
            "Start Algo Trading", "Not now", danger = false, onDismiss = { ask = AlgoAsk.None }) { ask = AlgoAsk.None; vm.setAlgo(true); scope.launch { delay(800); load() } }
        AlgoAsk.Locked -> ConfirmSheet("Algo Trading stays on until 15:30",
            listOf("It can't be switched off during market hours (09:15–15:30 IST).", "Exits are always allowed: you can close an Algo trade yourself at any time."),
            "Got it", "Close", danger = false, onDismiss = { ask = AlgoAsk.None }) { ask = AlgoAsk.None }
    }
}

private fun trim(v: Double) = if (v % 1.0 == 0.0) v.toLong().toString() else v.toString()

private fun activeStrategies(a: JsonObject?): List<String> {
    val grid = a?.obj("grid") ?: return emptyList()
    val names = a.arr("gridStrategies").mapNotNull { it as? JsonObject }.associate { (it.str("key") ?: "") to (it.str("name") ?: "") }
    return grid.keys.mapNotNull { g ->
        val at = INDICES.filter { grid.obj(g)?.obj(it.first)?.bool("on") == true }.map { it.second }
        if (at.isEmpty()) null else "${names[g] ?: g} (${at.joinToString(", ")})"
    }
}

// ---------------------------------------------------------------- building blocks

/** A glass card: dark gradient, thin edge that glows amber → violet → mint when [glow]. */
@Composable
private fun Glass(modifier: Modifier = Modifier, glow: Boolean = false, content: @Composable () -> Unit) {
    val shape = RoundedCornerShape(22.dp)
    Column(
        modifier.fillMaxWidth().clip(shape).background(GLASS)
            .drawBehind {
                // A soft light in the top corner, stronger while running.
                drawCircle(Brush.radialGradient(listOf((if (glow) Color(0x33FFBA52) else Color(0x14A78BFA)), Color.Transparent), center = Offset(size.width * 0.15f, 0f), radius = size.width * 0.7f),
                    radius = size.width * 0.7f, center = Offset(size.width * 0.15f, 0f))
            }
            .border(1.dp, if (glow) EDGE_ON else EDGE_OFF, shape).padding(18.dp).animateContentSize(),
    ) { content() }
}

/** The animated "AI core": rotating aurora rings while running, a still dim ring when off. */
@Composable
private fun AiCore(running: Boolean, live: Boolean) {
    val t = rememberInfiniteTransition(label = "core")
    val spin by t.animateFloat(0f, 360f, infiniteRepeatable(tween(if (live) 2400 else 6000, easing = LinearEasing)), label = "spin")
    val breathe by t.animateFloat(0.55f, 1f, infiniteRepeatable(tween(1400), RepeatMode.Reverse), label = "breathe")
    Box(Modifier.size(78.dp), contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val w = 4.dp.toPx()
            if (running) {
                drawCircle(Brush.radialGradient(listOf(Color(0x55FFBA52).copy(alpha = 0.35f * breathe), Color.Transparent)), radius = size.minDimension / 2)
                rotate(spin) {
                    drawArc(Brush.sweepGradient(listOf(Color(0x00FFBA52), Color(0xFFFFBA52), Color(0xFFA78BFA), Color(0xFF2DE0C0), Color(0x002DE0C0))),
                        0f, 300f, false, style = Stroke(w, cap = StrokeCap.Round), topLeft = Offset(w, w), size = androidx.compose.ui.geometry.Size(size.width - 2 * w, size.height - 2 * w))
                }
                rotate(-spin * 1.6f) {
                    val inset = 12.dp.toPx()
                    drawArc(Brush.sweepGradient(listOf(Color(0x002DE0C0), Color(0xAA2DE0C0), Color(0x00A78BFA))), 0f, 200f, false,
                        style = Stroke(2.dp.toPx(), cap = StrokeCap.Round), topLeft = Offset(inset, inset), size = androidx.compose.ui.geometry.Size(size.width - 2 * inset, size.height - 2 * inset))
                }
            } else {
                drawCircle(Color(0x22FFFFFF), radius = size.minDimension / 2 - w, style = Stroke(w))
            }
        }
        Box(Modifier.size(42.dp).clip(CircleShape).background(if (running) Brush.radialGradient(listOf(Color(0xFF3A2A10), Color(0xFF161D28))) else Brush.radialGradient(listOf(Tl.raised, Tl.surface))),
            contentAlignment = Alignment.Center) {
            Icon(Icons.Rounded.AutoAwesome, null, tint = if (running) Tl.amber else Tl.dim, modifier = Modifier.size(22.dp))
        }
    }
}

/** A live dot that pulses while [active]. */
@Composable
private fun Pulse(c: Color, active: Boolean) {
    val t = rememberInfiniteTransition(label = "pulse")
    val r by t.animateFloat(1f, 2.4f, infiniteRepeatable(tween(1200), RepeatMode.Restart), label = "r")
    Box(Modifier.size(16.dp), contentAlignment = Alignment.Center) {
        if (active) Canvas(Modifier.fillMaxSize()) { drawCircle(c.copy(alpha = (2.4f - r) / 2.4f * 0.6f), radius = 3.5.dp.toPx() * r) }
        Dot(c, 7.dp)
    }
}

@Composable
private fun SectionTitle(title: String, sub: String?) {
    Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 4.dp, top = 8.dp), verticalAlignment = Alignment.Bottom) {
        Text(title, style = TlType.title.copy(fontSize = 18.sp), color = Tl.text, modifier = Modifier.weight(1f))
        sub?.let { Text(it, style = TlType.small, color = Tl.dim) }
    }
}

@Composable
private fun IconTile(icon: ImageVector, c: Color, size: Int = 42) =
    Box(Modifier.size(size.dp).clip(RoundedCornerShape(14.dp)).background(Brush.linearGradient(listOf(c.copy(alpha = 0.28f), c.copy(alpha = 0.06f))))
        .border(1.dp, c.copy(alpha = 0.35f), RoundedCornerShape(14.dp)), contentAlignment = Alignment.Center) {
        Icon(icon, null, tint = c, modifier = Modifier.size((size * 0.5f).dp))
    }

@Composable
private fun Tag(text: String, c: Color) =
    Text(text, style = TlType.eyebrow.copy(fontSize = 9.sp), color = c, modifier = Modifier.clip(CircleShape).background(c.copy(alpha = 0.14f)).padding(horizontal = 8.dp, vertical = 3.dp))

@Composable
private fun ModeSwitch(paper: Boolean, realAllowed: Boolean, onPick: (Boolean) -> Unit) {
    Row(Modifier.height(54.dp).clip(RoundedCornerShape(16.dp)).background(Tl.surfaceHi).border(1.dp, Tl.line, RoundedCornerShape(16.dp)).padding(4.dp)) {
        listOf(true to "Paper", false to "Real").forEach { (p, label) ->
            val on = p == paper
            val enabled = p || realAllowed
            val bg by animateColorAsState(if (on) Tl.raised else Color.Transparent, tween(200), label = "mode")
            Box(Modifier.fillMaxHeight().width(64.dp).tactile({ if (enabled) onPick(p) }, enabled = enabled).clip(RoundedCornerShape(12.dp)).background(bg),
                contentAlignment = Alignment.Center) { Text(label, style = TlType.label, color = if (on) (if (p) ICE else Tl.amber) else if (enabled) Tl.muted else Tl.dim) }
        }
    }
}

@Composable
private fun Kpi(icon: ImageVector, c: Color, label: String, value: String, foot: String, modifier: Modifier, danger: Boolean = false) {
    val shape = RoundedCornerShape(18.dp)
    Column(modifier.clip(shape).background(GLASS).border(1.dp, EDGE_OFF, shape).padding(14.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, null, tint = c, modifier = Modifier.size(14.dp)); Spacer(Modifier.width(6.dp))
            Text(label, style = TlType.small, color = Tl.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Spacer(Modifier.height(8.dp))
        Text(value, style = TlType.num.copy(fontSize = 19.sp, fontWeight = FontWeight.Bold), color = if (danger) Tl.red else Tl.text, maxLines = 1)
        Spacer(Modifier.height(3.dp))
        Text(foot, style = TlType.small.copy(fontSize = 11.sp), color = Tl.dim, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

// ---------------------------------------------------------------- strategies

/** One strategy: what it is, a switch per index with today's state, a summary of its settings and the Settings button. */
@Composable
private fun StrategyCard(g: String, s: JsonObject, grid: JsonObject?, trades: List<JsonObject>, busyCell: String?, onToggle: (String, Boolean) -> Unit, onSettings: () -> Unit) {
    val info = INFO[g] ?: StratInfo(Icons.Rounded.AutoAwesome, Tl.amber, s.str("label") ?: "", "", false)
    val onAt = INDICES.filter { grid?.obj(it.first)?.bool("on") == true }
    val inTrade = trades.any { it.str("strategy") == s.str("name") && it.str("status") in LIVE }
    Glass(glow = onAt.isNotEmpty()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconTile(info.icon, info.accent, 46)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(s.str("label") ?: s.str("name") ?: g, style = TlType.label.copy(fontSize = 16.sp), color = Tl.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    if (inTrade) { Spacer(Modifier.width(8.dp)); Tag("IN TRADE", Tl.mint) }
                }
                Text("${info.tag} · ${info.timeframe}", style = TlType.small, color = Tl.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        Spacer(Modifier.height(14.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            INDICES.forEach { (u, label) ->
                val on = grid?.obj(u)?.bool("on") == true
                val mine = trades.filter { it.str("strategy") == s.str("name") && (it.str("underlying") ?: "NIFTY") == u }
                val state = when { mine.any { it.str("status") in LIVE } -> "In trade"; mine.any { it.num("entryPrice") != null } -> "Traded"; else -> null }
                IndexChip(label, on, state, busyCell == "$g|$u", info.accent, Modifier.weight(1f)) { onToggle(u, !on) }
            }
        }
        Spacer(Modifier.height(12.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(summary(g, grid, onAt), style = TlType.small, color = Tl.dim, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Spacer(Modifier.width(10.dp))
            Row(Modifier.clip(CircleShape).tactile(onSettings).background(info.accent.copy(alpha = 0.14f)).border(1.dp, info.accent.copy(alpha = 0.4f), CircleShape)
                .padding(horizontal = 14.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Rounded.Tune, null, tint = info.accent, modifier = Modifier.size(16.dp)); Spacer(Modifier.width(6.dp))
                Text("Settings", style = TlType.small.copy(fontWeight = FontWeight.Bold), color = info.accent)
            }
        }
    }
}

/** The settings in one line, for the indices switched on. */
private fun summary(g: String, grid: JsonObject?, onAt: List<Pair<String, String>>): String {
    if (onAt.isEmpty()) return "Off on every index. Tap an index to switch it on."
    return onAt.joinToString("  ·  ") { (u, label) ->
        val c = grid?.obj(u)?.obj("cfg")
        when (g) {
            "gap" -> {
                val lots = c?.num("lots")?.toInt() ?: 0
                val size = when { lots > 0 -> "$lots lot${if (lots > 1) "s" else ""}"; c?.str("capitalMode") == "percent" -> "${trim(c.num("capitalPct") ?: 80.0)}% funds"; (c?.num("capital") ?: 0.0) > 0 -> inr(c?.num("capital")); else -> "Risk rules size" }
                val stop = (c?.num("stopPct") ?: 0.0).let { if (it > 0) "SL ${trim(it)}%" else "SL from day stop" }
                "$label: $size, $stop"
            }
            "strangle" -> "$label: ₹${trim(c?.num("target") ?: STRANGLE_TARGETS[u] ?: 4.0)}, ${c?.str("entry") ?: "09:20"}–${c?.str("exit") ?: "15:25"}"
            else -> label
        }
    }.let { if (g == "gap" || g == "strangle") it else "On: $it · sized by your Risk rules" }
}

@Composable
private fun IndexChip(label: String, on: Boolean, state: String?, busy: Boolean, accent: Color, modifier: Modifier, onClick: () -> Unit) {
    val bg by animateColorAsState(if (on) accent.copy(alpha = 0.16f) else Tl.surfaceHi, tween(220), label = "ic")
    val edge by animateColorAsState(if (on) accent.copy(alpha = 0.7f) else Tl.lineHi, tween(220), label = "ie")
    Column(
        modifier.clip(RoundedCornerShape(14.dp)).tactile(onClick, enabled = !busy).background(bg).border(1.dp, edge, RoundedCornerShape(14.dp)).padding(vertical = 10.dp, horizontal = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(label, style = TlType.small.copy(fontWeight = FontWeight.Bold, fontSize = 12.sp), color = if (on) Tl.text else Tl.muted, maxLines = 1)
        Spacer(Modifier.height(6.dp))
        if (busy) CircularProgressIndicator(color = accent, strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
        else Row(verticalAlignment = Alignment.CenterVertically) {
            if (state == "In trade") { Pulse(Tl.mint, true); Spacer(Modifier.width(2.dp)) }
            Text((state ?: if (on) "ON" else "OFF").uppercase(), style = TlType.eyebrow.copy(fontSize = 9.sp), color = if (state == "In trade") Tl.mint else if (on) accent else Tl.dim)
        }
    }
}

// ---------------------------------------------------------------- settings sheet

/**
 * A strategy's settings for each index (tabs), with that index's on/off switch, and how the strategy trades.
 * Gap and CE + PE have their own settings (saved per index, as on the website); the others are sized by the Risk rules.
 */
@Composable
private fun StrategySheet(g: String, title: String, grid: JsonObject?, admin: Boolean, squareOff: String?, onDismiss: () -> Unit,
                          onToggle: (String, Boolean) -> Unit, onSave: suspend (String, JsonObject) -> String?) = TlSheet(onDismiss) {
    val info = INFO[g] ?: StratInfo(Icons.Rounded.AutoAwesome, Tl.amber, "", "", false)
    var tab by remember { mutableStateOf(if (info.settings) INDICES.firstOrNull { grid?.obj(it.first)?.bool("on") == true }?.first ?: "NIFTY" else "rules") }
    Column(Modifier.heightIn(max = 640.dp).verticalScroll(rememberScrollState())) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconTile(info.icon, info.accent, 44)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(title, style = TlType.title, color = Tl.text)
                Text("${info.tag} · ${info.timeframe}", style = TlType.small, color = Tl.muted)
            }
        }
        Spacer(Modifier.height(16.dp))
        // Tabs: an index each (its settings), and How it works.
        val tabs = (if (info.settings) INDICES.map { it.first to it.second } else emptyList()) + ("rules" to if (info.settings) "How it works" else "How it works")
        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Tl.surfaceHi).padding(4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            tabs.forEach { (k, label) ->
                val sel = k == tab
                val bg by animateColorAsState(if (sel) Tl.raised else Color.Transparent, tween(180), label = "tab")
                val on = grid?.obj(k)?.bool("on") == true
                Row(Modifier.weight(1f).clip(RoundedCornerShape(10.dp)).tactile({ tab = k }).background(bg).padding(vertical = 10.dp),
                    horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                    if (k != "rules") { Dot(if (on) info.accent else Tl.dim, 6.dp); Spacer(Modifier.width(5.dp)) }
                    Text(label.replace("BANK NIFTY", "BANKNIFTY").replace("NIFTY 50", "NIFTY"), style = TlType.small.copy(fontWeight = FontWeight.Bold, fontSize = 11.sp),
                        color = if (sel) Tl.text else Tl.muted, maxLines = 1)
                }
            }
        }
        Spacer(Modifier.height(16.dp))
        if (tab == "rules") {
            if (!info.settings) {
                Text("Sized and protected by your Risk rules: capital per trade, day stop-loss, trades per day and cutoff. Switch it on per index on the card.",
                    style = TlType.body, color = Tl.muted)
                Spacer(Modifier.height(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    INDICES.forEach { (u, label) ->
                        val on = grid?.obj(u)?.bool("on") == true
                        IndexChip(label, on, null, false, info.accent, Modifier.weight(1f)) { onToggle(u, !on) }
                    }
                }
                Spacer(Modifier.height(16.dp))
            }
            val rules = if (admin) RULES[g].orEmpty() else if (g == "gap") PUBLIC_GAP else emptyList()
            rules.forEach { (k, v) ->
                Row(Modifier.padding(vertical = 7.dp)) {
                    Box(Modifier.padding(top = 6.dp).size(6.dp).clip(CircleShape).background(info.accent))
                    Spacer(Modifier.width(10.dp))
                    Column {
                        Text(k, style = TlType.label.copy(fontSize = 14.sp), color = Tl.text)
                        Text(v, style = TlType.small.copy(fontSize = 13.sp, lineHeight = 18.sp), color = Tl.muted)
                    }
                }
            }
        } else {
            val u = tab
            val on = grid?.obj(u)?.bool("on") == true
            ToggleRow("Trade on ${INDICES.first { it.first == u }.second}", if (on) "Switched on: it trades this index." else "Off: settings are kept for when you switch it on.", on, info.accent) { onToggle(u, !on) }
            Spacer(Modifier.height(8.dp))
            val cfg = grid?.obj(u)?.obj("cfg")
            // A new form per index (key), filled from what is saved.
            androidx.compose.runtime.key(u) {
                if (g == "gap") GapForm(u, cfg, squareOff, info.accent, onSave) else StrangleForm(u, cfg, info.accent, onSave)
            }
        }
    }
}

@Composable
private fun GapForm(u: String, c: JsonObject?, squareOff: String?, accent: Color, onSave: suspend (String, JsonObject) -> String?) {
    val f = remember(c) {
        mutableStateMapOf(
            "decide" to (c?.str("decide") ?: "premium"), "lots" to trim(c?.num("lots") ?: 0.0), "capitalMode" to (c?.str("capitalMode") ?: "amount"),
            "capital" to trim(c?.num("capital") ?: 0.0), "capitalPct" to trim(c?.num("capitalPct") ?: 80.0), "stopPct" to trim(c?.num("stopPct") ?: 0.0),
            "costToCost" to (c?.bool("costToCost") ?: true).toString(), "requireGreen" to (c?.bool("requireGreen") ?: false).toString(), "autoExit" to (c?.bool("autoExit") ?: true).toString(),
        )
    }
    val lots = f["lots"]?.toDoubleOrNull()?.toInt() ?: 0
    FormLabel("Decide the side")
    Seg(listOf("premium" to "ATM premium 09:15", "preopen" to "Index pre-open"), f["decide"]!!, accent) { f["decide"] = it }
    NumField("Fixed lots (0 = from capital)", f["lots"]!!) { f["lots"] = it }
    if (lots == 0) {
        FormLabel("Capital")
        Seg(listOf("amount" to "₹ amount", "percent" to "% of funds"), f["capitalMode"]!!, accent) { f["capitalMode"] = it }
        if (f["capitalMode"] == "percent") NumField("Capital % of available funds", f["capitalPct"]!!) { f["capitalPct"] = it }
        else NumField("Capital ₹ (0 = Risk rules / funds)", f["capital"]!!) { f["capital"] = it }
    }
    NumField(if (lots > 0) "Stop-loss % of the premium paid" else "Stop-loss % of capital", f["stopPct"]!!) { f["stopPct"] = it }
    if ((f["stopPct"]?.toDoubleOrNull() ?: 0.0) <= 0) Text("At 0 the stop comes from the day's stop-loss left; with that off, Gap does not trade.", style = TlType.small, color = Tl.amber, modifier = Modifier.padding(vertical = 4.dp))
    Spacer(Modifier.height(6.dp))
    ToggleRow("Cost to cost at 1R", "Moves the stop to the entry once the trade is 1R up.", f["costToCost"] == "true", accent) { f["costToCost"] = (f["costToCost"] != "true").toString() }
    ToggleRow("Premium green first", "Buy only if the premium is green in the first seconds.", f["requireGreen"] == "true", accent) { f["requireGreen"] = (f["requireGreen"] != "true").toString() }
    ToggleRow("Exit at 09:16", if (f["autoExit"] == "true") "Sells at 09:16:00." else "Holds: stop, your exit or ${squareOff ?: "15:15"}.", f["autoExit"] == "true", accent) { f["autoExit"] = (f["autoExit"] != "true").toString() }
    SaveBar(accent) {
        onSave(u, buildJsonObject {
            put("decide", f["decide"]); put("lots", f["lots"]?.toDoubleOrNull() ?: 0.0)
            put("capitalMode", f["capitalMode"]); put("capital", f["capital"]?.toDoubleOrNull() ?: 0.0); put("capitalPct", f["capitalPct"]?.toDoubleOrNull() ?: 80.0)
            put("stopPct", f["stopPct"]?.toDoubleOrNull() ?: 0.0)
            put("costToCost", f["costToCost"] == "true"); put("requireGreen", f["requireGreen"] == "true"); put("autoExit", f["autoExit"] == "true")
            // Kept as saved (not shown here).
            put("fundsPct", c?.num("fundsPct") ?: 80.0); put("compound", c?.bool("compound") ?: true); put("noEntryLock", c?.bool("noEntryLock") ?: true)
        })
    }
}

@Composable
private fun StrangleForm(u: String, c: JsonObject?, accent: Color, onSave: suspend (String, JsonObject) -> String?) {
    val f = remember(c) {
        mutableStateMapOf(
            "capitalMode" to (c?.str("capitalMode") ?: "amount"), "capital" to trim(c?.num("capital") ?: 0.0), "capitalPct" to trim(c?.num("capitalPct") ?: 100.0),
            "target" to trim(c?.num("target") ?: STRANGLE_TARGETS[u] ?: 4.0), "bandPct" to trim(c?.num("bandPct") ?: 90.0),
            "entry" to (c?.str("entry") ?: "09:20"), "waitMin" to trim(c?.num("waitMin") ?: 25.0), "exit" to (c?.str("exit") ?: "15:25"),
            "stopPct" to trim(c?.num("stopPct") ?: 20.0), "maxVolPct" to trim(c?.num("maxVolPct") ?: 10.0), "expiryDay" to (c?.str("expiryDay") ?: "next"),
        )
    }
    FormLabel("Capital")
    Seg(listOf("amount" to "₹ amount", "percent" to "% of funds"), f["capitalMode"]!!, accent) { f["capitalMode"] = it }
    if (f["capitalMode"] == "percent") NumField("Capital % of available funds", f["capitalPct"]!!) { f["capitalPct"] = it }
    else NumField("Capital ₹ (0 = all available funds)", f["capital"]!!) { f["capital"] = it }
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(Modifier.weight(1f)) { NumField("Option price ₹", f["target"]!!) { f["target"] = it } }
        Box(Modifier.weight(1f)) { NumField("Price band ± %", f["bandPct"]!!) { f["bandPct"] = it } }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(Modifier.weight(1f)) { TextFieldBox("Entry (HH:MM)", f["entry"]!!, KeyboardType.Text) { f["entry"] = it } }
        Box(Modifier.weight(1f)) { NumField("Wait (min)", f["waitMin"]!!) { f["waitMin"] = it } }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(Modifier.weight(1f)) { TextFieldBox("Exit (HH:MM)", f["exit"]!!, KeyboardType.Text) { f["exit"] = it } }
        Box(Modifier.weight(1f)) { NumField("Stop % (minute close)", f["stopPct"]!!) { f["stopPct"] = it } }
    }
    NumField("Max % of volume (0 = off)", f["maxVolPct"]!!) { f["maxVolPct"] = it }
    FormLabel("On the expiry day")
    Seg(listOf("next" to "Next expiry", "skip" to "Skip", "next1" to "Next from day before"), f["expiryDay"]!!, accent) { f["expiryDay"] = it }
    SaveBar(accent) {
        onSave(u, buildJsonObject {
            put("capitalMode", f["capitalMode"]); put("capital", f["capital"]?.toDoubleOrNull() ?: 0.0); put("capitalPct", f["capitalPct"]?.toDoubleOrNull() ?: 100.0)
            put("target", f["target"]?.toDoubleOrNull() ?: 0.0); put("bandPct", f["bandPct"]?.toDoubleOrNull() ?: 0.0)
            put("entry", f["entry"]); put("waitMin", f["waitMin"]?.toDoubleOrNull() ?: 0.0); put("exit", f["exit"])
            put("stopPct", f["stopPct"]?.toDoubleOrNull() ?: 0.0); put("maxVolPct", f["maxVolPct"]?.toDoubleOrNull() ?: 0.0); put("expiryDay", f["expiryDay"])
            put("fundsPct", c?.num("fundsPct") ?: 100.0); put("compound", c?.bool("compound") ?: true)
        })
    }
}

@Composable
private fun FormLabel(t: String) = Text(t, style = TlType.small.copy(fontWeight = FontWeight.SemiBold), color = Tl.muted, modifier = Modifier.padding(top = 10.dp, bottom = 6.dp))

@Composable
private fun Seg(options: List<Pair<String, String>>, value: String, accent: Color, onPick: (String) -> Unit) {
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Tl.surfaceHi).padding(3.dp), horizontalArrangement = Arrangement.spacedBy(3.dp)) {
        options.forEach { (k, label) ->
            val sel = k == value
            val bg by animateColorAsState(if (sel) accent.copy(alpha = 0.2f) else Color.Transparent, tween(180), label = "seg")
            Box(Modifier.weight(1f).clip(RoundedCornerShape(10.dp)).tactile({ onPick(k) }).background(bg)
                .border(1.dp, if (sel) accent.copy(alpha = 0.55f) else Color.Transparent, RoundedCornerShape(10.dp)).padding(vertical = 10.dp, horizontal = 4.dp),
                contentAlignment = Alignment.Center) {
                Text(label, style = TlType.small.copy(fontWeight = FontWeight.SemiBold), color = if (sel) Tl.text else Tl.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

@Composable
private fun ToggleRow(title: String, sub: String, on: Boolean, accent: Color, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).tactile(onClick).padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, style = TlType.label.copy(fontSize = 14.sp), color = Tl.text)
            Text(sub, style = TlType.small, color = Tl.muted)
        }
        Spacer(Modifier.width(12.dp))
        PillSwitch(on, accent)
    }
}

@Composable
private fun NumField(label: String, value: String, onChange: (String) -> Unit) =
    TextFieldBox(label, value, KeyboardType.Decimal) { v -> onChange(v.filter { it.isDigit() || it == '.' }) }

@Composable
private fun TextFieldBox(label: String, value: String, type: KeyboardType, onChange: (String) -> Unit) {
    OutlinedTextField(value, onChange, label = { Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis) }, singleLine = true,
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp), shape = RoundedCornerShape(14.dp),
        keyboardOptions = KeyboardOptions(keyboardType = type),
        colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = Tl.amber, unfocusedBorderColor = Tl.lineHi, focusedLabelColor = Tl.amber, unfocusedLabelColor = Tl.muted,
            cursorColor = Tl.amber, focusedTextColor = Tl.text, unfocusedTextColor = Tl.text))
}

/** Save with a spinner; shows the server's message when it refuses. */
@Composable
private fun SaveBar(accent: Color, save: suspend () -> String?) {
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var err by remember { mutableStateOf<String?>(null) }
    Spacer(Modifier.height(12.dp))
    err?.let { Text(it, style = TlType.small, color = Tl.red, modifier = Modifier.padding(bottom = 8.dp)) }
    Box(Modifier.fillMaxWidth().height(52.dp).clip(RoundedCornerShape(16.dp)).tactile({ if (!busy) { busy = true; err = null; scope.launch { err = save(); busy = false } } })
        .background(Brush.horizontalGradient(listOf(accent, accent.copy(alpha = 0.75f)))), contentAlignment = Alignment.Center) {
        if (busy) CircularProgressIndicator(color = Color(0xFF14100A), strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
        else Text("Save settings", color = Color(0xFF14100A), fontWeight = FontWeight.Bold, fontSize = 16.sp)
    }
}

// ---------------------------------------------------------------- trades

@Composable
private fun TradeCard(t: JsonObject, showDay: Boolean) {
    val (label, tone) = STATUS[t.str("status")] ?: ((t.str("status") ?: "") to Tl.muted)
    val pnl = t.num("pnl")
    val bar = if (pnl == null) tone else Tl.money(pnl)
    val shape = RoundedCornerShape(18.dp)
    Row(Modifier.fillMaxWidth().height(androidx.compose.foundation.layout.IntrinsicSize.Min).clip(shape).background(GLASS).border(1.dp, EDGE_OFF, shape)) {
        Box(Modifier.width(4.dp).fillMaxHeight().background(Brush.verticalGradient(listOf(bar, bar.copy(alpha = 0.2f)))))
        Column(Modifier.weight(1f).padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("${t.str("strategy") ?: "ORB 5m"} · ${INDICES.firstOrNull { it.first == (t.str("underlying") ?: "NIFTY") }?.second ?: "NIFTY 50"} · ${t.str("direction") ?: ""}",
                        style = TlType.label, color = Tl.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text((if (showDay) "${t.str("day") ?: ""} · " else "") + "${t.str("symbol") ?: "—"}", style = TlType.small, color = Tl.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    // Entry and exit fill times to the second (the broker's fills; the signal time when none was found).
                    Text("In ${(t.long("enteredAt") ?: t.long("createdAt"))?.let { HHMMSS.format(Instant.ofEpochMilli(it)) } ?: "—"}" +
                        " · Out ${t.long("exitedAt")?.let { HHMMSS.format(Instant.ofEpochMilli(it)) } ?: "—"}",
                        style = TlType.numSm.copy(fontSize = 12.sp), color = Tl.muted, maxLines = 1)
                }
                Spacer(Modifier.width(8.dp))
                Column(horizontalAlignment = Alignment.End) {
                    if (pnl != null) Text(inr(pnl, sign = true), style = TlType.num.copy(fontWeight = FontWeight.Bold), color = Tl.money(pnl))
                    Spacer(Modifier.height(4.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (t.bool("paper") == true) { Tag("PAPER", ICE); Spacer(Modifier.width(4.dp)) }
                        Tag(label.uppercase(), tone)
                    }
                }
            }
            Spacer(Modifier.height(10.dp))
            // Capital used: entry premium × quantity (the server's figure, else worked out here).
            val capital = t.num("capital") ?: t.num("entryPrice")?.let { e -> t.num("qty")?.takeIf { it > 0 }?.let { e * it } }
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                listOf("Lots" to t.num("lots")?.toInt()?.toString(), "Entry" to t.num("entryPrice")?.let { "%.2f".format(it) }, "SL" to t.num("slPrice")?.let { "%.2f".format(it) },
                    "Exit" to t.num("exitPrice")?.let { "%.2f".format(it) }, "Capital" to capital?.let { inr(it) })
                    .forEach { (k, v) -> Column { Text(k, style = TlType.small.copy(fontSize = 11.sp), color = Tl.dim); Text(v ?: "—", style = TlType.numSm, color = Tl.text) } }
            }
            t.str("reason")?.takeIf { it.isNotBlank() }?.let { Spacer(Modifier.height(8.dp)); Text(it, style = TlType.small, color = Tl.dim, maxLines = 3, overflow = TextOverflow.Ellipsis) }
        }
    }
}
