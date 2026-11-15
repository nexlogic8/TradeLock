package com.nexlogic.tradelock.ui.screens

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.AutoAwesome
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.Tune
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
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
import com.nexlogic.tradelock.ui.components.Eyebrow
import com.nexlogic.tradelock.ui.components.TlCard
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
private val STATUS = mapOf("open" to ("Open" to Tl.mint), "closing" to ("Exiting" to Color(0xFF5AA9FF)), "closed" to ("Closed" to Tl.muted),
    "skipped" to ("Skipped" to Tl.amber), "failed" to ("Failed" to Tl.red), "placing" to ("Placing" to Color(0xFF5AA9FF)))
private val HHMM = DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.of("Asia/Kolkata"))

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
    val scope = rememberCoroutineScope()
    val rules = rememberRuleSet("algo")

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
        Modifier.fillMaxSize().background(Tl.bg).statusBarsPadding(),
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 12.dp, bottom = bottomPad.calculateBottomPadding() + 24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 6.dp, bottom = 2.dp)) {
                Column(Modifier.weight(1f)) {
                    Text("AI Algo Trading", fontSize = 30.sp, fontWeight = FontWeight.ExtraBold, color = Tl.text)
                    Text("Automatic index option entries", style = TlType.body, color = Tl.muted)
                }
                SavedBadge(rules.saved)
            }
        }
        if (d == null) {
            item { Box(Modifier.fillMaxWidth().padding(48.dp), contentAlignment = Alignment.Center) { if (error != null) Text(error!!, color = Tl.red, style = TlType.body) else CircularProgressIndicator(color = Tl.amber) } }
            return@LazyColumn
        }

        // ---- hero: state, Paper | Real, Start / Stop ----
        item {
            val tint = if (running) Tl.amber else Tl.muted
            TlCard(Modifier.fillMaxWidth(), padding = 20.dp) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(52.dp).clip(RoundedCornerShape(16.dp)).background(Tl.amber.copy(alpha = if (running) 0.18f else 0.08f)), contentAlignment = Alignment.Center) {
                        Icon(Icons.Rounded.AutoAwesome, null, tint = if (running) Tl.amber else Tl.dim, modifier = Modifier.size(26.dp))
                    }
                    Spacer(Modifier.width(14.dp))
                    Column(Modifier.weight(1f)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("Algo Trading", style = TlType.title, color = Tl.text)
                            if (paper) { Spacer(Modifier.width(8.dp)); Tag("PAPER", Color(0xFF5AA9FF)) }
                        }
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Dot(tint, 7.dp); Spacer(Modifier.width(6.dp))
                            Text(when { running && marketOpen -> "Running"; running -> "On"; ready -> "Stopped"; else -> "Setup needed" }.uppercase(), style = TlType.eyebrow, color = tint)
                        }
                    }
                }
                Spacer(Modifier.height(12.dp))
                val on = activeStrategies(a)
                Text(
                    (if (running) (if (marketOpen) "Watching the market." else "Starts watching at the next market open.") else if (ready) "No automatic orders are placed." else "Finish the setup below to start.") +
                        " " + (if (on.isEmpty()) "No strategy is on yet." else "On: ${on.joinToString(" · ")}."),
                    style = TlType.body, color = Tl.muted,
                )
                Spacer(Modifier.height(16.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    ModeSwitch(paper, realAllowed = a?.str("broker") != "paper") { setPaper(it) }
                    Spacer(Modifier.width(12.dp))
                    Box(Modifier.weight(1f)) {
                        if (running) DangerButton("Stop Algo Trading") { toggleAlgo() }
                        else if (ready) Box(Modifier.fillMaxWidth().height(54.dp).tactile({ toggleAlgo() }).clip(RoundedCornerShape(16.dp)).background(Tl.amber), contentAlignment = Alignment.Center) {
                            Text("Start Algo Trading", color = Color(0xFF2A1A02), fontWeight = FontWeight.Bold, fontSize = 16.sp)
                        } else GhostButton("Setup needed", Modifier.fillMaxWidth()) { }
                    }
                }
            }
        }

        // ---- before it can start ----
        val missing = d.arr("readiness").mapNotNull { it as? JsonObject }
        if (missing.any { it.bool("ok") != true }) {
            item {
                TlCard(Modifier.fillMaxWidth()) {
                    Text("Before it can start", style = TlType.label.copy(fontSize = 16.sp), color = Tl.text)
                    Spacer(Modifier.height(10.dp))
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
                    Kpi("Day stop-loss", daily?.let { inr(it) } ?: "Off", if (daily == null) "Set on Risk rules" else if (b?.str("lossLimitMode") == "percent") "${b.num("lossLimitValue")?.let { trim(it) }}% of ${inr(b.num("capital"))}" else "Whole account", Modifier.weight(1f))
                    Kpi("SL left · next trade", daily?.let { inr(b?.num("left")) } ?: "Off", "Today's P&L ${inr(b?.num("pnl"), sign = true)}", Modifier.weight(1f), danger = daily != null && (b?.num("left") ?: 0.0) <= 0)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Kpi("Trades today", "${trades.count { it.num("entryPrice") != null }}", r?.num("tradeCap")?.let { "Trade cap ${it.toInt()}" } ?: "No trade cap", Modifier.weight(1f))
                    Kpi("Square-off", r?.str("squareOff") ?: "–", if (r?.bool("locked") == true) "Account locked today" else if (r?.str("cutoff") != null) "Your cutoff" else "Default", Modifier.weight(1f))
                }
            }
        }

        // ---- strategies × indices ----
        item {
            Row(Modifier.padding(start = 4.dp, top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Eyebrow("Strategies × indices", Modifier.weight(1f))
                Row(Modifier.tactile({ onOpen("algo?web=1") }).padding(4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Rounded.Tune, null, tint = Tl.mint, modifier = Modifier.size(16.dp)); Spacer(Modifier.width(4.dp))
                    Text("Settings", style = TlType.small.copy(fontWeight = FontWeight.SemiBold), color = Tl.mint)
                }
            }
        }
        val strategies = a?.arr("gridStrategies")?.mapNotNull { it as? JsonObject }.orEmpty().filter { admin || it.str("key") == "gap" }
        strategies.forEach { s ->
            val g = s.str("key") ?: return@forEach
            item(key = "strat-$g") {
                val grid = a?.obj("grid")?.obj(g)
                val anyOn = INDICES.any { grid?.obj(it.first)?.bool("on") == true }
                val border by animateColorAsState(if (anyOn) Tl.amber.copy(alpha = 0.4f) else Tl.line, tween(220), label = "sb")
                Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(20.dp)).background(Tl.cardBrush).border(1.dp, border, RoundedCornerShape(20.dp)).padding(16.dp)) {
                    Text(s.str("name") ?: g, style = TlType.label.copy(fontSize = 16.sp), color = Tl.text)
                    s.str("label")?.let { Text(it, style = TlType.small, color = Tl.muted) }
                    Spacer(Modifier.height(12.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        INDICES.forEach { (u, label) ->
                            val on = grid?.obj(u)?.bool("on") == true
                            val mine = trades.filter { it.str("strategy") == s.str("name") && (it.str("underlying") ?: "NIFTY") == u }
                            val state = when { mine.any { it.str("status") in LIVE } -> "In trade"; mine.any { it.num("entryPrice") != null } -> "Traded"; else -> null }
                            IndexChip(label, on, state, busyCell == "$g|$u", Modifier.weight(1f)) { toggleCell(g, u, !on) }
                        }
                    }
                }
            }
        }

        // ---- the Algo Trading set's own risk rules ----
        item { Eyebrow("Risk rules for Algo Trading", Modifier.padding(start = 4.dp, top = 10.dp)) }
        item { Text("Daily stop-loss, profit target, give-back and the kill switch cover your whole account: set them on Risk rules.", style = TlType.small.copy(fontSize = 13.sp), color = Tl.dim, modifier = Modifier.padding(horizontal = 4.dp)) }
        rules.error?.let { e -> item { Text(e, style = TlType.body, color = Tl.red, modifier = Modifier.padding(horizontal = 4.dp)) } }
        ruleCards(rules, ALGO_RULE_KEYS, dash?.broker?.label ?: "broker")

        // ---- today ----
        item { Eyebrow("Today", Modifier.padding(start = 4.dp, top = 10.dp)) }
        if (trades.isEmpty()) item { Text("No automatic trades yet today.", style = TlType.body, color = Tl.dim, modifier = Modifier.padding(horizontal = 4.dp)) }
        trades.forEachIndexed { i, t -> item(key = "t$i") { TradeCard(t, showDay = false) } }

        // ---- history ----
        val history = d.arr("history").mapNotNull { it as? JsonObject }
        if (history.isNotEmpty()) {
            val real = history.filter { it.num("pnl") != null && it.bool("paper") != true }
            val total = real.sumOf { it.num("pnl") ?: 0.0 }
            item {
                Row(Modifier.padding(start = 4.dp, top = 10.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Eyebrow("History", Modifier.weight(1f))
                    Text("${real.size} trades · ${real.count { (it.num("pnl") ?: 0.0) > 0 }} won · ", style = TlType.small, color = Tl.muted)
                    Text(inr(total, sign = true), style = TlType.numSm, color = Tl.money(total))
                }
            }
            history.take(30).forEachIndexed { i, t -> item(key = "h$i") { TradeCard(t, showDay = true) } }
        }
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

@Composable
private fun Tag(text: String, c: Color) =
    Text(text, style = TlType.eyebrow.copy(fontSize = 9.sp), color = c, modifier = Modifier.clip(CircleShape).background(c.copy(alpha = 0.14f)).padding(horizontal = 8.dp, vertical = 3.dp))

@Composable
private fun ModeSwitch(paper: Boolean, realAllowed: Boolean, onPick: (Boolean) -> Unit) {
    Row(Modifier.height(54.dp).clip(RoundedCornerShape(16.dp)).background(Tl.surfaceHi).padding(4.dp)) {
        listOf(true to "Paper", false to "Real").forEach { (p, label) ->
            val on = p == paper
            val enabled = p || realAllowed
            Box(
                Modifier.fillMaxHeight().width(64.dp).tactile({ if (enabled) onPick(p) }, enabled = enabled).clip(RoundedCornerShape(12.dp))
                    .background(if (on) Tl.raised else Color.Transparent),
                contentAlignment = Alignment.Center,
            ) { Text(label, style = TlType.label, color = if (on) (if (p) Color(0xFF5AA9FF) else Tl.amber) else if (enabled) Tl.muted else Tl.dim) }
        }
    }
}

@Composable
private fun Kpi(label: String, value: String, foot: String, modifier: Modifier, danger: Boolean = false) {
    TlCard(modifier, padding = 14.dp, shape = RoundedCornerShape(18.dp)) {
        Text(label, style = TlType.small, color = Tl.muted, maxLines = 1)
        Spacer(Modifier.height(6.dp))
        Text(value, style = TlType.num.copy(fontSize = 18.sp, fontWeight = FontWeight.Bold), color = if (danger) Tl.red else Tl.text, maxLines = 1)
        Spacer(Modifier.height(4.dp))
        Text(foot, style = TlType.small.copy(fontSize = 11.sp), color = Tl.dim, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun IndexChip(label: String, on: Boolean, state: String?, busy: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val bg by animateColorAsState(if (on) Tl.amber.copy(alpha = 0.16f) else Tl.surfaceHi, tween(200), label = "ic")
    Column(
        modifier.tactile(onClick, enabled = !busy).clip(RoundedCornerShape(14.dp)).background(bg)
            .border(1.dp, if (on) Tl.amber.copy(alpha = 0.6f) else Tl.lineHi, RoundedCornerShape(14.dp)).padding(vertical = 10.dp, horizontal = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(label, style = TlType.small.copy(fontWeight = FontWeight.Bold, fontSize = 12.sp), color = if (on) Tl.amber else Tl.muted, maxLines = 1)
        Spacer(Modifier.height(4.dp))
        Text(if (busy) "…" else state ?: if (on) "ON" else "OFF", style = TlType.eyebrow.copy(fontSize = 9.sp), color = if (state == "In trade") Tl.mint else if (on) Tl.amber else Tl.dim)
    }
}

@Composable
private fun TradeCard(t: JsonObject, showDay: Boolean) {
    val (label, tone) = STATUS[t.str("status")] ?: ((t.str("status") ?: "") to Tl.muted)
    val pnl = t.num("pnl")
    TlCard(Modifier.fillMaxWidth(), padding = 14.dp, shape = RoundedCornerShape(18.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("${t.str("strategy") ?: "ORB 5m"} · ${INDICES.firstOrNull { it.first == (t.str("underlying") ?: "NIFTY") }?.second ?: "NIFTY 50"} · ${t.str("direction") ?: ""}",
                    style = TlType.label, color = Tl.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text((if (showDay) "${t.str("day") ?: ""} · " else "") + (t.long("createdAt")?.let { HHMM.format(Instant.ofEpochMilli(it)) } ?: "") + " · ${t.str("symbol") ?: "—"}",
                    style = TlType.small, color = Tl.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Spacer(Modifier.width(8.dp))
            Column(horizontalAlignment = Alignment.End) {
                if (pnl != null) Text(inr(pnl, sign = true), style = TlType.num, color = Tl.money(pnl))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (t.bool("paper") == true) { Tag("PAPER", Color(0xFF5AA9FF)); Spacer(Modifier.width(4.dp)) }
                    Tag(label.uppercase(), tone)
                }
            }
        }
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            listOf("Lots" to t.num("lots")?.toInt()?.toString(), "Entry" to t.num("entryPrice")?.let { "%.2f".format(it) }, "SL" to t.num("slPrice")?.let { "%.2f".format(it) }, "Exit" to t.num("exitPrice")?.let { "%.2f".format(it) })
                .forEach { (k, v) -> Column { Text(k, style = TlType.small.copy(fontSize = 11.sp), color = Tl.dim); Text(v ?: "—", style = TlType.numSm, color = Tl.text) } }
        }
        t.str("reason")?.takeIf { it.isNotBlank() }?.let { Spacer(Modifier.height(8.dp)); Text(it, style = TlType.small, color = Tl.dim) }
    }
}
