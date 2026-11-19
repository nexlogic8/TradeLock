package com.nexlogic.tradelock.ui.screens

import com.nexlogic.tradelock.ui.components.ambient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.nexlogic.tradelock.data.Api
import com.nexlogic.tradelock.data.ApiError
import com.nexlogic.tradelock.data.AppViewModel
import com.nexlogic.tradelock.data.PnlPoint
import com.nexlogic.tradelock.data.Toast
import com.nexlogic.tradelock.data.arr
import com.nexlogic.tradelock.data.bool
import com.nexlogic.tradelock.data.num
import com.nexlogic.tradelock.data.obj
import com.nexlogic.tradelock.data.str
import com.nexlogic.tradelock.ui.components.Eyebrow
import com.nexlogic.tradelock.ui.components.PnlChart
import com.nexlogic.tradelock.ui.components.TlCard
import com.nexlogic.tradelock.ui.components.tactile
import com.nexlogic.tradelock.ui.inr
import com.nexlogic.tradelock.ui.theme.Tl
import com.nexlogic.tradelock.ui.theme.TlType
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import java.time.LocalDate
import java.time.YearMonth
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlin.math.abs
import kotlin.math.min

private data class CalDay(val day: String, val pnl: Double, val entries: Int, val wins: Int, val losses: Int, val breaches: Int, val locked: Boolean,
                          val gross: Double?, val charges: Double?, val source: String)

private val MONTH = DateTimeFormatter.ofPattern("MMMM yyyy")
private val LONG = DateTimeFormatter.ofPattern("EEEE, d MMMM")

/** P&L calendar: a month of trading days as a heat grid (green / red by size), the month's summary, and each day's curve. */
@Composable
fun CalendarScreen(vm: AppViewModel, onBack: () -> Unit) {
    BackHandler { onBack() }
    var month by remember { mutableStateOf(YearMonth.now(ZoneId.of("Asia/Kolkata"))) }
    var data by remember { mutableStateOf<JsonObject?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var open by remember { mutableStateOf<CalDay?>(null) }
    var syncing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    suspend fun load() { try { data = Api.get("/analytics/calendar?month=$month"); error = null } catch (e: ApiError) { error = e.message } }
    LaunchedEffect(month) { data = null; load() }

    val days = data?.arr("days")?.mapNotNull { it as? JsonObject }?.map {
        CalDay(it.str("day") ?: "", it.num("pnl") ?: 0.0, it.num("entries")?.toInt() ?: 0, it.num("wins")?.toInt() ?: 0, it.num("losses")?.toInt() ?: 0,
            it.num("breaches")?.toInt() ?: 0, it.bool("locked") == true, it.num("gross"), it.num("charges"), it.str("source") ?: "")
    }.orEmpty().associateBy { it.day }
    val maxAbs = days.values.maxOfOrNull { abs(it.pnl) }?.takeIf { it > 0 } ?: 1.0
    val s = data?.obj("summary")

    Column(Modifier.fillMaxSize().ambient().statusBarsPadding().navigationBarsPadding().verticalScroll(rememberScrollState()).padding(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(44.dp).tactile(onBack).clip(RoundedCornerShape(14.dp)).background(Tl.glass).border(1.dp, Tl.edgeOff, RoundedCornerShape(14.dp)), contentAlignment = Alignment.Center) {
                Icon(Icons.AutoMirrored.Rounded.ArrowBack, null, tint = Tl.text)
            }
            Spacer(Modifier.width(12.dp))
            Text("P&L calendar", style = TlType.page, modifier = Modifier.weight(1f))
            Text(if (syncing) "Syncing…" else "Sync", style = TlType.label, color = Tl.mint, modifier = Modifier.tactile({
                if (syncing) return@tactile
                syncing = true
                scope.launch {
                    try { Api.post("/analytics/broker-sync"); load(); vm.toast("Synced from your broker's trade history.") } catch (e: ApiError) { vm.toast(e.message, Toast.Tone.Error) }
                    syncing = false
                }
            }).padding(8.dp))
        }
        Spacer(Modifier.height(14.dp))
        // month switcher
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(40.dp).tactile({ month = month.minusMonths(1) }).clip(RoundedCornerShape(12.dp)).background(Tl.surface), contentAlignment = Alignment.Center) {
                Icon(Icons.AutoMirrored.Rounded.KeyboardArrowLeft, null, tint = Tl.text)
            }
            Text(month.format(MONTH), style = TlType.title, color = Tl.text, textAlign = TextAlign.Center, modifier = Modifier.weight(1f))
            val isNow = month >= YearMonth.now(ZoneId.of("Asia/Kolkata"))
            Box(Modifier.size(40.dp).tactile({ if (!isNow) month = month.plusMonths(1) }, enabled = !isNow).clip(RoundedCornerShape(12.dp)).background(Tl.surface), contentAlignment = Alignment.Center) {
                Icon(Icons.AutoMirrored.Rounded.KeyboardArrowRight, null, tint = if (isNow) Tl.dim else Tl.text)
            }
        }
        Spacer(Modifier.height(14.dp))
        // Paper keeps its own days, separate from the broker's (switching parks one history and brings back the other).
        if (data?.bool("paper") == true) {
            TlCard(Modifier.fillMaxWidth(), padding = 14.dp, accent = Tl.ice) {
                Text("Paper trading history", style = TlType.label, color = Tl.ice)
                Text("Paper keeps its own P&L, separate from your broker's. Switch to Real on AI Algo Trading to see your broker's days.", style = TlType.small, color = Tl.muted)
            }
            Spacer(Modifier.height(14.dp))
        }
        // summary
        TlCard(Modifier.fillMaxWidth(), padding = 18.dp) {
            Eyebrow("Month net · after charges")
            Spacer(Modifier.height(4.dp))
            val net = s?.num("net") ?: 0.0
            Text(inr(net, sign = true), style = TlType.hero, color = Tl.money(net))
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Stat("Days", "${s?.num("tradingDays")?.toInt() ?: 0}")
                Stat("Green", "${s?.num("greenDays")?.toInt() ?: 0}", Tl.green)
                Stat("Red", "${s?.num("redDays")?.toInt() ?: 0}", Tl.red)
                Stat("Trades", "${s?.num("trades")?.toInt() ?: 0}")
                Stat("Limit hit", "${s?.num("limitDays")?.toInt() ?: 0}", Tl.amber)
            }
        }
        Spacer(Modifier.height(16.dp))
        if (data == null) { Box(Modifier.fillMaxWidth().padding(30.dp), contentAlignment = Alignment.Center) { if (error != null) Text(error!!, color = Tl.red) else CircularProgressIndicator(color = Tl.mint) }; return@Column }

        // weekday header + grid (Monday first)
        Row { listOf("M", "T", "W", "T", "F", "S", "S").forEach { Text(it, style = TlType.eyebrow, color = Tl.dim, textAlign = TextAlign.Center, modifier = Modifier.weight(1f)) } }
        Spacer(Modifier.height(8.dp))
        val first = month.atDay(1)
        val lead = first.dayOfWeek.value - 1
        val cells = List(lead) { null } + (1..month.lengthOfMonth()).map { month.atDay(it) }
        cells.chunked(7).forEach { week ->
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(bottom = 6.dp)) {
                (0 until 7).forEach { i ->
                    val date = week.getOrNull(i)
                    Box(Modifier.weight(1f).aspectRatio(0.82f)) { if (date != null) DayCell(date, days[date.toString()], maxAbs) { open = it } }
                }
            }
        }
        Spacer(Modifier.height(8.dp))
        s?.obj("best")?.let { b -> Text("Best day ${b.str("day")} · ${inr(b.num("pnl"), sign = true)}", style = TlType.small, color = Tl.green) }
        s?.obj("worst")?.let { w -> Text("Worst day ${w.str("day")} · ${inr(w.num("pnl"), sign = true)}", style = TlType.small, color = Tl.red) }
    }

    open?.let { d ->
        var points by remember(d.day) { mutableStateOf<List<PnlPoint>?>(null) }
        LaunchedEffect(d.day) {
            points = runCatching { Api.get("/dashboard/intraday?day=${d.day}").arr("points").mapNotNull { (it as? JsonObject)?.let(PnlPoint::from) } }.getOrDefault(emptyList())
        }
        TlSheet({ open = null }) {
            Eyebrow(LocalDate.parse(d.day).format(LONG))
            Spacer(Modifier.height(6.dp))
            Text(inr(d.pnl, sign = true), style = TlType.hero, color = Tl.money(d.pnl))
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Stat("Trades", "${d.entries}"); Stat("Won", "${d.wins}", Tl.green); Stat("Lost", "${d.losses}", Tl.red)
                d.charges?.let { Stat("Charges", inr(it)) }
            }
            if (d.locked || d.breaches > 0) {
                Spacer(Modifier.height(10.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Rounded.Lock, null, tint = Tl.amber, modifier = Modifier.size(16.dp)); Spacer(Modifier.width(6.dp))
                    Text(if (d.locked) "Kill switch locked the account" else "${d.breaches} limit${if (d.breaches > 1) "s" else ""} hit", style = TlType.small, color = Tl.amber)
                }
            }
            Spacer(Modifier.height(14.dp))
            when {
                points == null -> Box(Modifier.fillMaxWidth().height(200.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = Tl.mint) }
                points!!.isEmpty() -> Text("No intraday curve was recorded for this day.", style = TlType.small, color = Tl.dim)
                else -> PnlChart(points!!, null, null)
            }
            Spacer(Modifier.height(6.dp))
            Text(if (d.source == "broker") "From ${"your broker"}'s trade history, after charges." else "From TradeLock's own record, after charges.", style = TlType.small, color = Tl.dim)
        }
    }
}

@Composable
private fun DayCell(date: LocalDate, d: CalDay?, maxAbs: Double, onOpen: (CalDay) -> Unit) {
    val traded = d != null && (d.entries > 0 || d.pnl != 0.0)
    val strength = if (traded) (0.18 + 0.62 * min(1.0, abs(d!!.pnl) / maxAbs)).toFloat() else 0f
    val base = if (!traded) Tl.surface else if (d!!.pnl >= 0) Tl.green else Tl.red
    val today = date == LocalDate.now(ZoneId.of("Asia/Kolkata"))
    Column(
        Modifier.fillMaxSize().tactile({ if (traded) onOpen(d!!) }, enabled = traded).clip(RoundedCornerShape(12.dp))
            .background(if (traded) base.copy(alpha = strength) else Tl.surface)
            .border(1.dp, if (today) Tl.mint else if (traded) base.copy(alpha = 0.6f) else Tl.line, RoundedCornerShape(12.dp))
            .padding(5.dp),
        verticalArrangement = Arrangement.SpaceBetween,
    ) {
        Text("${date.dayOfMonth}", style = TlType.small.copy(fontSize = 11.sp, fontWeight = FontWeight.Bold), color = if (traded) Tl.text else Tl.dim)
        if (traded) Text(compactInr(d!!.pnl), style = TlType.numSm.copy(fontSize = 10.sp, fontWeight = FontWeight.Bold), color = Tl.text, maxLines = 1)
        if (d?.locked == true) Icon(Icons.Rounded.Lock, null, tint = Tl.text, modifier = Modifier.size(10.dp))
    }
}

private fun compactInr(v: Double): String {
    val a = abs(v); val sign = if (v < 0) "−" else "+"
    // short enough for a 7-column phone grid: +1.7L · −23k · +3.9k · +850
    return sign + when { a >= 1e5 -> "%.1fL".format(a / 1e5).replace(".0L", "L"); a >= 1e4 -> "%.0fk".format(a / 1e3); a >= 1e3 -> "%.1fk".format(a / 1e3).replace(".0k", "k"); else -> "%.0f".format(a) }
}

@Composable
private fun Stat(k: String, v: String, c: androidx.compose.ui.graphics.Color = Tl.text) = Column {
    Text(k, style = TlType.small.copy(fontSize = 11.sp), color = Tl.dim); Text(v, style = TlType.num.copy(fontSize = 15.sp), color = c)
}
