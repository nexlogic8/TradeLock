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

private val INTERVALS = listOf("1" to "1m", "5" to "5m", "15" to "15m")
private enum class ScAsk { None, Underlying, Expiry, Buy, Sell, Exit, Level }
private val ORDER_BLUE = Color(0xFF5AA9FF)

@Composable
fun ScalperScreen(vm: AppViewModel, bottomPad: PaddingValues) {
    val sc: ScalperViewModel = viewModel()
    LaunchedEffect(Unit) { sc.start() }
    val s by sc.state.collectAsState()
    val dash by vm.dash.collectAsState()
    var ask by remember { mutableStateOf(ScAsk.None) }
    var exitSymbol by remember { mutableStateOf<String?>(null) }
    var levelAt by remember { mutableStateOf<Pair<Double, Boolean>?>(null) }   // long-pressed price, on the index chart?
    val scope = rememberCoroutineScope()
    val c = s.contract
    val size = sc.sizeFor(s)
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
    val levels = buildList {
        pos?.let { p -> add(ChartLevel(p.avg, if (p.qty > 0) Tl.mint else Tl.red, "${if (p.qty > 0) "BUY" else "SELL"} ${"%.2f".format(p.avg)} · ${inr(p.unrealized, sign = true)}", dashed = false)) }
        if (pos != null) {
            bracket?.tp?.let { tp -> val v = at("tp", tp); add(ChartLevel(v, Tl.green, "TP ${"%.2f".format(v)} · ${inr(pnlAt(v), sign = true)}", id = "tp", draggable = true, removable = true)) }
            bracket?.sl?.let { sl -> val v = at("sl", sl); add(ChartLevel(v, Tl.red, "SL ${"%.2f".format(v)} · ${inr(pnlAt(v), sign = true)}", id = "sl", draggable = true, removable = true)) }
        }
        dash?.orders.orEmpty().filter { it.securityId == c?.securityId && it.type == "LIMIT" }.forEach { o ->
            val v = at("o:${o.id}", o.price)
            add(ChartLevel(v, if (o.side == "BUY") ORDER_BLUE else Tl.amber, "${o.side} LMT ${"%.2f".format(v)} · ${(o.qty / s.qtyPerLot.coerceAtLeast(1)).toInt()} lot", id = "o:${o.id}", draggable = true, removable = true))
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
                id.startsWith("o:") -> done(sc.moveOrder(id.removePrefix("o:"), price), "Limit order moved to ${"%.2f".format(com.nexlogic.tradelock.data.tick(price))}.")
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

    Column(Modifier.fillMaxSize().background(Tl.bg).statusBarsPadding()) {
        // ---- top bar: instrument, live price, feed ----
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Row(
                Modifier.tactile({ ask = ScAsk.Underlying }).clip(RoundedCornerShape(14.dp)).background(Tl.surface).border(1.dp, Tl.lineHi, RoundedCornerShape(14.dp))
                    .padding(horizontal = 12.dp, vertical = 9.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(s.label, style = TlType.label.copy(fontSize = 15.sp), color = Tl.text, maxLines = 1)
                Icon(Icons.Rounded.KeyboardArrowDown, null, tint = Tl.muted, modifier = Modifier.size(18.dp))
            }
            Spacer(Modifier.width(12.dp))
            RollingText("%,.2f".format(s.spot), TlType.num.copy(fontSize = 18.sp, fontWeight = FontWeight.Bold), Tl.text)
            Spacer(Modifier.weight(1f))
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.clip(CircleShape).background(Tl.surfaceHi).padding(horizontal = 10.dp, vertical = 5.dp)) {
                Dot(if (s.feed == "live") Tl.mint else Tl.amber, 6.dp); Spacer(Modifier.width(6.dp))
                Text(if (s.feed == "live") "LIVE" else s.feed.uppercase(), style = TlType.eyebrow.copy(fontSize = 9.sp), color = if (s.feed == "live") Tl.mint else Tl.amber)
            }
        }
        // ---- interval + expiry ----
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            INTERVALS.forEach { (k, l) -> Chip(l, s.interval == k) { sc.setInterval(k) } }
            Spacer(Modifier.weight(1f))
            Chip(s.expiry.ifEmpty { "Expiry" } + " ▾", false) { ask = ScAsk.Expiry }
        }

        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            if (s.error != null) Text(s.error!!, style = TlType.body, color = Tl.red, modifier = Modifier.padding(16.dp))
            // index chart
            Box(Modifier.padding(start = 8.dp, end = 4.dp, top = 8.dp)) {
                CandleChart(s.spotCandles, height = 210.dp, levels = spotLevels, onMove = ::onMove, onRemove = ::onRemove,
                    onLongPress = { p -> levelAt = p to true; ask = ScAsk.Level })
                if (s.loading && s.spotCandles.isEmpty()) CircularProgressIndicator(Modifier.align(Alignment.Center).size(28.dp), color = Tl.mint, strokeWidth = 2.5.dp)
            }
            // strike strip
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Eyebrow("Strike", Modifier.weight(1f))
                Row(Modifier.clip(RoundedCornerShape(12.dp)).background(Tl.surfaceHi).padding(3.dp)) {
                    listOf("CE" to Tl.green, "PE" to Tl.red).forEach { (k, col) ->
                        val on = s.side == k
                        Box(Modifier.tactile({ sc.selectSide(k) }).clip(RoundedCornerShape(10.dp)).background(if (on) col.copy(alpha = 0.18f) else Color.Transparent).padding(horizontal = 18.dp, vertical = 7.dp)) {
                            Text(k, style = TlType.label, color = if (on) col else Tl.muted)
                        }
                    }
                }
            }
            StrikeStrip(s.strikes.map { it.strike }, s.strike, s.atm, { st -> s.strikes.firstOrNull { it.strike == st }?.let { if (s.side == "CE") it.ce else it.pe } }) { sc.selectStrike(it) }
            // option chart
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(c?.let { "${"%.0f".format(it.strike)} ${it.option}" } ?: "—", style = TlType.title, color = if (s.side == "CE") Tl.green else Tl.red)
                Spacer(Modifier.width(10.dp))
                Text(c?.expiry ?: "", style = TlType.small, color = Tl.muted, modifier = Modifier.weight(1f))
                RollingText(c?.let { "%.2f".format(it.ltp) } ?: "–", TlType.num.copy(fontSize = 18.sp, fontWeight = FontWeight.Bold), Tl.text)
            }
            // Before a target / stop is set: one tap places it 20% from the entry, then drag it where it belongs.
            if (pos != null && (bracket?.tp == null || bracket.sl == null)) {
                Row(Modifier.padding(horizontal = 16.dp).padding(bottom = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    val long = pos.qty > 0
                    if (bracket?.tp == null) LevelChip("+ TP", Tl.green) {
                        scope.launch { done(sc.setBracket(pos.securityId, pos.avg * (if (long) 1.2 else 0.8), bracket?.sl), "Target set: drag the green line to move it.") }
                    }
                    if (bracket?.sl == null) LevelChip("+ SL", Tl.red) {
                        scope.launch { done(sc.setBracket(pos.securityId, bracket?.tp, pos.avg * (if (long) 0.8 else 1.2)), "Stop-loss placed at ${dash?.broker?.label ?: "Dhan"}: drag the red line to move it.") }
                    }
                }
            }
            Box(Modifier.padding(start = 8.dp, end = 4.dp)) {
                CandleChart(s.optionCandles, height = 220.dp, levels = levels, onMove = ::onMove, onRemove = ::onRemove,
                    onLongPress = { p -> levelAt = p to false; ask = ScAsk.Level })
            }
            Text("Long-press a chart for a limit order or an alert · drag a line to move it · ✕ removes it",
                style = TlType.small.copy(fontSize = 11.sp), color = Tl.dim, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
            // open positions on this chain
            if (open.isNotEmpty()) {
                Eyebrow("Open positions", Modifier.padding(start = 16.dp, top = 14.dp, bottom = 8.dp))
                open.forEach { p ->
                    TlCard(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), padding = 14.dp, shape = RoundedCornerShape(18.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(p.symbol, style = TlType.label, color = Tl.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text("${if (p.qty > 0) "BUY" else "SELL"} ${kotlin.math.abs(p.qty).toLong()} · avg ${"%.2f".format(p.avg)} → ${p.ltp?.let { "%.2f".format(it) } ?: "–"}", style = TlType.numSm, color = Tl.muted)
                            }
                            RollingText(inr(p.unrealized, sign = true), TlType.num, Tl.money(p.unrealized))
                            Spacer(Modifier.width(10.dp))
                            Box(Modifier.tactile({ exitSymbol = p.symbol; ask = ScAsk.Exit }).clip(RoundedCornerShape(10.dp)).background(Tl.red.copy(alpha = 0.14f)).padding(horizontal = 12.dp, vertical = 8.dp)) {
                                Text("Exit", style = TlType.label, color = Tl.red)
                            }
                        }
                    }
                }
            }
            Spacer(Modifier.height(16.dp))
        }

        // ---- ticket: Auto / Manual · Sell [lots] Buy ----
        Column(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp)).background(Tl.surface)
                .border(1.dp, Tl.line, RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp))
                .padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = bottomPad.calculateBottomPadding() + 4.dp),
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
            Spacer(Modifier.height(10.dp))
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OrderButton("Sell", Tl.red, Modifier.weight(1f), enabled = c != null && size.lots > 0 && !s.placing) { ask = ScAsk.Sell }
                Row(Modifier.height(52.dp).clip(RoundedCornerShape(14.dp)).background(Tl.surfaceHi), verticalAlignment = Alignment.CenterVertically) {
                    Step("−", s.manual) { sc.stepLots(-1) }
                    Text("${size.lots}", style = TlType.num.copy(fontSize = 18.sp, fontWeight = FontWeight.Bold), color = Tl.text, modifier = Modifier.width(40.dp), textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                    Step("+", s.manual) { sc.stepLots(1) }
                }
                OrderButton("Buy", Tl.green, Modifier.weight(1f), enabled = c != null && size.lots > 0 && !s.placing) { ask = ScAsk.Buy }
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
                    ActionRow("Buy limit", "${size.lots} lot${if (size.lots == 1) "" else "s"} @ ${"%.2f".format(p)}", ORDER_BLUE) {
                        ask = ScAsk.None; scope.launch { done(sc.placeLimit("BUY", p), "Buy limit @ ${"%.2f".format(p)} placed at ${dash?.broker?.label ?: "Dhan"}.") }
                    }
                    ActionRow("Sell limit", "${size.lots} lot${if (size.lots == 1) "" else "s"} @ ${"%.2f".format(p)}", Tl.amber) {
                        ask = ScAsk.None; scope.launch { done(sc.placeLimit("SELL", p), "Sell limit @ ${"%.2f".format(p)} placed at ${dash?.broker?.label ?: "Dhan"}.") }
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
private fun OrderButton(label: String, tint: Color, modifier: Modifier, enabled: Boolean, onClick: () -> Unit) =
    Box(modifier.height(52.dp).tactile(onClick, enabled = enabled).clip(RoundedCornerShape(14.dp)).background(if (enabled) tint else tint.copy(alpha = 0.25f)), contentAlignment = Alignment.Center) {
        Text(label, color = if (tint == Tl.green) Color(0xFF032414) else Color(0xFF1C0309), fontWeight = FontWeight.ExtraBold, fontSize = 17.sp)
    }

@Composable
private fun Step(label: String, enabled: Boolean, onClick: () -> Unit) =
    Box(Modifier.size(40.dp, 52.dp).tactile(onClick, enabled = enabled), contentAlignment = Alignment.Center) {
        Text(label, style = TlType.title, color = if (enabled) Tl.text else Tl.dim)
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
