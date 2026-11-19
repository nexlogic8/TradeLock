package com.nexlogic.tradelock.ui.screens

import com.nexlogic.tradelock.ui.components.ambient
import androidx.compose.foundation.border
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material.icons.rounded.KeyboardArrowUp
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.nexlogic.tradelock.data.Api
import com.nexlogic.tradelock.data.AppViewModel
import com.nexlogic.tradelock.data.Session
import com.nexlogic.tradelock.data.arr
import com.nexlogic.tradelock.data.bool
import com.nexlogic.tradelock.data.num
import com.nexlogic.tradelock.data.obj
import com.nexlogic.tradelock.data.str
import com.nexlogic.tradelock.ui.components.Eyebrow
import com.nexlogic.tradelock.ui.components.TlCard
import com.nexlogic.tradelock.ui.components.tactile
import com.nexlogic.tradelock.ui.theme.Tl
import com.nexlogic.tradelock.ui.theme.TlType
import kotlinx.serialization.json.JsonObject

// Strategy key → the Algo Trading grid key (as the web page).
private val GRID = mapOf("orb" to "orb", "emaCross" to "ema59", "ema915" to "ema915", "gap" to "gap", "strangle" to "strangle")
private val FLAG = mapOf("gapRetest" to "retestPaperOn")

/** Strategies: how each built-in one trades (tap to read its rules), where it is on, and your own playbooks. */
@Composable
fun StrategyScreen(vm: AppViewModel, onBack: () -> Unit, onOpen: (String) -> Unit) {
    BackHandler { onBack() }
    val session by vm.session.collectAsState()
    val admin = (session as? Session.SignedIn)?.user?.admin == true
    var mine by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var live by remember { mutableStateOf<JsonObject?>(null) }
    var open by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        runCatching { Api.get("/strategies").arr("items").mapNotNull { it as? JsonObject } }.onSuccess { mine = it }
        runCatching { Api.get("/algo/live") }.onSuccess { live = it }
    }
    val list = if (admin) BUILT_IN else PUBLIC_BUILT_IN
    val a = live?.obj("account")

    LazyColumn(Modifier.fillMaxSize().ambient().statusBarsPadding().navigationBarsPadding(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(44.dp).tactile(onBack).clip(RoundedCornerShape(14.dp)).background(Tl.glass).border(1.dp, Tl.edgeOff, RoundedCornerShape(14.dp)), contentAlignment = Alignment.Center) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, null, tint = Tl.text) }
                Spacer(Modifier.width(12.dp))
                Text("Strategy", style = TlType.page)
            }
        }
        item { Eyebrow("Built-in · how TradeLock runs them", Modifier.padding(start = 4.dp, top = 4.dp)) }
        list.forEach { s ->
            item(key = s.key) {
                // Where it runs now: the Algo Trading grid (indices it is on for), a paper flag, or a chart signal.
                val at = GRID[s.key]?.let { g -> listOf("NIFTY" to "NIFTY", "BANKNIFTY" to "BANK NIFTY", "SENSEX" to "SENSEX").filter { a?.obj("grid")?.obj(g)?.obj(it.first)?.bool("on") == true }.map { it.second } }
                val on = (at?.isNotEmpty() == true) || (FLAG[s.key]?.let { a?.bool(it) == true } == true)
                val (state, tint) = when {
                    !s.auto -> "CHART SIGNAL" to Color(0xFF5AA9FF)
                    on && a?.bool("algoOn") == true -> "RUNNING" + (at?.takeIf { it.isNotEmpty() }?.let { " · ${it.joinToString(", ")}" } ?: "") to Tl.mint
                    on -> "ON · ALGO STOPPED" to Tl.amber
                    else -> "OFF" to Tl.dim
                }
                val expanded = open == s.key
                TlCard(Modifier.fillMaxWidth().animateContentSize().tactile({ open = if (expanded) null else s.key }, haptic = false), padding = 16.dp, shape = RoundedCornerShape(20.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(s.name, style = TlType.label.copy(fontSize = 16.sp), color = Tl.text)
                            Text("${s.tag} · ${s.timeframe}", style = TlType.small, color = Tl.muted)
                        }
                        Icon(if (expanded) Icons.Rounded.KeyboardArrowUp else Icons.Rounded.KeyboardArrowDown, null, tint = Tl.dim)
                    }
                    Spacer(Modifier.height(8.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Pill(state, tint)
                        if (s.paper) Pill("PAPER", Color(0xFF5AA9FF))
                    }
                    AnimatedVisibility(expanded) {
                        Column(Modifier.padding(top = 12.dp)) {
                            s.rules.forEach { (k, v) ->
                                Text(k, style = TlType.small.copy(fontWeight = FontWeight.Bold), color = Tl.amber, modifier = Modifier.padding(top = 8.dp))
                                Text(v, style = TlType.body, color = Tl.muted)
                            }
                            if (s.auto) { Spacer(Modifier.height(12.dp)); GhostButton("Switch it on in AI Algo Trading", Modifier.fillMaxWidth()) { onOpen("algo") } }
                        }
                    }
                }
            }
        }
        item {
            var shared by remember { mutableStateOf(false) }
            TlCard(Modifier.fillMaxWidth().animateContentSize().tactile({ shared = !shared }, haptic = false), padding = 16.dp, shape = RoundedCornerShape(20.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Every automatic trade", style = TlType.label.copy(fontSize = 16.sp), color = Tl.text, modifier = Modifier.weight(1f))
                    Icon(if (shared) Icons.Rounded.KeyboardArrowUp else Icons.Rounded.KeyboardArrowDown, null, tint = Tl.dim)
                }
                AnimatedVisibility(shared) {
                    Column { (if (admin) SHARED_RULES else PUBLIC_SHARED_RULES).forEach { (k, v) ->
                        Text(k, style = TlType.small.copy(fontWeight = FontWeight.Bold), color = Tl.mint, modifier = Modifier.padding(top = 10.dp)); Text(v, style = TlType.body, color = Tl.muted)
                    } }
                }
            }
        }
        item {
            Row(Modifier.padding(start = 4.dp, top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Eyebrow("My strategies · playbooks", Modifier.weight(1f))
                Text("+ New", style = TlType.label, color = Tl.mint, modifier = Modifier.tactile({ onOpen("strategy?web=1") }).padding(6.dp))
            }
        }
        if (mine.isEmpty()) item { Text("Your own playbooks: saved privately for planning and review, not traded automatically.", style = TlType.body, color = Tl.dim, modifier = Modifier.padding(horizontal = 4.dp)) }
        mine.forEach { m ->
            item(key = "my${m.str("id")}") {
                val x = m.obj("exits")
                TlCard(Modifier.fillMaxWidth().tactile({ onOpen("strategy?web=1") }, haptic = false), padding = 16.dp, shape = RoundedCornerShape(20.dp)) {
                    Text(m.str("name") ?: "Untitled", style = TlType.label.copy(fontSize = 16.sp), color = Tl.text)
                    Text("${if (m.str("market") == "fo") "Futures & options" else "Equity"} · ${m.str("timeframe") ?: ""} · ${when (m.str("direction")) { "both" -> "Long & short"; "long" -> "Long only"; else -> "Short only" }}",
                        style = TlType.small, color = Tl.muted)
                    x?.let {
                        Spacer(Modifier.height(6.dp))
                        Text("SL ${it.num("stopValue")?.let(::trimNum)}${if (it.str("stopMode") == "percent") "%" else " ₹"} → target ${it.num("targetValue")?.let(::trimNum)}${if (it.str("targetMode") == "rr") "R" else "%"} · square-off ${it.str("squareOff") ?: ""}",
                            style = TlType.numSm, color = Tl.amber)
                    }
                }
            }
        }
    }
}

private fun trimNum(v: Double) = if (v % 1.0 == 0.0) v.toLong().toString() else v.toString()

@Composable
private fun Pill(t: String, c: Color) = Text(t, style = TlType.eyebrow.copy(fontSize = 9.sp), color = c,
    modifier = Modifier.clip(CircleShape).background(c.copy(alpha = 0.13f)).padding(horizontal = 9.dp, vertical = 4.dp))
