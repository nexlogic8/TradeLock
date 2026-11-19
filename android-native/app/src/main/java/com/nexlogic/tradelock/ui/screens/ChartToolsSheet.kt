package com.nexlogic.tradelock.ui.screens

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.BarChart
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material.icons.rounded.Height
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.nexlogic.tradelock.ui.components.Eyebrow
import com.nexlogic.tradelock.ui.components.PillSwitch
import com.nexlogic.tradelock.ui.components.STRATEGIES
import com.nexlogic.tradelock.ui.components.Study
import com.nexlogic.tradelock.ui.components.StudyType
import com.nexlogic.tradelock.ui.components.tactile
import com.nexlogic.tradelock.ui.theme.Tl
import com.nexlogic.tradelock.ui.theme.TlType

private enum class ToolTab(val label: String) { Indicators("Indicators"), Overlays("Overlays"), Strategies("Strategies") }

private val STRATEGY_INFO = mapOf(
    "orb" to ("Opening-range (09:15–09:20) breakout, confirmed by the next candle. Draws OR High / Low." to setOf("1", "5")),
    "hammer" to ("EMA 45 wick-touch hammer with a breakout of its high / low." to setOf("1")),
    "emaCross" to ("EMA 9 crossing EMA 21: up = CE, down = PE." to setOf("5")),
    "ema25" to ("Scalp: EMA 5 / 9 crossover; the opposite cross is the exit." to setOf("1")),
    "ema35" to ("Faster scalp: EMA 3 / 5 crossover; the opposite cross is the exit." to setOf("1")),
)
private val OVERLAY_INFO = listOf(
    Triple("oi", "Open interest", "OI bars by strike beside the price axis, with OI Resistance, Support and Max Pain (index chart)."),
    Triple("prev", "Previous day high / low", "The last session's high and low as lines on both charts."),
)

/**
 * ƒx — one sheet for everything drawn on the charts: per-chart indicators (Index / Option switch at the top),
 * the built-in overlays, and the chart strategies (administrators, as on the web).
 */
@Composable
fun ChartToolsSheet(
    startOnSpot: Boolean, spotName: String, optName: String, spotInterval: String,
    spotStudies: List<Study>, optStudies: List<Study>, onStudies: (spot: Boolean, List<Study>) -> Unit,
    overlays: Set<String>, onOverlay: (String) -> Unit,
    admin: Boolean, strategies: Set<String>, onStrategy: (String) -> Unit,
    onToast: (String) -> Unit, onDismiss: () -> Unit,
) = TlSheet(onDismiss) {
    var spot by remember { mutableStateOf(startOnSpot) }
    var tab by remember { mutableStateOf(ToolTab.Indicators) }
    val tabs = ToolTab.entries.filter { it != ToolTab.Strategies || admin }

    // ---- header ----
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(42.dp).clip(RoundedCornerShape(13.dp)).background(Tl.mint.copy(alpha = 0.14f)), contentAlignment = Alignment.Center) {
            Text("ƒx", style = TlType.label.copy(fontSize = 18.sp, fontStyle = androidx.compose.ui.text.font.FontStyle.Italic), color = Tl.mint)
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text("Chart tools", style = TlType.title, color = Tl.text)
            Text("What the charts draw · saved on this phone", style = TlType.small, color = Tl.muted)
        }
    }
    Spacer(Modifier.height(16.dp))

    // ---- tabs ----
    Segmented(tabs.map { it.label + if (it == ToolTab.Strategies && strategies.isNotEmpty()) " · ${strategies.size}" else "" }, tabs.indexOf(tab)) { tab = tabs[it] }
    Spacer(Modifier.height(14.dp))

    Column(Modifier.fillMaxWidth().heightIn(max = 470.dp).verticalScroll(rememberScrollState()).animateContentSize(spring(stiffness = Spring.StiffnessMediumLow))) {
        AnimatedContent(tab, transitionSpec = {
            val dir = if (targetState.ordinal > initialState.ordinal) 1 else -1
            (slideInHorizontally(tween(260)) { it / 6 * dir } + fadeIn(tween(220))) togetherWith (slideOutHorizontally(tween(200)) { -it / 6 * dir } + fadeOut(tween(160)))
        }, label = "tools") { t ->
            Column {
                when (t) {
                    ToolTab.Indicators -> {
                        // which chart these indicators are for
                        Segmented(listOf("Index · $spotName", "Option · $optName"), if (spot) 0 else 1, small = true) { spot = it == 0 }
                        Spacer(Modifier.height(14.dp))
                        val list = if (spot) spotStudies else optStudies
                        AnimatedContent(spot, transitionSpec = { fadeIn(tween(200)) togetherWith fadeOut(tween(150)) }, label = "chart") { sp ->
                            val l = if (sp) spotStudies else optStudies
                            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                if (l.isEmpty()) EmptyNote("No indicators on this chart yet. Add one below.")
                                l.forEachIndexed { i, st -> StudyCard(st, onChange = { n -> onStudies(sp, l.toMutableList().also { it[i] = n }) }, onRemove = { onStudies(sp, l.filterIndexed { j, _ -> j != i }) }) }
                            }
                        }
                        Eyebrow("Add indicator", Modifier.padding(top = 18.dp, bottom = 10.dp))
                        StudyType.entries.chunked(2).forEach { row ->
                            Row(Modifier.fillMaxWidth().padding(bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                row.forEach { ty -> AddTile(ty, Modifier.weight(1f), enabled = list.size < 8) { onStudies(spot, list + Study(ty)) } }
                                if (row.size == 1) Spacer(Modifier.weight(1f))
                            }
                        }
                        Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            SoftButton("Copy to ${if (spot) "option" else "index"}", Icons.Rounded.ContentCopy, Modifier.weight(1f)) { onStudies(!spot, list); onToast("Indicators copied to the ${if (spot) "option" else "index"} chart.") }
                            SoftButton("Reset", Icons.Rounded.Refresh, Modifier.weight(0.7f)) { onStudies(spot, Study.DEFAULT) }
                        }
                    }
                    ToolTab.Overlays -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        OVERLAY_INFO.forEach { (k, title, body) ->
                            ToggleCard(title, body, k in overlays, Tl.mint, icon = if (k == "oi") Icons.Rounded.BarChart else Icons.Rounded.Height) { onOverlay(k) }
                        }
                    }
                    ToolTab.Strategies -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        STRATEGIES.forEach { (k, label) ->
                            val (body, ivs) = STRATEGY_INFO[k] ?: ("" to emptySet())
                            val live = spotInterval in ivs
                            ToggleCard(label, body, k in strategies, Tl.amber,
                                badge = if (k !in strategies) null else if (live) "LIVE" to Tl.mint else "NEEDS ${ivs.sorted().joinToString(" / ") { "${it}M" }} INDEX" to Tl.amber) { onStrategy(k) }
                        }
                        Text("Signals come from the index candles and show on both charts (the option chart gets its own side's BUY arrows). Chart only: Algo Trading has its own switches.",
                            style = TlType.small, color = Tl.dim, modifier = Modifier.padding(top = 4.dp))
                    }
                }
            }
        }
    }
}

/** A segmented control whose highlight slides to the selected option. */
@Composable
private fun Segmented(options: List<String>, selected: Int, small: Boolean = false, onSelect: (Int) -> Unit) {
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Tl.bg).border(1.dp, Tl.line, RoundedCornerShape(14.dp)).padding(4.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        options.forEachIndexed { i, label ->
            val on = i == selected
            val bg by animateColorAsState(if (on) Tl.raised else Color.Transparent, tween(220), label = "seg")
            val fg by animateColorAsState(if (on) (if (small) Tl.text else Tl.mint) else Tl.muted, tween(220), label = "segText")
            Box(Modifier.weight(1f).tactile({ onSelect(i) }).clip(RoundedCornerShape(10.dp)).background(bg).padding(vertical = if (small) 8.dp else 10.dp), contentAlignment = Alignment.Center) {
                Text(label, style = TlType.small.copy(fontSize = if (small) 12.5.sp else 14.sp, fontWeight = FontWeight.Bold), color = fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

/** An indicator on the chart: colour strip, name, its parameters with − / +, and remove. */
@Composable
private fun StudyCard(st: Study, onChange: (Study) -> Unit, onRemove: () -> Unit) {
    val col = st.color(if (st.type == StudyType.BB) 1 else 0)
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Tl.surfaceHi).border(1.dp, Tl.line, RoundedCornerShape(16.dp)), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.width(4.dp).height(64.dp).background(col))
        Column(Modifier.weight(1f).padding(start = 12.dp, top = 10.dp, bottom = 10.dp)) {
            Text(st.type.label, style = TlType.label.copy(fontSize = 15.sp), color = Tl.text)
            Text(st.type.title, style = TlType.small.copy(fontSize = 11.5.sp), color = Tl.dim, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        st.type.params.forEachIndexed { pi, prm ->
            Row(Modifier.padding(end = 6.dp).clip(CircleShape).background(Tl.bg), verticalAlignment = Alignment.CenterVertically) {
                RoundStep("−") { onChange(st.copy(p = st.p.toMutableList().also { it[pi] = (it[pi] - prm.step).coerceIn(prm.min, prm.max) })) }
                Text(st.p[pi].let { if (it == Math.floor(it)) it.toLong().toString() else it.toString() }, style = TlType.num.copy(fontSize = 14.sp, fontWeight = FontWeight.Bold),
                    color = col, modifier = Modifier.width(30.dp), textAlign = TextAlign.Center)
                RoundStep("+") { onChange(st.copy(p = st.p.toMutableList().also { it[pi] = (it[pi] + prm.step).coerceIn(prm.min, prm.max) })) }
            }
        }
        Box(Modifier.padding(end = 6.dp).size(36.dp).tactile(onRemove).clip(CircleShape).background(Tl.red.copy(alpha = 0.10f)), contentAlignment = Alignment.Center) {
            Icon(Icons.Rounded.Close, "Remove ${st.name}", tint = Tl.red, modifier = Modifier.size(16.dp))
        }
    }
}

@Composable
private fun RoundStep(label: String, onClick: () -> Unit) =
    Box(Modifier.size(30.dp).tactile(onClick), contentAlignment = Alignment.Center) { Text(label, style = TlType.label.copy(fontSize = 17.sp), color = Tl.muted) }

/** A tile in the "Add indicator" grid. */
@Composable
private fun AddTile(t: StudyType, modifier: Modifier, enabled: Boolean, onAdd: () -> Unit) {
    Row(modifier.tactile(onAdd, enabled = enabled).clip(RoundedCornerShape(14.dp)).background(Tl.surfaceHi).border(1.dp, Tl.line, RoundedCornerShape(14.dp))
        .padding(horizontal = 12.dp, vertical = 11.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(t.colors.first()))
        Spacer(Modifier.width(9.dp))
        Column(Modifier.weight(1f)) {
            Text(t.label, style = TlType.label.copy(fontSize = 14.sp), color = Tl.text)
            Text(t.title, style = TlType.small.copy(fontSize = 10.5.sp), color = Tl.dim, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Icon(Icons.Rounded.Add, "Add ${t.label}", tint = Tl.mint, modifier = Modifier.size(18.dp))
    }
}

/** A switchable card: title, a line of what it does, an optional status badge, and the switch. */
@Composable
private fun ToggleCard(title: String, body: String, on: Boolean, tint: Color, icon: ImageVector? = null, badge: Pair<String, Color>? = null, onToggle: () -> Unit) {
    val border by animateColorAsState(if (on) tint.copy(alpha = 0.45f) else Tl.line, tween(220), label = "cardBorder")
    val bg by animateColorAsState(if (on) tint.copy(alpha = 0.06f) else Tl.surfaceHi, tween(220), label = "cardBg")
    Row(Modifier.fillMaxWidth().tactile(onToggle).clip(RoundedCornerShape(16.dp)).background(bg).border(1.dp, border, RoundedCornerShape(16.dp)).padding(14.dp),
        verticalAlignment = Alignment.CenterVertically) {
        icon?.let {
            Box(Modifier.size(38.dp).clip(RoundedCornerShape(11.dp)).background(tint.copy(alpha = 0.12f)), contentAlignment = Alignment.Center) { Icon(it, null, tint = tint, modifier = Modifier.size(20.dp)) }
            Spacer(Modifier.width(12.dp))
        }
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(title, style = TlType.label.copy(fontSize = 15.sp), color = Tl.text)
                badge?.let { (b, c) ->
                    Spacer(Modifier.width(8.dp))
                    Text(b, style = TlType.eyebrow.copy(fontSize = 8.5.sp), color = c, modifier = Modifier.clip(CircleShape).background(c.copy(alpha = 0.14f)).padding(horizontal = 7.dp, vertical = 3.dp))
                }
            }
            Spacer(Modifier.height(3.dp))
            Text(body, style = TlType.small.copy(fontSize = 12.sp), color = Tl.muted)
        }
        Spacer(Modifier.width(10.dp))
        PillSwitch(on, tint, compact = true)
    }
}

@Composable
private fun SoftButton(text: String, icon: ImageVector, modifier: Modifier, onClick: () -> Unit) =
    Row(modifier.tactile(onClick).clip(RoundedCornerShape(14.dp)).background(Tl.surfaceHi).border(1.dp, Tl.line, RoundedCornerShape(14.dp)).padding(vertical = 12.dp),
        horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, tint = Tl.muted, modifier = Modifier.size(16.dp)); Spacer(Modifier.width(7.dp))
        Text(text, style = TlType.small.copy(fontWeight = FontWeight.SemiBold, fontSize = 13.sp), color = Tl.text, maxLines = 1)
    }

@Composable
private fun EmptyNote(text: String) =
    Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).border(1.dp, Tl.line, RoundedCornerShape(16.dp)).padding(18.dp), contentAlignment = Alignment.Center) {
        Text(text, style = TlType.small, color = Tl.muted, textAlign = TextAlign.Center)
    }
