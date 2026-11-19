package com.nexlogic.tradelock.ui.screens

import androidx.compose.foundation.layout.imePadding
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.material.icons.rounded.TableRows
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material.icons.rounded.Tune
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Bolt
import androidx.compose.material.icons.rounded.UnfoldMore
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.ui.input.pointer.pointerInput
import com.nexlogic.tradelock.ui.components.OiBar
import com.nexlogic.tradelock.ui.components.STRATEGIES
import com.nexlogic.tradelock.ui.components.Study
import com.nexlogic.tradelock.ui.components.StudyType
import com.nexlogic.tradelock.ui.components.previousDayRange
import com.nexlogic.tradelock.ui.components.strategyMarkers
import com.nexlogic.tradelock.ui.components.todaysOpeningRange
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
import androidx.lifecycle.viewmodel.compose.viewModel
import com.nexlogic.tradelock.data.AppViewModel
import com.nexlogic.tradelock.data.Contract
import com.nexlogic.tradelock.data.ScalperViewModel
import com.nexlogic.tradelock.data.Toast
import com.nexlogic.tradelock.ui.components.CandleChart
import com.nexlogic.tradelock.ui.components.ChartLevel
import com.nexlogic.tradelock.ui.components.LabelCell
import com.nexlogic.tradelock.ui.components.Dot
import com.nexlogic.tradelock.ui.components.Eyebrow
import com.nexlogic.tradelock.ui.components.HoldToConfirm
import com.nexlogic.tradelock.ui.components.PillSwitch
import com.nexlogic.tradelock.ui.components.RollingText
import com.nexlogic.tradelock.ui.components.TlCard
import com.nexlogic.tradelock.ui.components.tactile
import com.nexlogic.tradelock.ui.inr
import com.nexlogic.tradelock.ui.theme.Tl
import com.nexlogic.tradelock.ui.theme.TlType
import kotlinx.coroutines.launch

private val INTERVALS = listOf("1" to "1m", "5" to "5m", "15" to "15m", "25" to "25m", "60" to "1h")
private val OR_HIGH = Color(0xFFFFBA52); private val OR_LOW = Color(0xFF5AB8FF); private val PREV = Color(0xFFC9A0FF)
private enum class ScAsk { None, Underlying, Expiry, Buy, Sell, Exit, Level, Chain, Interval, Positions, Orders, Studies }
private val CLOCK = java.time.format.DateTimeFormatter.ofPattern("HH:mm:ss").withZone(java.time.ZoneId.of("Asia/Kolkata"))
private val OI_RES = Color(0xFFFF7A90); private val OI_SUP = Color(0xFF3FC8E4); private val MAX_PAIN = Color(0xFFC08A5B)

/** OI levels from the chain: the most call OI (resistance), the most put OI (support), max pain, and per-strike bars. */
private class OiInfo(val levels: List<ChartLevel>, val bars: List<OiBar>)
private fun oiLevels(rows: List<com.nexlogic.tradelock.data.StrikeRow>): OiInfo {
    val r = rows.filter { (it.ce?.oi ?: 0.0) > 0 || (it.pe?.oi ?: 0.0) > 0 }
    if (r.size < 3) return OiInfo(emptyList(), emptyList())
    val res = r.maxByOrNull { it.ce?.oi ?: 0.0 }?.strike
    val sup = r.maxByOrNull { it.pe?.oi ?: 0.0 }?.strike
    // max pain: the expiry price at which option buyers together collect the least
    val pain = r.minByOrNull { k -> r.sumOf { x -> (x.ce?.oi ?: 0.0) * maxOf(0.0, k.strike - x.strike) + (x.pe?.oi ?: 0.0) * maxOf(0.0, x.strike - k.strike) } }?.strike
    val levels = buildList {
        res?.let { add(ChartLevel(it, OI_RES, "OI Resistance", fit = false, outlined = true)) }
        pain?.takeIf { it != res && it != sup }?.let { add(ChartLevel(it, MAX_PAIN, "Max Pain", fit = false, outlined = true)) }
        sup?.takeIf { it != res }?.let { add(ChartLevel(it, OI_SUP, "OI Support", fit = false, outlined = true)) }
    }
    return OiInfo(levels, r.map { OiBar(it.strike, it.ce?.oi ?: 0.0, it.pe?.oi ?: 0.0) })
}
private val ORDER_BLUE = Color(0xFF5AA9FF)
private val POS_BLUE = Color(0xFF2962FF); private val POS_AMBER = Color(0xFFF7A600)
/** P&L as on the web / a broker's chart: "+9.75 INR" (Indian grouping, two decimals). */
private fun pnlText(v: Double): String =
    (if (v < 0) "−" else "+") + java.text.NumberFormat.getNumberInstance(java.util.Locale("en", "IN")).apply { minimumFractionDigits = 2; maximumFractionDigits = 2 }.format(kotlin.math.abs(v)) + " INR"
/** First TP / SL from the entry label: 10% of the live price away, on the right side (the web's defaultLevel). */
private fun defaultLevel(tp: Boolean, long: Boolean, ltp: Double): Double {
    val away = maxOf(0.05, Math.round(ltp * 0.10 * 20) / 20.0)
    return Math.round((if (tp == long) ltp + away else ltp - away) * 20) / 20.0
}

@Composable
fun ScalperScreen(vm: AppViewModel, bottomPad: PaddingValues, onClose: () -> Unit = {}) {
    val sc: ScalperViewModel = viewModel()
    // Full screen while open: the status and navigation bars hide (a swipe from the edge shows them for a moment).
    val view = androidx.compose.ui.platform.LocalView.current
    androidx.compose.runtime.DisposableEffect(Unit) {
        var ctx = view.context
        while (ctx is android.content.ContextWrapper && ctx !is android.app.Activity) ctx = ctx.baseContext
        val ctl = (ctx as? android.app.Activity)?.window?.let { androidx.core.view.WindowCompat.getInsetsController(it, view) }
        ctl?.systemBarsBehavior = androidx.core.view.WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        ctl?.hide(androidx.core.view.WindowInsetsCompat.Type.systemBars())
        onDispose { ctl?.show(androidx.core.view.WindowInsetsCompat.Type.systemBars()) }
    }
    LaunchedEffect(Unit) { sc.start() }
    val s by sc.state.collectAsState()
    val dash by vm.dash.collectAsState()
    var ask by remember { mutableStateOf(ScAsk.None) }
    var exitSymbol by remember { mutableStateOf<String?>(null) }
    var levelAt by remember { mutableStateOf<Pair<Double, Boolean>?>(null) }   // long-pressed price, on the index chart?
    val scope = rememberCoroutineScope()
    val c = s.contract
    val size = sc.sizeFor(s)
    // Sell margin (writing the option) comes from Dhan's calculator: asked again when the contract or lots change
    // (after a short pause) and every 20 s, as the web ticket does.
    LaunchedEffect(c?.securityId, size.lots) {
        kotlinx.coroutines.delay(450)
        while (true) { sc.refreshMargin(size.lots); kotlinx.coroutines.delay(20_000) }
    }
    // A dragged level stays where it was let go until the server's next update confirms it.
    val held = remember { androidx.compose.runtime.mutableStateMapOf<String, Double>() }
    LaunchedEffect(dash) { held.clear() }
    fun at(id: String, p: Double) = held[id] ?: p
    fun done(err: String?, ok: String? = null) { if (err != null) { held.clear(); vm.toast(err, Toast.Tone.Error) } else { if (ok != null) vm.toast(ok); vm.reloadDash() } }

    // Open positions on this chain's contracts (live P&L from the dashboard stream).
    val open = dash?.positions.orEmpty().filter { p -> s.strikes.any { r -> r.ce?.securityId == p.securityId || r.pe?.securityId == p.securityId } || p.symbol.startsWith(s.label.substringBefore(' ')) }
    val pos = dash?.positions?.firstOrNull { it.securityId == c?.securityId && it.qty != 0.0 }
    val bracket = dash?.brackets?.firstOrNull { it.securityId == c?.securityId }
    fun pnlAt(price: Double) = pos?.let { (price - it.avg) * it.qty * s.pointValue } ?: 0.0
    // ✕ on the entry label closes the position: the first tap arms it ("Exit?") for 4 s, a second tap sends the exit.
    var exitArmedAt by remember { androidx.compose.runtime.mutableLongStateOf(0L) }
    val levels = buildList {
        // The open position, drawn as on the web (and a broker's chart): [TP][SL][ qty ][ +9.75 INR ][ ✕ ] on the entry,
        // [TP|SL][ qty ][ P&L there ][ ✕ ] on the target and stop lines. Entry P&L follows the live tick.
        if (pos != null) {
            val qtyCell = LabelCell(kotlin.math.abs(pos.qty).toLong().toString(), Color.White, POS_BLUE)
            val live = c?.ltp?.takeIf { it > 0 }?.let { pnlAt(it) } ?: pos.unrealized
            val tp = bracket?.tp?.let { at("tp", it) }; val sl = bracket?.sl?.let { at("sl", it) }
            val armed = System.currentTimeMillis() - exitArmedAt <= 4_000   // the screen redraws every second (clock pill)
            // TP / SL buttons only while that level can still be added: a set level has its own line, and a Super Order
            // leg removed at Dhan cannot be added back.
            val canTp = tp == null && bracket?.superOrder != true; val canSl = sl == null && bracket?.superOrder != true
            add(ChartLevel(pos.avg, POS_BLUE, "", dashed = true, cells = listOfNotNull(
                if (canTp) LabelCell("TP", Tl.green, act = "add-tp") else null,
                if (canSl) LabelCell("SL", POS_AMBER, act = "add-sl") else null,
                qtyCell,
                LabelCell(pnlText(live), Tl.money(live)),
                if (armed) LabelCell("Exit?", Color.White, Tl.red, act = "exit") else LabelCell("✕", Tl.text, act = "exit"),
            )))
            tp?.let { v -> add(ChartLevel(v, Tl.green, "TP", dashed = false, id = "tp", draggable = true, removable = true, cells = listOf(
                LabelCell("TP", Color(0xFF05121A), Tl.green), qtyCell, LabelCell(pnlText(pnlAt(v)), Tl.money(pnlAt(v))), LabelCell("✕", Tl.text, act = "remove")))) }
            sl?.let { v -> add(ChartLevel(v, POS_AMBER, "SL", dashed = false, id = "sl", draggable = true, removable = true, cells = listOf(
                LabelCell("SL", Color(0xFF05121A), POS_AMBER), qtyCell, LabelCell(pnlText(pnlAt(v)), Tl.money(pnlAt(v))), LabelCell("✕", Tl.text, act = "remove")))) }
        }
        // Pending entries: limits at their price, stop entries at their trigger (a position's own stop-loss is its SL line).
        val slIds = dash?.brackets.orEmpty().mapNotNull { it.slOrderId }.toSet()
        dash?.orders.orEmpty().filter { it.securityId == c?.securityId && (it.type == "LIMIT" || ((it.type == "STOP_LOSS" || it.type == "SL") && it.id !in slIds)) }.forEach { o ->
            val stop = o.type != "LIMIT"
            val v = at("o:${o.id}", if (stop) (o.triggerPrice ?: o.price) else o.price)
            add(ChartLevel(v, if (o.side == "BUY") ORDER_BLUE else Tl.amber, "${o.side} ${if (stop) "STOP" else "LMT"} ${"%.2f".format(v)} · ${(o.qty / s.qtyPerLot.coerceAtLeast(1)).toInt()} lot", id = "o:${o.id}", draggable = true, removable = true))
        }
        (s.alerts ?: dash?.alerts).orEmpty().filter { it.securityId == c?.securityId }.forEach { a ->
            val v = at("a:${a.id}", a.price)
            add(ChartLevel(v, Tl.violet, "🔔 ${if (a.dir == "below") "≤" else "≥"} ${"%.2f".format(v)}", id = "a:${a.id}", draggable = true, removable = true))
        }
    }
    val spotLevels = (s.alerts ?: dash?.alerts).orEmpty().filter { it.securityId == s.spotId }.map { a ->
        val v = at("a:${a.id}", a.price)
        ChartLevel(v, Tl.violet, "🔔 ${if (a.dir == "below") "≤" else "≥"} ${"%.2f".format(v)}", id = "a:${a.id}", draggable = true, removable = true)
    }
    fun onMove(id: String, price: Double) {
        held[id] = com.nexlogic.tradelock.data.tick(price)
        scope.launch {
            when {
                id == "tp" -> done(sc.setBracket(c!!.securityId, price, bracket?.sl))
                id == "sl" -> done(sc.setBracket(c!!.securityId, bracket?.tp, price))
                id.startsWith("o:") -> done(sc.moveOrder(id.removePrefix("o:"), price), "Order moved to ${"%.2f".format(com.nexlogic.tradelock.data.tick(price))}.")
                id.startsWith("a:") -> {
                    // The side (≥ / ≤) comes from the alert's own contract price: without a live one the move would keep the old side.
                    val a = (s.alerts ?: dash?.alerts).orEmpty().firstOrNull { "a:${it.id}" == id }
                    val ltp = when (a?.securityId) { null -> null; s.spotId -> s.spot; else -> s.strikes.firstNotNullOfOrNull { r -> listOfNotNull(r.ce, r.pe).firstOrNull { it.securityId == a.securityId }?.ltp } }
                    if (ltp == null || ltp <= 0) { held.remove(id); vm.toast("Waiting for a live price before moving this alert.", Toast.Tone.Warn) }
                    else done(sc.moveAlert(id.removePrefix("a:").toLong(), price, ltp), "Alert moved: rings ${if (price < ltp) "≤" else "≥"} ${"%.2f".format(com.nexlogic.tradelock.data.tick(price))}.")
                }
            }
        }
    }
    fun onRemove(id: String) {
        scope.launch {
            when {
                id == "tp" -> done(sc.setBracket(c!!.securityId, null, bracket?.sl), "Target removed.")
                id == "sl" -> done(sc.setBracket(c!!.securityId, bracket?.tp, null), "Stop-loss removed.")
                id.startsWith("o:") -> done(sc.cancelOrder(id.removePrefix("o:")), "Order cancelled.")
                id.startsWith("a:") -> done(sc.deleteAlert(id.removePrefix("a:").toLong()), "Alert removed.")
            }
        }
    }

    // Today's move of the index: from the first bar of today's session (the chart's own candles).
    val dayOpen = s.spotCandles.lastOrNull()?.let { last -> val day = (last.time + 19_800) / 86_400; s.spotCandles.firstOrNull { (it.time + 19_800) / 86_400 == day }?.open }
    val spotMove = dayOpen?.takeIf { it > 0 && s.spot > 0 }?.let { s.spot - it }
    // The clock pill and the live bar's countdown tick every second.
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { now = System.currentTimeMillis(); kotlinx.coroutines.delay(1_000 - now % 1_000) } }
    // Share of the chart area the index chart takes (the handle between the charts moves it).
    var split by androidx.compose.runtime.saveable.rememberSaveable { mutableStateOf(0.5f) }
    val oi = remember(s.strikes) { oiLevels(s.strikes) }

    // ---- indicators, overlays and strategies: per chart, remembered on this phone (as the web keeps them per browser) ----
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val prefs = remember { ctx.getSharedPreferences("scalper_chart", android.content.Context.MODE_PRIVATE) }
    var spotStudies by remember { mutableStateOf(Study.decodeList(prefs.getString("studies.spot", null)) ?: Study.DEFAULT) }
    var optStudies by remember { mutableStateOf(Study.decodeList(prefs.getString("studies.opt", null)) ?: Study.DEFAULT) }
    var overlays by remember { mutableStateOf(prefs.getStringSet("overlays", setOf("oi", "prev"))!!.toSet()) }
    val session by vm.session.collectAsState()
    val admin = (session as? com.nexlogic.tradelock.data.Session.SignedIn)?.user?.admin == true
    // Chart strategy signals are for administrators only (as on the web); others get clean charts.
    var strategies by remember(admin) { mutableStateOf(if (admin) prefs.getStringSet("strategies", STRATEGIES.map { it.first }.toSet())!!.toSet() else emptySet()) }
    fun saveStudies(spot: Boolean, l: List<Study>) {
        if (spot) spotStudies = l else optStudies = l
        prefs.edit().putString(if (spot) "studies.spot" else "studies.opt", Study.encodeList(l)).apply()
    }
    fun toggleOverlay(k: String) { overlays = if (k in overlays) overlays - k else overlays + k; prefs.edit().putStringSet("overlays", overlays).apply() }
    fun toggleStrategy(k: String) { strategies = if (k in strategies) strategies - k else strategies + k; prefs.edit().putStringSet("strategies", strategies).apply() }
    var studiesSpot by remember { mutableStateOf(true) }   // which chart the Indicators / Interval sheet is for
    val spotSec = (s.interval.toIntOrNull() ?: 5) * 60L
    val optSec = (s.optInterval.toIntOrNull() ?: 5) * 60L
    // Day levels: the opening range (with ORB on) and the previous session's high / low, on each chart from its own candles.
    fun dayLevels(cs: List<com.nexlogic.tradelock.ui.components.Candle>, sec: Long) = buildList {
        if ("orb" in strategies && sec <= 300) todaysOpeningRange(cs, now)?.let { (h, l) ->
            add(ChartLevel(h, OR_HIGH, "OR High", fit = false, outlined = true)); add(ChartLevel(l, OR_LOW, "OR Low", fit = false, outlined = true))
        }
        if ("prev" in overlays) previousDayRange(cs, now)?.let { (h, l) ->
            add(ChartLevel(h, PREV, "Prev High", fit = false, outlined = true)); add(ChartLevel(l, PREV, "Prev Low", fit = false, outlined = true))
        }
    }
    val minute = now / 60_000   // signals and day levels are worked out again once a minute (and on new candles)
    val spotDay = remember(s.spotCandles.size, s.spotCandles.lastOrNull()?.time, strategies, overlays, minute) { dayLevels(s.spotCandles, spotSec) }
    val optDay = remember(s.optionCandles.size, s.optionCandles.lastOrNull()?.time, strategies, overlays, minute) { dayLevels(s.optionCandles, optSec) }
    val spotMarks = remember(s.spotCandles.size, s.spotCandles.lastOrNull()?.time, strategies, minute) { strategyMarkers(strategies, s.spotCandles, spotSec, now, "spot") }
    val optMarks = remember(s.spotCandles.size, s.spotCandles.lastOrNull()?.time, s.side, strategies, minute) { strategyMarkers(strategies, s.spotCandles, spotSec, now, s.side) }

    // imePadding: while the lots are typed, the screen shrinks so the ticket stays above the keyboard.
    Column(Modifier.fillMaxSize().background(Tl.bg).statusBarsPadding().imePadding()) {
        // ---- top pill bar: clock · P&L · Positions · Orders · Chain · feed ----
        val openPos = dash?.positions.orEmpty().filter { it.qty != 0.0 }
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            TopPill(onClose) { Icon(Icons.Rounded.Close, "Close", tint = Tl.text, modifier = Modifier.size(20.dp)) }
            TopPill { Text(CLOCK.format(java.time.Instant.ofEpochMilli(now)), style = TlType.numSm.copy(fontSize = 14.sp, fontWeight = FontWeight.SemiBold), color = Tl.text) }
            TopPill({ ask = ScAsk.Positions }) {
                Text("P&L ", style = TlType.small.copy(fontSize = 14.sp, fontWeight = FontWeight.SemiBold), color = Tl.text)
                val net = dash?.netPnl ?: 0.0
                RollingText(inr(net, sign = net != 0.0), TlType.numSm.copy(fontSize = 14.sp, fontWeight = FontWeight.Bold), Tl.money(net))
            }
            TopPill({ ask = ScAsk.Positions }) { Text("Positions" + if (openPos.isNotEmpty()) " ${openPos.size}" else "", style = TlType.small.copy(fontSize = 14.sp, fontWeight = FontWeight.SemiBold), color = Tl.text) }
            TopPill({ ask = ScAsk.Orders }) { Text("Orders" + (dash?.orders?.size?.takeIf { it > 0 }?.let { " $it" } ?: ""), style = TlType.small.copy(fontSize = 14.sp, fontWeight = FontWeight.SemiBold), color = Tl.text) }
            TopPill({ ask = ScAsk.Chain }) {
                Icon(Icons.Rounded.TableRows, null, tint = Tl.mint, modifier = Modifier.size(15.dp)); Spacer(Modifier.width(5.dp))
                Text("Chain", style = TlType.small.copy(fontSize = 14.sp, fontWeight = FontWeight.SemiBold), color = Tl.mint)
            }
            TopPill {
                Dot(if (s.feed == "live") Tl.mint else Tl.amber, 6.dp); Spacer(Modifier.width(6.dp))
                Text(if (s.feed == "live") "LIVE" else s.feed.uppercase(), style = TlType.eyebrow.copy(fontSize = 10.sp), color = if (s.feed == "live") Tl.mint else Tl.amber)
            }
        }
        if (s.error != null) Text(s.error!!, style = TlType.small, color = Tl.red, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp), maxLines = 2)

        // ---- the two charts as cards, index over option, with a handle between them to resize ----
        fun ivLabel(k: String) = INTERVALS.firstOrNull { it.first == k }?.second ?: "${k}m"
        androidx.compose.foundation.layout.BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            val total = constraints.maxHeight.toFloat().coerceAtLeast(1f)
            Column(Modifier.fillMaxSize()) {
                ChartCard(Modifier.weight(split).fillMaxWidth(),
                    title = s.label, onTitle = { ask = ScAsk.Underlying }, kind = "Spot", onKind = { ask = ScAsk.Underlying },
                    price = s.spot, change = spotMove, base = dayOpen, interval = ivLabel(s.interval), onInterval = { studiesSpot = true; ask = ScAsk.Interval },
                    onStudies = { studiesSpot = true; ask = ScAsk.Studies }) {
                    CandleChart(s.spotCandles, fill = true, levels = spotLevels + (if ("oi" in overlays) oi.levels else emptyList()) + spotDay, onMove = ::onMove, onRemove = ::onRemove,
                        onLongPress = { p -> levelAt = p to true; ask = ScAsk.Level }, oiBars = if ("oi" in overlays) oi.bars else emptyList(),
                        intervalSec = spotSec.toInt(), nowMs = now, studies = spotStudies, markers = spotMarks)
                }
                // drag handle: pull up or down to give either chart more room
                Box(Modifier.fillMaxWidth().height(18.dp).pointerInput(Unit) {
                    detectVerticalDragGestures { ch, dy -> ch.consume(); split = (split + dy / total).coerceIn(0.25f, 0.75f) }
                }, contentAlignment = Alignment.Center) {
                    Box(Modifier.width(44.dp).height(4.dp).clip(CircleShape).background(Tl.lineHi))
                }
                ChartCard(Modifier.weight(1f - split).fillMaxWidth(),
                    title = c?.let { "${shortExpiry(it.expiry)} ${"%.0f".format(it.strike)}" } ?: "Pick a strike", onTitle = { ask = ScAsk.Chain },
                    kind = if (s.side == "CE") "Call" else "Put", kindTint = if (s.side == "CE") Tl.green else Tl.red, onKind = { sc.selectSide(if (s.side == "CE") "PE" else "CE") },
                    price = c?.ltp ?: 0.0, change = c?.change?.takeIf { (c.ltp) > 0 && it != 0.0 }, base = c?.let { it.ltp - it.change },
                    tag = if (c != null && c.strike == s.atm) "ATM" else null, interval = ivLabel(s.optInterval), onInterval = { studiesSpot = false; ask = ScAsk.Interval },
                    onStudies = { studiesSpot = false; ask = ScAsk.Studies }) {
                    Box(Modifier.fillMaxSize()) {
                        CandleChart(s.optionCandles, fill = true, levels = levels + optDay, onMove = ::onMove, onRemove = ::onRemove,
                            onLongPress = { p -> levelAt = p to false; ask = ScAsk.Level }, intervalSec = optSec.toInt(), nowMs = now, studies = optStudies, markers = optMarks,
                            onAction = { act ->
                                val p = pos ?: return@CandleChart
                                val long = p.qty > 0; val ref = c?.ltp?.takeIf { it > 0 } ?: p.avg
                                when (act) {
                                    // TP / SL on the entry label: placed 10% of the live price away on the right side (as the web),
                                    // so it is always valid for the server however far the price has moved from the entry.
                                    "add-tp" -> scope.launch { done(sc.setBracket(p.securityId, defaultLevel(true, long, ref), bracket?.sl), "Target set: drag the green line to move it.") }
                                    "add-sl" -> scope.launch { done(sc.setBracket(p.securityId, bracket?.tp, defaultLevel(false, long, ref)), "Stop-loss placed at ${dash?.broker?.label ?: "Dhan"}: drag the orange line to move it.") }
                                    "exit" -> if (now - exitArmedAt > 4_000) exitArmedAt = System.currentTimeMillis() else {
                                        exitArmedAt = 0L
                                        scope.launch { val err = sc.exitPosition(p.symbol); if (err == null) vm.toast("Exit sent for ${p.symbol}.") else vm.toast(err, Toast.Tone.Error) }
                                    }
                                }
                            })
                    }
                }
            }
        }

        // ---- open positions on this chain: one slim live bar each ----
        open.take(1).forEach { p ->
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 3.dp).clip(RoundedCornerShape(14.dp)).background(Tl.surfaceHi)
                    .padding(start = 12.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(if (p.qty > 0) "B" else "S", style = TlType.eyebrow.copy(fontSize = 10.sp), color = if (p.qty > 0) Tl.green else Tl.red)
                Spacer(Modifier.width(8.dp))
                Text("${p.symbol.substringAfter(' ').replace(Regex("^\\d{4}-\\d{2}-\\d{2} "), "")} · ${kotlin.math.abs(p.qty).toLong()}", style = TlType.small.copy(fontWeight = FontWeight.SemiBold), color = Tl.text,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                RollingText(inr(p.unrealized, sign = true), TlType.num.copy(fontSize = 14.sp), Tl.money(p.unrealized))
                Spacer(Modifier.width(8.dp))
                Box(Modifier.tactile({ exitSymbol = p.symbol; ask = ScAsk.Exit }).clip(RoundedCornerShape(9.dp)).background(Tl.red.copy(alpha = 0.16f)).padding(horizontal = 10.dp, vertical = 5.dp)) {
                    Text("Exit", style = TlType.small.copy(fontWeight = FontWeight.Bold), color = Tl.red)
                }
            }
        }

        // ---- ticket: Auto / Manual · Sell [lots] Buy ----
        Column(
            Modifier.fillMaxWidth().padding(top = 4.dp).clip(RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp)).background(Tl.surface)
                .border(1.dp, Tl.line, RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp))
                .padding(start = 16.dp, end = 16.dp, top = 10.dp, bottom = bottomPad.calculateBottomPadding() + 12.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(size.reason ?: "${size.lots} lot${if (size.lots == 1) "" else "s"} × ${s.qtyPerLot}" + (c?.ltp?.takeIf { it > 0 }?.let { " · ${inr(it * size.lots * s.qtyPerLot)}" } ?: ""),
                    style = TlType.small, color = if (size.reason != null) Tl.amber else Tl.muted, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("Auto", style = TlType.small.copy(fontWeight = FontWeight.SemiBold), color = if (!s.manual) Tl.text else Tl.dim)
                Spacer(Modifier.width(6.dp))
                Box(Modifier.tactile({ sc.setManual(!s.manual) })) { PillSwitch(s.manual, Tl.amber, compact = true) }
                Spacer(Modifier.width(6.dp))
                Text("Manual", style = TlType.small.copy(fontWeight = FontWeight.SemiBold), color = if (s.manual) Tl.amber else Tl.dim)
            }
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OrderButton("Sell", s.margin?.takeIf { m -> m.securityId == c?.securityId && m.lots == size.lots }?.sell?.let { inr(it) } ?: if (c != null && size.lots > 0) "…" else "–", Tl.red, Modifier.weight(1f), enabled = c != null && size.lots > 0 && !s.placing) { ask = ScAsk.Sell }
                Row(Modifier.height(52.dp).clip(RoundedCornerShape(14.dp)).background(Tl.surfaceHi), verticalAlignment = Alignment.CenterVertically) {
                    Step("−", s.manual) { sc.stepLots(-1) }
                    LotsField(size.lots) { sc.setLots(it) }
                    Step("+", s.manual) { sc.stepLots(1) }
                }
                OrderButton("Buy", c?.ltp?.takeIf { it > 0 && size.lots > 0 }?.let { inr(it * size.lots * s.qtyPerLot) } ?: "–", Tl.green, Modifier.weight(1f), enabled = c != null && size.lots > 0 && !s.placing) { ask = ScAsk.Buy }
            }
        }
    }

    when (ask) {
        ScAsk.None -> Unit
        ScAsk.Underlying -> TlSheet({ ask = ScAsk.None }) {
            Text("Instrument", style = TlType.title, color = Tl.text); Spacer(Modifier.height(12.dp))
            listOf(false to "Equity", true to "Commodity").forEach { (mcx, title) ->
                Eyebrow(title, Modifier.padding(top = 8.dp, bottom = 8.dp))
                s.underlyings.filter { it.mcx == mcx }.forEach { u ->
                    val on = u.key == s.underlying
                    Row(Modifier.fillMaxWidth().tactile({ ask = ScAsk.None; sc.setUnderlying(u.key) }).clip(RoundedCornerShape(14.dp))
                        .background(if (on) Tl.mint.copy(alpha = 0.10f) else Color.Transparent).padding(horizontal = 14.dp, vertical = 14.dp)) {
                        Text(u.label, style = TlType.label.copy(fontSize = 16.sp), color = if (on) Tl.mint else Tl.text)
                    }
                }
            }
        }
        ScAsk.Expiry -> TlSheet({ ask = ScAsk.None }) {
            Text("Expiry", style = TlType.title, color = Tl.text); Spacer(Modifier.height(12.dp))
            s.expiries.forEach { e ->
                val on = e == s.expiry
                Row(Modifier.fillMaxWidth().tactile({ ask = ScAsk.None; sc.setExpiry(e) }).clip(RoundedCornerShape(14.dp))
                    .background(if (on) Tl.mint.copy(alpha = 0.10f) else Color.Transparent).padding(horizontal = 14.dp, vertical = 14.dp)) {
                    Text(e, style = TlType.num.copy(fontSize = 16.sp), color = if (on) Tl.mint else Tl.text)
                }
            }
        }
        ScAsk.Buy, ScAsk.Sell -> {
            val side = if (ask == ScAsk.Buy) "BUY" else "SELL"
            val tint = if (side == "BUY") Tl.green else Tl.red
            TlSheet({ ask = ScAsk.None }) {
                Eyebrow("Market order · ${dash?.broker?.label ?: "Dhan"}")
                Spacer(Modifier.height(8.dp))
                Text("$side ${c?.symbol ?: ""}", style = TlType.title.copy(fontSize = 22.sp), color = tint)
                Spacer(Modifier.height(14.dp))
                OrderRow("Lots", "${size.lots} × ${s.qtyPerLot} = ${size.lots * s.qtyPerLot}")
                OrderRow("Price now", c?.ltp?.let { "%.2f".format(it) } ?: "–")
                OrderRow("Value", inr((c?.ltp ?: 0.0) * size.lots * s.qtyPerLot))
                Text("Your risk rules check the order before it reaches ${dash?.broker?.label ?: "Dhan"}.", style = TlType.small, color = Tl.dim, modifier = Modifier.padding(top = 8.dp))
                Spacer(Modifier.height(18.dp))
                HoldToConfirm("Hold to ${side.lowercase()}", "Keep holding…", tint, Modifier.fillMaxWidth()) {
                    ask = ScAsk.None
                    scope.launch {
                        val err = sc.placeOrder(side)
                        if (err == null) vm.toast("$side ${size.lots} lot${if (size.lots == 1) "" else "s"} ${c?.symbol} sent to ${dash?.broker?.label ?: "Dhan"}.", Toast.Tone.Ok)
                        else vm.toast(err, Toast.Tone.Error)
                    }
                }
                Spacer(Modifier.height(10.dp))
                GhostButton("Cancel", Modifier.fillMaxWidth()) { ask = ScAsk.None }
            }
        }
        ScAsk.Level -> {
            val (raw, onIndex) = levelAt ?: (0.0 to false)
            val p = com.nexlogic.tradelock.data.tick(raw)
            val ref = if (onIndex) s.spot else c?.ltp ?: 0.0
            val rel = if (ref > 0) (if (p > ref) "above" else if (p < ref) "below" else "at") else ""
            TlSheet({ ask = ScAsk.None }) {
                Eyebrow(if (onIndex) s.label else c?.symbol ?: "")
                Spacer(Modifier.height(6.dp))
                Row(verticalAlignment = Alignment.Bottom) {
                    Text("%.2f".format(p), style = TlType.hero, color = Tl.text)
                    Spacer(Modifier.width(10.dp))
                    if (rel.isNotEmpty()) Text("$rel LTP ${"%.2f".format(ref)}", style = TlType.small, color = Tl.muted, modifier = Modifier.padding(bottom = 6.dp))
                }
                Spacer(Modifier.height(16.dp))
                if (!onIndex && c != null && size.lots > 0) {
                    val lotTxt = "${size.lots} lot${if (size.lots == 1) "" else "s"}"
                    val buyStop = com.nexlogic.tradelock.data.isStop("BUY", p, ref); val sellStop = com.nexlogic.tradelock.data.isStop("SELL", p, ref)
                    val at = dash?.broker?.label ?: "Dhan"
                    ActionRow(if (buyStop) "Buy stop" else "Buy limit", "$lotTxt ${if (buyStop) "when it rises to" else "@"} ${"%.2f".format(p)}", ORDER_BLUE) {
                        ask = ScAsk.None; scope.launch { done(sc.placeLimit("BUY", p, ref), "${if (buyStop) "Buy stop" else "Buy limit"} @ ${"%.2f".format(p)} placed at $at.") }
                    }
                    ActionRow(if (sellStop) "Sell stop" else "Sell limit", "$lotTxt ${if (sellStop) "when it falls to" else "@"} ${"%.2f".format(p)}", Tl.amber) {
                        ask = ScAsk.None; scope.launch { done(sc.placeLimit("SELL", p, ref), "${if (sellStop) "Sell stop" else "Sell limit"} @ ${"%.2f".format(p)} placed at $at.") }
                    }
                }
                ActionRow("Price alert", "rings when it ${if (ref > 0 && p < ref) "falls to" else "reaches"} ${"%.2f".format(p)}", Tl.violet) {
                    ask = ScAsk.None
                    scope.launch { done(sc.createAlert(p, if (onIndex) null else c), "Alert set: TradeLock rings at ${"%.2f".format(p)}.") }
                }
                Spacer(Modifier.height(6.dp))
                GhostButton("Cancel", Modifier.fillMaxWidth()) { ask = ScAsk.None }
            }
        }
        ScAsk.Chain -> TlSheet({ ask = ScAsk.None }) {
            // The option chain: tap a call or a put premium to trade that contract.
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Option chain", style = TlType.title, color = Tl.text)
                    Text("${s.label} ${"%,.2f".format(s.spot)} · ${shortExpiry(s.expiry)}", style = TlType.small, color = Tl.muted)
                }
                Text(shortExpiry(s.expiry) + " ▾", style = TlType.small.copy(fontWeight = FontWeight.Bold), color = Tl.mint, modifier = Modifier.tactile({ ask = ScAsk.Expiry }).padding(8.dp))
            }
            Spacer(Modifier.height(10.dp))
            Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 6.dp)) {
                Text("CALL", style = TlType.eyebrow.copy(fontSize = 10.sp), color = Tl.green, modifier = Modifier.weight(1f))
                Text("STRIKE", style = TlType.eyebrow.copy(fontSize = 10.sp), color = Tl.muted, modifier = Modifier.weight(0.9f), textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                Text("PUT", style = TlType.eyebrow.copy(fontSize = 10.sp), color = Tl.red, modifier = Modifier.weight(1f), textAlign = androidx.compose.ui.text.style.TextAlign.End)
            }
            val list = rememberLazyListState()
            LaunchedEffect(Unit) { val i = s.strikes.indexOfFirst { it.strike == (s.strike ?: s.atm) }; if (i > 0) list.scrollToItem((i - 4).coerceAtLeast(0)) }
            LazyColumn(state = list, modifier = Modifier.fillMaxWidth().height(430.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                items(s.strikes, key = { it.strike }) { row ->
                    val atm = row.strike == s.atm
                    val itm = s.spot > 0 && row.strike < s.spot   // calls below the price / puts above it are in the money
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(if (atm) Tl.amber.copy(alpha = 0.08f) else Color.Transparent)
                            .border(1.dp, if (atm) Tl.amber.copy(alpha = 0.4f) else Tl.line, RoundedCornerShape(12.dp)),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        ChainCell(row.ce, row.strike == s.strike && s.side == "CE", Tl.green, itm, Alignment.Start, Modifier.weight(1f)) {
                            sc.selectStrike(row.strike); sc.selectSide("CE"); ask = ScAsk.None
                        }
                        Column(Modifier.weight(0.9f), horizontalAlignment = Alignment.CenterHorizontally) {
                            Text("%.0f".format(row.strike), style = TlType.num.copy(fontSize = 15.sp, fontWeight = FontWeight.Bold), color = if (atm) Tl.amber else Tl.text)
                            if (atm) Text("ATM", style = TlType.eyebrow.copy(fontSize = 8.sp), color = Tl.amber)
                        }
                        ChainCell(row.pe, row.strike == s.strike && s.side == "PE", Tl.red, !itm && !atm, Alignment.End, Modifier.weight(1f)) {
                            sc.selectStrike(row.strike); sc.selectSide("PE"); ask = ScAsk.None
                        }
                    }
                }
            }
        }
        ScAsk.Interval -> TlSheet({ ask = ScAsk.None }) {
            Text("Candle interval", style = TlType.title, color = Tl.text)
            Text(if (studiesSpot) "${s.label} chart" else "${c?.symbol ?: "Option"} chart", style = TlType.small, color = Tl.muted)
            Spacer(Modifier.height(12.dp))
            val cur = if (studiesSpot) s.interval else s.optInterval
            INTERVALS.forEach { (k, l) ->
                val on = cur == k
                Row(Modifier.fillMaxWidth().tactile({ ask = ScAsk.None; if (studiesSpot) sc.setInterval(k) else sc.setOptInterval(k) }).clip(RoundedCornerShape(14.dp))
                    .background(if (on) Tl.mint.copy(alpha = 0.10f) else Color.Transparent).padding(horizontal = 14.dp, vertical = 14.dp)) {
                    Text("$l · ${if (k == "60") "1 hour" else "$k minute${if (k == "1") "" else "s"}"}", style = TlType.label.copy(fontSize = 16.sp), color = if (on) Tl.mint else Tl.text)
                }
            }
        }
        ScAsk.Studies -> ChartToolsSheet(
            startOnSpot = studiesSpot, spotName = s.label, optName = c?.let { "${"%.0f".format(it.strike)} ${it.option}" } ?: "Option", spotInterval = s.interval,
            spotStudies = spotStudies, optStudies = optStudies, onStudies = ::saveStudies,
            overlays = overlays, onOverlay = ::toggleOverlay, admin = admin, strategies = strategies, onStrategy = ::toggleStrategy,
            onToast = { vm.toast(it) }, onDismiss = { ask = ScAsk.None })
        ScAsk.Positions -> TlSheet({ ask = ScAsk.None }) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Positions", style = TlType.title, color = Tl.text, modifier = Modifier.weight(1f))
                val net = dash?.netPnl ?: 0.0
                Text("Net ${inr(net, sign = true)}", style = TlType.num, color = Tl.money(net))
            }
            dash?.let { d -> Text("Realized ${inr(d.realized, sign = true)} · open ${inr(d.unrealized, sign = true)} · charges ${inr(d.charges)}", style = TlType.small, color = Tl.muted, modifier = Modifier.padding(top = 4.dp)) }
            Spacer(Modifier.height(12.dp))
            val rows = dash?.positions.orEmpty()
            if (rows.isEmpty()) Text("No positions today.", style = TlType.body, color = Tl.muted, modifier = Modifier.padding(vertical = 20.dp))
            rows.forEach { p ->
                Row(Modifier.fillMaxWidth().padding(vertical = 4.dp).clip(RoundedCornerShape(14.dp)).background(Tl.surfaceHi).padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    // Tap the name: open this contract in the option chart (its index / expiry is loaded first when needed).
                    Column(Modifier.weight(1f).tactile({
                        if (p.qty != 0.0) scope.launch {
                            if (sc.openContract(p.securityId, p.symbol, p.segment)) ask = ScAsk.None
                            else vm.toast("That contract is not in Power Scalper's option chains.", Toast.Tone.Warn)
                        }
                    })) {
                        Text(p.symbol, style = TlType.label, color = Tl.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(if (p.qty != 0.0) "${if (p.qty > 0) "Long" else "Short"} ${kotlin.math.abs(p.qty).toLong()} · avg ${"%.2f".format(p.avg)}" + (p.ltp?.let { " · LTP ${"%.2f".format(it)}" } ?: "") else "Closed",
                            style = TlType.small, color = Tl.muted)
                    }
                    val pl = p.unrealized + p.realized
                    Text(inr(pl, sign = true), style = TlType.num.copy(fontSize = 15.sp), color = Tl.money(pl))
                    if (p.qty != 0.0) {
                        Spacer(Modifier.width(8.dp))
                        Box(Modifier.tactile({ exitSymbol = p.symbol; ask = ScAsk.Exit }).clip(RoundedCornerShape(9.dp)).background(Tl.red.copy(alpha = 0.16f)).padding(horizontal = 10.dp, vertical = 6.dp)) {
                            Text("Exit", style = TlType.small.copy(fontWeight = FontWeight.Bold), color = Tl.red)
                        }
                    }
                }
            }
        }
        ScAsk.Orders -> TlSheet({ ask = ScAsk.None }) {
            Text("Open orders", style = TlType.title, color = Tl.text); Spacer(Modifier.height(12.dp))
            val rows = dash?.orders.orEmpty()
            if (rows.isEmpty()) Text("No open orders.", style = TlType.body, color = Tl.muted, modifier = Modifier.padding(vertical = 20.dp))
            rows.forEach { o ->
                val name = s.strikes.firstNotNullOfOrNull { r -> listOfNotNull(r.ce, r.pe).firstOrNull { it.securityId == o.securityId }?.symbol } ?: o.securityId ?: ""
                Row(Modifier.fillMaxWidth().padding(vertical = 4.dp).clip(RoundedCornerShape(14.dp)).background(Tl.surfaceHi).padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("${o.side} ${o.type} · ${o.qty.toLong()}", style = TlType.label, color = if (o.side == "BUY") Tl.green else Tl.red)
                        Text(name + (if (o.price > 0) " @ ${"%.2f".format(o.price)}" else "") + (o.triggerPrice?.takeIf { it > 0 }?.let { " · trigger ${"%.2f".format(it)}" } ?: ""), style = TlType.small, color = Tl.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    Box(Modifier.tactile({ scope.launch { done(sc.cancelOrder(o.id), "Order cancelled.") } }).clip(RoundedCornerShape(9.dp)).background(Tl.red.copy(alpha = 0.16f)).padding(horizontal = 10.dp, vertical = 6.dp)) {
                        Text("Cancel", style = TlType.small.copy(fontWeight = FontWeight.Bold), color = Tl.red)
                    }
                }
            }
        }
        ScAsk.Exit -> TlSheet({ ask = ScAsk.None }) {
            Text("Exit ${exitSymbol ?: ""}?", style = TlType.title.copy(fontSize = 22.sp), color = Tl.text)
            Spacer(Modifier.height(10.dp))
            Text("Closes the whole position at market.", style = TlType.body, color = Tl.muted)
            Spacer(Modifier.height(18.dp))
            HoldToConfirm("Hold to exit", "Keep holding…", Tl.red, Modifier.fillMaxWidth()) {
                ask = ScAsk.None
                val sym = exitSymbol ?: return@HoldToConfirm
                scope.launch { val err = sc.exitPosition(sym); if (err == null) vm.toast("Exit sent for $sym.") else vm.toast(err, Toast.Tone.Error) }
            }
            Spacer(Modifier.height(10.dp))
            GhostButton("Cancel", Modifier.fillMaxWidth()) { ask = ScAsk.None }
        }
    }
}

@Composable
private fun Chip(label: String, on: Boolean, onClick: () -> Unit) {
    val bg by animateColorAsState(if (on) Tl.mint.copy(alpha = 0.14f) else Tl.surface, tween(180), label = "chip")
    Box(Modifier.tactile(onClick).clip(CircleShape).background(bg).border(1.dp, if (on) Tl.mint.copy(alpha = 0.6f) else Tl.lineHi, CircleShape).padding(horizontal = 14.dp, vertical = 7.dp)) {
        Text(label, style = TlType.small.copy(fontWeight = FontWeight.SemiBold, fontSize = 13.sp), color = if (on) Tl.mint else Tl.muted)
    }
}

@Composable
private fun StrikeStrip(strikes: List<Double>, selected: Double?, atm: Double?, contractOf: (Double) -> Contract?, onPick: (Double) -> Unit) {
    val list = rememberLazyListState()
    LaunchedEffect(strikes.size, atm) {
        val i = strikes.indexOfFirst { it == (selected ?: atm) }
        if (i >= 0) list.scrollToItem((i - 2).coerceAtLeast(0))
    }
    LazyRow(state = list, contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        itemsIndexed(strikes, key = { _, k -> k }) { _, k ->
            val on = k == selected
            val c = contractOf(k)
            Column(
                Modifier.tactile({ onPick(k) }).clip(RoundedCornerShape(14.dp))
                    .background(if (on) Tl.mint.copy(alpha = 0.14f) else Tl.surface)
                    .border(1.dp, if (on) Tl.mint.copy(alpha = 0.7f) else if (k == atm) Tl.amber.copy(alpha = 0.5f) else Tl.line, RoundedCornerShape(14.dp))
                    .padding(horizontal = 14.dp, vertical = 9.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text("%.0f".format(k), style = TlType.numSm.copy(fontSize = 13.sp, fontWeight = FontWeight.Bold), color = if (on) Tl.mint else Tl.text)
                Text(c?.let { "%.2f".format(it.ltp) } ?: "–", style = TlType.numSm.copy(fontSize = 11.sp), color = Tl.muted)
                if (k == atm) Text("ATM", style = TlType.eyebrow.copy(fontSize = 8.sp), color = Tl.amber)
            }
        }
    }
}

@Composable
private fun OrderButton(side: String, amount: String, tint: Color, modifier: Modifier, enabled: Boolean, onClick: () -> Unit) {
    val ink = if (tint == Tl.green) Color(0xFF032414) else Color(0xFF1C0309)
    // top half: the side, small; bottom half: the amount (Buy: live premium × qty · Sell: Dhan's margin), rolling with each update
    Column(modifier.height(52.dp).tactile(onClick, enabled = enabled).clip(RoundedCornerShape(14.dp)).background(if (enabled) tint else tint.copy(alpha = 0.25f)),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Text(side, color = ink.copy(alpha = 0.75f), fontWeight = FontWeight.Bold, fontSize = 11.sp, lineHeight = 13.sp)
        RollingText(amount, TlType.num.copy(fontWeight = FontWeight.ExtraBold, fontSize = 14.sp), ink)
    }
}

@Composable
private fun Step(label: String, enabled: Boolean, onClick: () -> Unit) =
    Box(Modifier.size(40.dp, 52.dp).tactile(onClick, enabled = enabled), contentAlignment = Alignment.Center) {
        Text(label, style = TlType.title, color = if (enabled) Tl.text else Tl.dim)
    }

/** "2026-11-23" → "23 Nov". */
private fun shortExpiry(e: String): String = runCatching { java.time.LocalDate.parse(e).format(java.time.format.DateTimeFormatter.ofPattern("d MMM")) }.getOrDefault(e.ifEmpty { "Expiry" })

/** One pill of the top bar (tappable when [onClick] is set). */
@Composable
private fun TopPill(onClick: (() -> Unit)? = null, content: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit) =
    Row(Modifier.then(if (onClick != null) Modifier.tactile(onClick) else Modifier).clip(CircleShape).background(Tl.surface).border(1.dp, Tl.line, CircleShape)
        .padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically, content = content)

/**
 * A chart in a rounded card: the instrument (underlined, tap to change) with its kind (Spot / Call / Put, tap to switch),
 * the live price and its move, and the interval pill on the right.
 */
@Composable
private fun ChartCard(
    modifier: Modifier, title: String, onTitle: () -> Unit, kind: String, onKind: () -> Unit, price: Double, change: Double?, base: Double?,
    interval: String, onInterval: () -> Unit, onStudies: () -> Unit, kindTint: Color = Tl.text, tag: String? = null, chart: @Composable () -> Unit,
) = Column(modifier.padding(horizontal = 8.dp).clip(RoundedCornerShape(22.dp)).background(Tl.surface).border(1.dp, Tl.line, RoundedCornerShape(22.dp)).padding(top = 10.dp)) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(title, style = TlType.label.copy(fontSize = 17.sp, textDecoration = androidx.compose.ui.text.style.TextDecoration.Underline), color = Tl.text, maxLines = 1,
                    modifier = Modifier.tactile(onTitle, haptic = false))
                Spacer(Modifier.width(10.dp))
                Row(Modifier.tactile(onKind), verticalAlignment = Alignment.CenterVertically) {
                    Text(kind, style = TlType.label.copy(fontSize = 16.sp, fontWeight = FontWeight.Medium), color = kindTint)
                    Icon(Icons.Rounded.UnfoldMore, null, tint = Tl.muted, modifier = Modifier.size(18.dp))
                }
                tag?.let { Spacer(Modifier.width(6.dp)); Text(it, style = TlType.eyebrow.copy(fontSize = 9.sp), color = Tl.amber, modifier = Modifier.clip(CircleShape).background(Tl.amber.copy(alpha = 0.14f)).padding(horizontal = 6.dp, vertical = 2.dp)) }
            }
            Row(verticalAlignment = Alignment.Bottom) {
                RollingText(if (price > 0) "%.2f".format(price) else "–", TlType.num.copy(fontSize = 17.sp), Tl.text)
                change?.let { mv ->
                    Spacer(Modifier.width(8.dp))
                    Text("%+.2f%s".format(mv, base?.takeIf { it > 0 }?.let { " (%+.2f%%)".format(mv / it * 100) } ?: ""), style = TlType.numSm.copy(fontSize = 13.sp), color = Tl.money(mv), modifier = Modifier.padding(bottom = 1.dp))
                }
            }
        }
        // fx: this chart's indicators
        Box(Modifier.padding(end = 8.dp).tactile(onStudies).clip(CircleShape).background(Tl.surfaceHi).padding(horizontal = 12.dp, vertical = 7.dp)) {
            Text("ƒx", style = TlType.small.copy(fontSize = 15.sp, fontWeight = FontWeight.Bold, fontStyle = androidx.compose.ui.text.font.FontStyle.Italic), color = Tl.text)
        }
        Row(Modifier.tactile(onInterval).clip(CircleShape).background(Tl.surfaceHi).padding(horizontal = 12.dp, vertical = 7.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(interval, style = TlType.small.copy(fontSize = 14.sp, fontWeight = FontWeight.SemiBold), color = Tl.text)
            Box(Modifier.padding(horizontal = 7.dp).width(1.dp).height(14.dp).background(Tl.lineHi))
            Icon(Icons.Rounded.Tune, null, tint = Tl.muted, modifier = Modifier.size(16.dp))
        }
    }
    Box(Modifier.weight(1f).fillMaxWidth().padding(start = 4.dp, top = 2.dp, bottom = 4.dp)) { chart() }
}

/** A small label over the top-left of a chart. */
@Composable
private fun ChartTag(text: String, modifier: Modifier) =
    Text(text, style = TlType.eyebrow.copy(fontSize = 9.sp), color = Tl.muted,
        modifier = modifier.padding(start = 8.dp, top = 2.dp).clip(RoundedCornerShape(6.dp)).background(Tl.bg.copy(alpha = 0.75f)).padding(horizontal = 6.dp, vertical = 3.dp))

/** One side of a chain row: the premium (big) and open interest; in-the-money sides get a soft tint. */
@Composable
private fun ChainCell(x: Contract?, selected: Boolean, tint: Color, itm: Boolean, align: Alignment.Horizontal, modifier: Modifier, onPick: () -> Unit) {
    Column(
        modifier.tactile(onPick, enabled = x != null).clip(RoundedCornerShape(10.dp))
            .background(if (selected) tint.copy(alpha = 0.22f) else if (itm) tint.copy(alpha = 0.06f) else Color.Transparent)
            .padding(horizontal = 12.dp, vertical = 9.dp),
        horizontalAlignment = align,
    ) {
        Text(x?.let { "%.2f".format(it.ltp) } ?: "–", style = TlType.num.copy(fontSize = 15.sp, fontWeight = FontWeight.Bold), color = if (selected) tint else Tl.text)
        x?.oi?.takeIf { it > 0 }?.let { Text("OI " + when { it >= 1e7 -> "%.1fCr".format(it / 1e7); it >= 1e5 -> "%.1fL".format(it / 1e5); it >= 1e3 -> "%.0fk".format(it / 1e3); else -> "%.0f".format(it) }, style = TlType.small.copy(fontSize = 10.sp), color = Tl.dim) }
    }
}

@Composable
private fun LevelChip(label: String, tint: Color, onClick: () -> Unit) =
    Box(Modifier.tactile(onClick).clip(CircleShape).background(Tl.surface).border(1.dp, tint.copy(alpha = 0.7f), CircleShape).padding(horizontal = 14.dp, vertical = 7.dp)) {
        Text(label, style = TlType.label.copy(fontSize = 13.sp), color = tint)
    }

@Composable
private fun ActionRow(title: String, sub: String, tint: Color, onClick: () -> Unit) =
    Row(
        Modifier.fillMaxWidth().padding(vertical = 4.dp).tactile(onClick).clip(RoundedCornerShape(16.dp)).background(tint.copy(alpha = 0.10f))
            .border(1.dp, tint.copy(alpha = 0.35f), RoundedCornerShape(16.dp)).padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(10.dp).clip(CircleShape).background(tint))
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = TlType.label.copy(fontSize = 16.sp), color = Tl.text)
            Text(sub, style = TlType.small, color = Tl.muted)
        }
    }

@Composable
private fun OrderRow(k: String, v: String) =
    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Text(k, style = TlType.body.copy(fontSize = 15.sp), color = Tl.muted, modifier = Modifier.weight(1f))
        Text(v, style = TlType.num, color = Tl.text)
    }

/**
 * The lot count on the ticket, typed with the number keypad: Done or leaving the field saves it (1–500; empty or 0
 * puts the last value back). While it is not being edited it follows the ticket (− / +, Auto sizing).
 */
@Composable
private fun LotsField(lots: Int, onSet: (Int) -> Unit) {
    var text by remember { mutableStateOf(lots.toString()) }
    var editing by remember { mutableStateOf(false) }
    val focus = androidx.compose.ui.platform.LocalFocusManager.current
    LaunchedEffect(lots) { if (!editing) text = lots.toString() }
    fun commit() {
        val n = text.toIntOrNull()
        if (n != null && n > 0) { onSet(n.coerceAtMost(500)); text = n.coerceAtMost(500).toString() } else text = lots.toString()
    }
    androidx.compose.foundation.text.BasicTextField(
        value = text,
        onValueChange = { v -> text = v.filter(Char::isDigit).take(3) },
        singleLine = true,
        textStyle = TlType.num.copy(fontSize = 18.sp, fontWeight = FontWeight.Bold, color = Tl.text, textAlign = androidx.compose.ui.text.style.TextAlign.Center),
        cursorBrush = androidx.compose.ui.graphics.SolidColor(Tl.amber),
        keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.NumberPassword, imeAction = androidx.compose.ui.text.input.ImeAction.Done),
        keyboardActions = androidx.compose.foundation.text.KeyboardActions(onDone = { commit(); focus.clearFocus() }),
        modifier = Modifier.width(52.dp).onFocusChanged { f ->
            if (f.isFocused) editing = true
            else if (editing) { editing = false; commit() }
        },
    )
}
