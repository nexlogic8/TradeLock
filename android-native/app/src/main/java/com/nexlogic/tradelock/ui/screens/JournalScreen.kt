package com.nexlogic.tradelock.ui.screens

import androidx.activity.compose.BackHandler
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
import androidx.compose.foundation.layout.heightIn
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
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.nexlogic.tradelock.data.Api
import com.nexlogic.tradelock.data.ApiError
import com.nexlogic.tradelock.data.AppViewModel
import com.nexlogic.tradelock.data.Toast
import com.nexlogic.tradelock.data.arr
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
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.LocalDate
import java.time.format.DateTimeFormatter

data class JEntry(val id: Long?, val day: String, val title: String, val body: String, val mood: String?, val discipline: Int?, val symbol: String, val pnl: Double?, val tags: List<String>)

private val MOODS = listOf("great" to "😄", "good" to "🙂", "neutral" to "😐", "bad" to "😕", "tilt" to "😤")
private val SHORT = DateTimeFormatter.ofPattern("EEE, d MMM")

private fun entryOf(o: JsonObject) = JEntry(o.long("id"), o.str("day") ?: "", o.str("title") ?: "", o.str("body") ?: "", o.str("mood"), o.num("discipline")?.toInt(),
    o.str("symbol") ?: "", o.num("pnl"), (o["tags"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.content } ?: emptyList())

/** Trading journal: streak and discipline, entries newest first, and a sheet to write one (filled from the day's trades). */
@Composable
fun JournalScreen(vm: AppViewModel, onBack: () -> Unit) {
    BackHandler { onBack() }
    var data by remember { mutableStateOf<JsonObject?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var editing by remember { mutableStateOf<JEntry?>(null) }
    val scope = rememberCoroutineScope()
    suspend fun load() { try { data = Api.get("/journal"); error = null } catch (e: ApiError) { error = e.message } }
    LaunchedEffect(Unit) { load() }
    val today = data?.str("today") ?: LocalDate.now().toString()
    val entries = data?.arr("entries")?.mapNotNull { (it as? JsonObject)?.let(::entryOf) }.orEmpty()
    val st = data?.obj("stats")

    Box(Modifier.fillMaxSize().background(Tl.bg)) {
        LazyColumn(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding(), contentPadding = PaddingValues(16.dp, 16.dp, 16.dp, 100.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(44.dp).tactile(onBack).clip(RoundedCornerShape(14.dp)).background(Tl.surface), contentAlignment = Alignment.Center) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, null, tint = Tl.text) }
                    Spacer(Modifier.width(12.dp))
                    Text("Journal", fontSize = 26.sp, fontWeight = FontWeight.ExtraBold, color = Tl.text)
                }
            }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    MiniStat("Streak", "${st?.num("streak")?.toInt() ?: 0}🔥", Modifier.weight(1f))
                    MiniStat("This month", "${st?.num("thisMonth")?.toInt() ?: 0}", Modifier.weight(1f))
                    MiniStat("Discipline", st?.num("discipline")?.let { "$it/5" } ?: "–", Modifier.weight(1f))
                }
            }
            if (data == null) item { Box(Modifier.fillMaxWidth().padding(30.dp), contentAlignment = Alignment.Center) { if (error != null) Text(error!!, color = Tl.red) else CircularProgressIndicator(color = Tl.mint) } }
            else if (entries.isEmpty()) item { Text("No entries yet. Write today's: what you planned, what you did, what you'd change.", style = TlType.body, color = Tl.dim, modifier = Modifier.padding(4.dp)) }
            entries.forEach { e ->
                item(key = "j${e.id}") {
                    TlCard(Modifier.fillMaxWidth().tactile({ editing = e }, haptic = false), padding = 16.dp, shape = RoundedCornerShape(20.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(runCatching { LocalDate.parse(e.day).format(SHORT) }.getOrDefault(e.day), style = TlType.small.copy(fontWeight = FontWeight.SemiBold), color = Tl.muted, modifier = Modifier.weight(1f))
                            e.mood?.let { m -> Text(MOODS.firstOrNull { it.first == m }?.second ?: "", fontSize = 18.sp) }
                            e.pnl?.let { Spacer(Modifier.width(8.dp)); Text(inr(it, sign = true), style = TlType.num, color = Tl.money(it)) }
                        }
                        Spacer(Modifier.height(4.dp))
                        Text(e.title, style = TlType.label.copy(fontSize = 16.sp), color = Tl.text)
                        if (e.body.isNotBlank()) Text(e.body.trim(), style = TlType.small.copy(fontSize = 13.sp), color = Tl.muted, maxLines = 3, overflow = TextOverflow.Ellipsis)
                        if (e.tags.isNotEmpty() || e.discipline != null) {
                            Spacer(Modifier.height(8.dp))
                            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.horizontalScroll(rememberScrollState())) {
                                e.discipline?.let { Tag("discipline $it/5", Tl.amber) }
                                e.tags.forEach { Tag("#$it", Tl.mint) }
                            }
                        }
                    }
                }
            }
        }
        // floating "write" button
        Box(
            Modifier.align(Alignment.BottomEnd).navigationBarsPadding().padding(20.dp).size(60.dp).tactile({ editing = JEntry(null, today, "", "", null, null, "", null, emptyList()) })
                .shadow(20.dp, CircleShape, spotColor = Tl.mint).clip(CircleShape).background(Tl.mintBrush),
            contentAlignment = Alignment.Center,
        ) { Icon(Icons.Rounded.Add, null, tint = Color(0xFF04261F), modifier = Modifier.size(30.dp)) }
    }

    editing?.let { e0 ->
        EntrySheet(e0, onDismiss = { editing = null }, onDelete = if (e0.id != null) ({
            scope.launch { runCatching { Api.delete("/journal/${e0.id}") }; editing = null; load(); vm.toast("Entry deleted.") }
        }) else null) { e ->
            val body = buildJsonObject {
                put("day", e.day); put("title", e.title); put("body", e.body); put("symbol", e.symbol)
                put("mood", e.mood?.let { JsonPrimitive(it) } ?: JsonNull); put("discipline", e.discipline?.let { JsonPrimitive(it) } ?: JsonNull)
                put("pnl", e.pnl?.let { JsonPrimitive(it) } ?: JsonNull); put("tags", JsonArray(e.tags.map { JsonPrimitive(it) }))
            }
            try { if (e.id != null) Api.put("/journal/${e.id}", body) else Api.post("/journal", body); editing = null; load(); vm.toast("Saved to your journal."); null }
            catch (x: ApiError) { x.message }
        }
    }
}

@Composable
private fun MiniStat(k: String, v: String, modifier: Modifier) = TlCard(modifier, padding = 14.dp, shape = RoundedCornerShape(18.dp)) {
    Text(k, style = TlType.small, color = Tl.muted); Spacer(Modifier.height(4.dp)); Text(v, style = TlType.num.copy(fontSize = 18.sp, fontWeight = FontWeight.Bold), color = Tl.text)
}

@Composable
private fun Tag(t: String, c: Color) = Text(t, style = TlType.small.copy(fontSize = 11.sp, fontWeight = FontWeight.SemiBold), color = c,
    modifier = Modifier.clip(CircleShape).background(c.copy(alpha = 0.12f)).padding(horizontal = 9.dp, vertical = 4.dp))

/** Write or edit an entry. "Fill from trades" brings in the day's trades, P&L and tags. onSave returns null when saved, else the error. */
@Composable
private fun EntrySheet(e0: JEntry, onDismiss: () -> Unit, onDelete: (() -> Unit)?, onSave: suspend (JEntry) -> String?) {
    var title by remember { mutableStateOf(e0.title) }
    var body by remember { mutableStateOf(e0.body) }
    var mood by remember { mutableStateOf(e0.mood) }
    var disc by remember { mutableIntStateOf(e0.discipline ?: 0) }
    var tags by remember { mutableStateOf(e0.tags.joinToString(", ")) }
    var symbol by remember { mutableStateOf(e0.symbol) }
    var pnl by remember { mutableStateOf(e0.pnl) }
    var err by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    TlSheet(onDismiss) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(runCatching { LocalDate.parse(e0.day).format(SHORT) }.getOrDefault(e0.day), style = TlType.title, color = Tl.text, modifier = Modifier.weight(1f))
            Text("Fill from trades", style = TlType.label, color = Tl.mint, modifier = Modifier.tactile({
                scope.launch {
                    runCatching { Api.get("/journal/autofill?day=${e0.day}") }.onSuccess { a ->
                        if ((a.num("trades") ?: 0.0) == 0.0) { err = "No trades on this day."; return@onSuccess }
                        if (title.isBlank()) title = a.str("title") ?: ""
                        symbol = a.str("symbol") ?: symbol; pnl = a.num("pnl") ?: pnl
                        val t = (a["tags"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.content }.orEmpty()
                        tags = (tags.split(",").map { it.trim() }.filter { it.isNotEmpty() } + t).distinct().take(8).joinToString(", ")
                        val block = a.str("block") ?: ""
                        // Replace an earlier auto-fill block (the server's markers) instead of adding a second one.
                        val old = Regex("— Trades \\(auto-filled from your broker\\) —[\\s\\S]*?— end of auto-fill —")
                        body = if (old.containsMatchIn(body)) body.replace(old, Regex.escapeReplacement(block)) else (body.trimEnd() + "\n\n" + block).trim()
                    }
                }
            }).padding(6.dp))
        }
        pnl?.let { Text("Day P&L ${inr(it, sign = true)}" + if (symbol.isNotBlank()) " · $symbol" else "", style = TlType.small, color = Tl.money(it)) }
        Spacer(Modifier.height(10.dp))
        JField("Title", title) { title = it }
        JField("What happened, what you'd change", body, lines = 5) { body = it }
        Spacer(Modifier.height(8.dp))
        Eyebrow("Mood")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(vertical = 6.dp)) {
            MOODS.forEach { (k, emoji) ->
                Box(Modifier.size(46.dp).tactile({ mood = if (mood == k) null else k }).clip(CircleShape).background(if (mood == k) Tl.mint.copy(alpha = 0.18f) else Tl.surfaceHi)
                    .border(1.dp, if (mood == k) Tl.mint else Tl.line, CircleShape), contentAlignment = Alignment.Center) { Text(emoji, fontSize = 20.sp) }
            }
        }
        Eyebrow("Discipline")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(vertical = 6.dp)) {
            (1..5).forEach { n ->
                Box(Modifier.size(46.dp).tactile({ disc = if (disc == n) 0 else n }).clip(RoundedCornerShape(12.dp)).background(if (n <= disc) Tl.amber.copy(alpha = 0.2f) else Tl.surfaceHi)
                    .border(1.dp, if (n <= disc) Tl.amber else Tl.line, RoundedCornerShape(12.dp)), contentAlignment = Alignment.Center) { Text("$n", style = TlType.label, color = if (n <= disc) Tl.amber else Tl.muted) }
            }
        }
        JField("Tags (comma separated)", tags) { tags = it }
        err?.let { Text(it, style = TlType.small, color = Tl.red) }
        Spacer(Modifier.height(12.dp))
        PrimaryButton(if (busy) "Saving…" else "Save entry") {
            if (busy) return@PrimaryButton
            if (title.isBlank()) { err = "Give the entry a title."; return@PrimaryButton }
            busy = true
            scope.launch {
                err = onSave(e0.copy(title = title.trim(), body = body, mood = mood, discipline = disc.takeIf { it > 0 }, symbol = symbol, pnl = pnl,
                    tags = tags.split(",").map { it.trim() }.filter { it.isNotEmpty() }))
                busy = false
            }
        }
        onDelete?.let { Spacer(Modifier.height(10.dp)); GhostButton("Delete entry", Modifier.fillMaxWidth()) { it() } }
    }
}

@Composable
private fun JField(label: String, value: String, lines: Int = 1, onChange: (String) -> Unit) =
    OutlinedTextField(value, onChange, label = { Text(label) }, singleLine = lines == 1, minLines = lines, modifier = Modifier.fillMaxWidth().heightIn(max = 260.dp).padding(vertical = 4.dp), shape = RoundedCornerShape(14.dp),
        colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = Tl.mint, unfocusedBorderColor = Tl.lineHi, focusedLabelColor = Tl.mint, cursorColor = Tl.mint, focusedTextColor = Tl.text, unfocusedTextColor = Tl.text))
