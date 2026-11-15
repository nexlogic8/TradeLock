package com.nexlogic.tradelock.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.Shield
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.nexlogic.tradelock.data.Api
import com.nexlogic.tradelock.data.ApiError
import com.nexlogic.tradelock.data.AppViewModel
import com.nexlogic.tradelock.data.Dash
import com.nexlogic.tradelock.data.bool
import com.nexlogic.tradelock.data.num
import com.nexlogic.tradelock.data.obj
import com.nexlogic.tradelock.data.str
import com.nexlogic.tradelock.ui.components.Dot
import com.nexlogic.tradelock.ui.components.Eyebrow
import com.nexlogic.tradelock.ui.components.PillSwitch
import com.nexlogic.tradelock.ui.components.TlCard
import com.nexlogic.tradelock.ui.components.tactile
import com.nexlogic.tradelock.ui.inr
import com.nexlogic.tradelock.ui.theme.Tl
import com.nexlogic.tradelock.ui.theme.TlType
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** One rule of a set: switch, value (number, or "HH:MM" for the cutoff) and % / ₹ for money rules. */
data class Rule(val on: Boolean, val value: String, val mode: String?)

private enum class Kind { Money, Count, Percent, Time, Switch }
private data class Def(val key: String, val title: String, val kind: Kind, val unit: String = "")

// The Risk rules page edits the Manual set, which also holds the whole-account rules (as on the web).
private val DEFS = listOf(
    Def("maxLoss", "Daily stop-loss", Kind.Money),
    Def("profitLock", "Profit target", Kind.Money),
    Def("giveback", "Profit give-back", Kind.Percent),
    Def("capitalUse", "Capital per trade", Kind.Money),
    Def("maxTrades", "Trades per day", Kind.Count, "trades"),
    Def("lossStreak", "Losing streak", Kind.Count, "losses"),
    Def("optionSl", "Option SL room", Kind.Percent),
    Def("cutoff", "Cutoff time", Kind.Time),
    Def("killSwitch", "Kill switch", Kind.Switch),
)
private val CUTOFFS = listOf("14:30", "14:45", "15:00", "15:10", "15:15", "15:20")
private val DEFAULTS = mapOf(
    "killSwitch" to Rule(false, "0", null), "lossStreak" to Rule(false, "2", null), "giveback" to Rule(false, "20", null),
    "optionSl" to Rule(true, "20", null), "capitalUse" to Rule(false, "80", "percent"),
)

private fun limitOf(r: Rule, capital: Double?): Double? {
    val v = r.value.toDoubleOrNull() ?: return null
    return if (r.mode != "percent") v else if ((capital ?: 0.0) > 0) Math.round(capital!! * v) / 100.0 else null
}

private fun line(key: String, r: Rule, capital: Double?, broker: String): String {
    val amt = limitOf(r, capital)?.let { inr(it) } ?: "your limit"
    return when (key) {
        "maxLoss" -> "Exit all at −$amt today · whole account"
        "profitLock" -> "Stop for the day at +$amt · whole account"
        "giveback" -> "Exit if profit falls ${r.value}% from its peak · whole account"
        "capitalUse" -> "Use at most $amt in one trade"
        "maxTrades" -> "Pause new orders after this many entries"
        "lossStreak" -> "Stop after this many losses in a row"
        "optionSl" -> "Stop ${r.value}% below the option premium"
        "cutoff" -> "No new entries after ${label12(r.value)}"
        "killSwitch" -> "Also lock the $broker app when a limit hits · whole account"
        else -> ""
    }
}

private fun label12(t: String): String {
    val (h, m) = t.split(":").map { it.toIntOrNull() ?: 0 }.let { it[0] to it.getOrElse(1) { 0 } }
    return "${if (h % 12 == 0) 12 else h % 12}:${"%02d".format(m)} ${if (h >= 12) "PM" else "AM"}"
}

/** One rule set being edited ('manual' or 'algo'): loads from /rules and saves itself shortly after each change. */
class RuleSetState(val set: String) {
    val form = mutableStateMapOf<String, Rule>()
    var raw by mutableStateOf<JsonObject?>(null)
    var capital by mutableStateOf<Double?>(null)
    var pendingFrom by mutableStateOf<String?>(null)
    var error by mutableStateOf<String?>(null)
    var saved by mutableStateOf<String?>(null)
    var dirty by mutableIntStateOf(0)
    fun edit(key: String, r: Rule) { form[key] = r; dirty++ }
}

@Composable
fun rememberRuleSet(set: String): RuleSetState {
    val st = remember(set) { RuleSetState(set) }
    LaunchedEffect(set) {
        try {
            val res = Api.get("/rules")
            val rules = res.obj(set) ?: res.obj("active") ?: JsonObject(emptyMap())
            st.raw = rules
            st.capital = res.num("capital")
            st.pendingFrom = if (res.bool("pending") == true) res.str("pendingFrom") else null
            for (d in DEFS) {
                val o = rules.obj(d.key)
                st.form[d.key] = if (o == null) DEFAULTS[d.key] ?: Rule(false, "0", null)
                else Rule(o.bool("on") == true, o.str("value") ?: "0", o.str("mode") ?: if (d.kind == Kind.Money) "amount" else null)
            }
        } catch (e: ApiError) { st.error = e.message }
    }
    // Every change saves by itself, shortly after the last edit (like the web page).
    LaunchedEffect(st.dirty) {
        if (st.dirty == 0) return@LaunchedEffect
        delay(700)
        val base = st.raw ?: return@LaunchedEffect
        val rules = buildJsonObject {
            base.forEach { (k, v) -> if (st.form[k] == null) put(k, v) }
            st.form.forEach { (k, r) ->
                put(k, buildJsonObject {
                    // keep any extra fields of the rule, then the edited ones
                    base.obj(k)?.forEach { (fk, fv) -> if (fk !in setOf("on", "value", "mode")) put(fk, fv) }
                    put("on", r.on)
                    if (k == "cutoff") put("value", r.value) else if (k != "killSwitch") put("value", JsonPrimitive(r.value.toDoubleOrNull() ?: 0.0))
                    r.mode?.let { put("mode", it) }
                })
            }
        }
        try {
            val res = Api.put("/rules", buildJsonObject { put("rules", rules); put("set", set) })
            st.error = null; st.saved = "Saved"
            st.pendingFrom = if (res.bool("pending") == true) res.str("pendingFrom") else null
            res.obj(set)?.let { st.raw = it }
            delay(1600); st.saved = null
        } catch (e: ApiError) { st.error = e.message; st.saved = null }
    }
    return st
}

/** The Algo Trading set's own rules (the P&L rules and kill switch are whole-account, on Risk rules). */
val ALGO_RULE_KEYS = listOf("capitalUse", "maxTrades", "lossStreak", "cutoff")

/** Rule cards for a list, one item each. */
fun androidx.compose.foundation.lazy.LazyListScope.ruleCards(st: RuleSetState, keys: List<String>, broker: String) {
    DEFS.filter { it.key in keys }.forEach { d ->
        item(key = "${st.set}-${d.key}") {
            val r = st.form[d.key] ?: return@item
            RuleCard(d, r, line(d.key, r, st.capital, broker), if (d.key == "killSwitch") "$broker kill switch" else d.title) { st.edit(d.key, it) }
        }
    }
}

@Composable
fun SavedBadge(text: String?) {
    AnimatedVisibility(text != null, enter = fadeIn(), exit = fadeOut()) {
        Row(Modifier.clip(CircleShape).background(Tl.mint.copy(alpha = 0.12f)).padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Dot(Tl.mint, 6.dp); Spacer(Modifier.width(6.dp)); Text(text ?: "", style = TlType.eyebrow, color = Tl.mint)
        }
    }
}

@Composable
fun RulesScreen(vm: AppViewModel, bottomPad: PaddingValues) {
    val dash by vm.dash.collectAsState()
    val st = rememberRuleSet("manual")
    val form = st.form
    val capital = st.capital
    val pendingFrom = st.pendingFrom
    val error = st.error
    val saved = st.saved
    var askStop by remember { mutableStateOf(false) }
    fun edit(key: String, r: Rule) = st.edit(key, r)

    LazyColumn(
        Modifier.fillMaxSize().background(Tl.bg).statusBarsPadding(),
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 12.dp, bottom = bottomPad.calculateBottomPadding() + 24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 6.dp, bottom = 2.dp)) {
                Column(Modifier.weight(1f)) {
                    Text("Risk rules", fontSize = 30.sp, fontWeight = FontWeight.ExtraBold, color = Tl.text)
                    Text("Clear limits before the session begins", style = TlType.body, color = Tl.muted)
                }
                AnimatedVisibility(saved != null, enter = fadeIn(), exit = fadeOut()) {
                    Row(Modifier.clip(CircleShape).background(Tl.mint.copy(alpha = 0.12f)).padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Dot(Tl.mint, 6.dp); Spacer(Modifier.width(6.dp)); Text(saved ?: "", style = TlType.eyebrow, color = Tl.mint)
                    }
                }
            }
        }
        item { ProtectionHero(dash, form.values.count { it.on }, DEFS.size) { if (dash?.broker?.agentOn != false) askStop = true else vm.setProtection(true) } }
        pendingFrom?.let { p ->
            item {
                Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Tl.amber.copy(alpha = 0.10f)).border(1.dp, Tl.amber.copy(alpha = 0.4f), RoundedCornerShape(16.dp)).padding(14.dp)) {
                    Text("Changes scheduled for $p. You loosened a limit during market hours, so the new rules start next session.", style = TlType.body, color = Tl.amber)
                }
            }
        }
        error?.let { e -> item { Text(e, style = TlType.body, color = Tl.red, modifier = Modifier.padding(horizontal = 4.dp)) } }
        item {
            Row(Modifier.padding(horizontal = 4.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                Eyebrow("Starting capital today", Modifier.weight(1f))
                Text(capital?.takeIf { it > 0 }?.let { inr(it) } ?: "not known yet", style = TlType.num, color = Tl.text)
            }
        }
        if (form.isEmpty() && error == null) item { Box(Modifier.fillMaxWidth().padding(40.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = Tl.mint) } }
        DEFS.forEach { d ->
            val r = form[d.key] ?: return@forEach
            if (d.key == "maxLoss") item { Eyebrow("Whole account · Manual + Algo", Modifier.padding(start = 4.dp, top = 6.dp)) }
            if (d.key == "capitalUse") item { Eyebrow("Manual trading", Modifier.padding(start = 4.dp, top = 10.dp)) }
            if (d.key == "killSwitch") item { Eyebrow("When a limit hits", Modifier.padding(start = 4.dp, top = 10.dp)) }
            item(key = d.key) {
                RuleCard(d, r, line(d.key, r, capital, dash?.broker?.label ?: "broker"), if (d.key == "killSwitch") "${dash?.broker?.label ?: "Broker"} kill switch" else d.title) { edit(d.key, it) }
            }
        }
    }

    if (askStop) ConfirmSheet("Stop Protection?",
        listOf("Your ${dash?.broker?.label ?: "broker"} account is not watched any more.", "Limits are not enforced and nothing is exited automatically.", "Algo Trading stops too."),
        "Stop Protection", "Keep it on", danger = true, onDismiss = { askStop = false }) { askStop = false; vm.setProtection(false) }
}

@Composable
private fun ProtectionHero(d: Dash?, on: Int, total: Int, onToggle: () -> Unit) {
    val b = d?.broker
    val running = b != null && b.agentOn
    val locked = running && (d?.agentLock != null || d?.algoLocked == true)
    val tint = if (running) Tl.mint else Tl.amber
    TlCard(Modifier.fillMaxWidth(), padding = 20.dp) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(52.dp).clip(RoundedCornerShape(16.dp)).background(tint.copy(alpha = 0.14f)), contentAlignment = Alignment.Center) {
                Icon(if (locked) Icons.Rounded.Lock else Icons.Rounded.Shield, null, tint = tint, modifier = Modifier.size(26.dp))
            }
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text("Protection", style = TlType.title, color = Tl.text)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Dot(tint, 7.dp); Spacer(Modifier.width(6.dp))
                    Text(when { b == null -> "Not connected"; locked -> "Locked today"; running -> "Protecting"; else -> "Stopped" }, style = TlType.eyebrow, color = tint)
                }
            }
            Text("$on/$total", style = TlType.big, color = Tl.text)
        }
        Spacer(Modifier.height(12.dp))
        Text(when {
            b == null -> "Connect a broker so TradeLock can watch your trades against these rules."
            locked -> if (d?.algoLocked == true) "Algo Trading is on, so Protection stays on until 15:30." else "Today ${d?.agentLock}, so Protection stays on until the next trading day."
            running -> "Watching your ${b.label} positions every few seconds. When a limit below is hit, TradeLock acts at once."
            else -> "Your rules are not enforced. Trades are not watched and nothing is exited automatically."
        }, style = TlType.body, color = Tl.muted)
        if (b != null && !locked) {
            Spacer(Modifier.height(16.dp))
            if (running) GhostButton("Stop Protection", Modifier.fillMaxWidth()) { onToggle() } else PrimaryButton("Start Protection") { onToggle() }
        }
    }
}

@Composable
private fun RuleCard(d: Def, r: Rule, line: String, title: String, onChange: (Rule) -> Unit) {
    val border by animateColorAsState(if (r.on) Tl.mint.copy(alpha = 0.35f) else Tl.line, tween(220), label = "rb")
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(20.dp)).background(Tl.cardBrush).border(1.dp, border, RoundedCornerShape(20.dp)).padding(16.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.tactile({ onChange(r.copy(on = !r.on)) }, haptic = true)) {
            Column(Modifier.weight(1f)) {
                Text(title, style = TlType.label.copy(fontSize = 16.sp), color = if (r.on) Tl.text else Tl.muted)
                Spacer(Modifier.height(3.dp))
                Text(line, style = TlType.small.copy(fontSize = 13.sp), color = if (r.on) Tl.muted else Tl.dim)
            }
            Spacer(Modifier.width(12.dp))
            PillSwitch(r.on, Tl.mint)
        }
        AnimatedVisibility(r.on && d.kind != Kind.Switch, enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
            Column {
                Spacer(Modifier.height(14.dp))
                when (d.kind) {
                    Kind.Money -> Row(verticalAlignment = Alignment.CenterVertically) {
                        Segmented(listOf("percent" to "%", "amount" to "₹"), r.mode ?: "amount") { onChange(r.copy(mode = it)) }
                        Spacer(Modifier.width(10.dp))
                        NumberBox(r.value, if (r.mode == "percent") "%" else "₹", Modifier.weight(1f), decimal = r.mode == "percent") { onChange(r.copy(value = it)) }
                    }
                    Kind.Count -> NumberBox(r.value.substringBefore('.'), d.unit, Modifier.fillMaxWidth(), decimal = false) { onChange(r.copy(value = it)) }
                    Kind.Percent -> NumberBox(r.value, "%", Modifier.fillMaxWidth(), decimal = true) { onChange(r.copy(value = it)) }
                    Kind.Time -> Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        (CUTOFFS + r.value).distinct().sorted().forEach { t ->
                            val sel = t == r.value
                            Box(
                                Modifier.tactile({ onChange(r.copy(value = t)) }).clip(CircleShape)
                                    .background(if (sel) Tl.mint else Tl.surfaceHi).border(1.dp, if (sel) Tl.mint else Tl.lineHi, CircleShape)
                                    .padding(horizontal = 14.dp, vertical = 9.dp),
                            ) { Text(label12(t), style = TlType.numSm.copy(fontSize = 13.sp), color = if (sel) Color(0xFF04261F) else Tl.text) }
                        }
                    }
                    Kind.Switch -> Unit
                }
            }
        }
    }
}

@Composable
private fun Segmented(options: List<Pair<String, String>>, selected: String, onSelect: (String) -> Unit) {
    Row(Modifier.clip(RoundedCornerShape(12.dp)).background(Tl.surfaceHi).padding(3.dp)) {
        options.forEach { (k, label) ->
            val on = k == selected
            Box(
                Modifier.tactile({ onSelect(k) }).clip(RoundedCornerShape(10.dp)).background(if (on) Tl.raised else Color.Transparent)
                    .padding(horizontal = 16.dp, vertical = 10.dp),
                contentAlignment = Alignment.Center,
            ) { Text(label, style = TlType.label, color = if (on) Tl.mint else Tl.muted) }
        }
    }
}

@Composable
private fun NumberBox(value: String, affix: String, modifier: Modifier, decimal: Boolean, onChange: (String) -> Unit) {
    var text by remember(value) { mutableStateOf(value.removeSuffix(".0")) }
    Row(
        modifier.height(48.dp).clip(RoundedCornerShape(12.dp)).background(Tl.surfaceHi).border(1.dp, Tl.lineHi, RoundedCornerShape(12.dp)).padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (affix == "₹") { Text("₹", style = TlType.num, color = Tl.muted); Spacer(Modifier.width(6.dp)) }
        BasicTextField(
            value = text,
            onValueChange = { v ->
                val clean = v.filter { it.isDigit() || (decimal && it == '.') }.take(10)
                text = clean
                if (clean.isNotEmpty() && clean != ".") onChange(clean)
            },
            singleLine = true,
            textStyle = TlType.num.copy(fontSize = 17.sp, color = Tl.text, textAlign = TextAlign.Start),
            cursorBrush = SolidColor(Tl.mint),
            keyboardOptions = KeyboardOptions(keyboardType = if (decimal) KeyboardType.Decimal else KeyboardType.Number),
            modifier = Modifier.weight(1f),
        )
        if (affix != "₹") Text(affix, style = TlType.small.copy(fontSize = 13.sp), color = Tl.muted)
    }
}
