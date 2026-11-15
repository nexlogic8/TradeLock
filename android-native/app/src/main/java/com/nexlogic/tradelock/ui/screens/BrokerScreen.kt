package com.nexlogic.tradelock.ui.screens

import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.Info
import androidx.compose.material.icons.rounded.Sync
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
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
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.nexlogic.tradelock.data.Api
import com.nexlogic.tradelock.data.ApiError
import com.nexlogic.tradelock.data.AppViewModel
import com.nexlogic.tradelock.data.Toast
import com.nexlogic.tradelock.data.arr
import com.nexlogic.tradelock.data.bool
import com.nexlogic.tradelock.data.long
import com.nexlogic.tradelock.data.num
import com.nexlogic.tradelock.data.obj
import com.nexlogic.tradelock.data.str
import com.nexlogic.tradelock.ui.ago
import com.nexlogic.tradelock.ui.components.Dot
import com.nexlogic.tradelock.ui.components.Eyebrow
import com.nexlogic.tradelock.ui.components.TlCard
import com.nexlogic.tradelock.ui.components.tactile
import com.nexlogic.tradelock.ui.inr
import com.nexlogic.tradelock.ui.theme.Tl
import com.nexlogic.tradelock.ui.theme.TlType
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val WHEN = DateTimeFormatter.ofPattern("d MMM, HH:mm").withZone(ZoneId.of("Asia/Kolkata"))
private const val DHAN_JOIN = "https://join.dhan.co/?invite=LEPRP96225"
private enum class BAsk { None, Reconnect, Disconnect, Permissions }

/**
 * Broker accounts, as on the web: tabs for Paper, Dhan, StoxKart and the coming brokers. Paper on / off, connect or
 * switch a broker (static IP step + client ID and token), refresh, reconnect with a new token, permissions, disconnect,
 * order access and the kill switch, and the StoxKart link (save, test, remove, orders through StoxKart or Dhan).
 */
@Composable
fun BrokerScreen(vm: AppViewModel, onBack: () -> Unit, onOpenWeb: (String) -> Unit) {
    BackHandler { onBack() }
    val dash by vm.dash.collectAsState()
    var data by remember { mutableStateOf<JsonObject?>(null) }
    var paper by remember { mutableStateOf<JsonObject?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var tab by remember { mutableStateOf<String?>(null) }
    var switching by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf<String?>(null) }
    var ask by remember { mutableStateOf(BAsk.None) }
    val scope = rememberCoroutineScope()

    suspend fun load() {
        try { data = Api.get("/brokers"); paper = runCatching { Api.get("/paper/wallet") }.getOrNull(); error = null } catch (e: ApiError) { error = e.message }
    }
    LaunchedEffect(Unit) { load() }
    LaunchedEffect(dash?.broker?.status, dash?.broker?.lastSyncAt) { if (data != null) runCatching { data = Api.get("/brokers") } }
    fun act(label: String, ok: String? = null, block: suspend () -> Unit) {
        if (busy != null) return
        busy = label
        scope.launch {
            try { block(); load(); vm.reloadDash(); ok?.let { vm.toast(it) } } catch (e: ApiError) { vm.toast(e.message, Toast.Tone.Error) }
            busy = null
        }
    }

    val a = data?.obj("account")
    val real = a?.takeIf { it.str("broker") != "paper" }
    val link = data?.obj("links")?.obj("stoxkart")
    val catalog = listOf("paper" to "Paper") + (data?.arr("catalog")?.mapNotNull { (it as? JsonObject)?.let { c -> (c.str("id") ?: "") to (c.str("name") ?: "") } }.orEmpty())
    val current = tab ?: when { real == null || a.bool("paperMode") == true -> "paper"; real.str("tradeVia") == "stoxkart" -> "stoxkart"; else -> real.str("broker") ?: "dhan" }
    val soon = data?.arr("catalog")?.mapNotNull { it as? JsonObject }?.firstOrNull { it.str("id") == current && it.str("status") != "available" }

    Column(Modifier.fillMaxSize().background(Tl.bg).statusBarsPadding().navigationBarsPadding().verticalScroll(rememberScrollState()).padding(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(44.dp).tactile(onBack).clip(RoundedCornerShape(14.dp)).background(Tl.surface), contentAlignment = Alignment.Center) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, null, tint = Tl.text) }
            Spacer(Modifier.width(12.dp))
            Column {
                Text("Broker accounts", fontSize = 26.sp, fontWeight = FontWeight.ExtraBold, color = Tl.text)
                Text("Connection health and what your broker allows", style = TlType.small, color = Tl.muted)
            }
        }
        Spacer(Modifier.height(16.dp))
        if (data == null) { Box(Modifier.fillMaxWidth().padding(40.dp), contentAlignment = Alignment.Center) { if (error != null) Text(error!!, color = Tl.red) else CircularProgressIndicator(color = Tl.mint) }; return@Column }

        // ---- broker tabs ----
        Row(Modifier.horizontalScroll(rememberScrollState()).clip(RoundedCornerShape(16.dp)).background(Tl.surface).border(1.dp, Tl.line, RoundedCornerShape(16.dp)).padding(4.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            catalog.forEach { (id, name) ->
                val on = id == current
                val bg by animateColorAsState(if (on) Tl.raised else Color.Transparent, tween(200), label = "tab")
                val inUse = (id == "paper" && (real == null || a.bool("paperMode") == true)) || (id == real?.str("broker") && real?.bool("paperMode") != true && real?.str("tradeVia") != "stoxkart") ||
                    (id == "stoxkart" && link?.bool("trading") == true)
                Row(Modifier.tactile({ tab = id; switching = false }).clip(RoundedCornerShape(12.dp)).background(bg).padding(horizontal = 12.dp, vertical = 9.dp), verticalAlignment = Alignment.CenterVertically) {
                    BrokerMark(id, name, 22)
                    Spacer(Modifier.width(7.dp))
                    Text(name, style = TlType.label.copy(fontSize = 14.sp), color = if (on) Tl.text else Tl.muted, maxLines = 1)
                    if (inUse) { Spacer(Modifier.width(6.dp)); Dot(Tl.mint, 6.dp) }
                }
            }
        }
        Spacer(Modifier.height(14.dp))

        when {
            current == "paper" -> PaperPane(a, real, paper, busy,
                usePaper = { act("paper", "Paper trading is on: no orders go to your broker.") { if (real != null) Api.post("/brokers/${real.str("id")}/paper", buildJsonObject { put("on", true) }) else Api.post("/paper/account") } },
                useReal = { act("real", "Real trading is on.") { Api.post("/brokers/${real!!.str("id")}/paper", buildJsonObject { put("on", false) }) } },
                onOpen = onOpenWeb)
            soon != null && current != "stoxkart" -> TlCard(Modifier.fillMaxWidth(), padding = 20.dp) {
                Row(verticalAlignment = Alignment.CenterVertically) { BrokerMark(current, soon.str("name") ?: current, 40); Spacer(Modifier.width(12.dp)); Text(soon.str("name") ?: current, style = TlType.title, color = Tl.text) }
                Spacer(Modifier.height(10.dp))
                Text("Coming soon. TradeLock will connect ${soon.str("name")} the same way as Dhan: your limits enforced at the broker.", style = TlType.body, color = Tl.muted)
            }
            current == "stoxkart" -> StoxkartPane(link, real, busy, ::act, onOpenWeb)
            real == null || switching -> ConnectPane(data!!, current, cancel = if (switching) ({ switching = false }) else null) { body ->
                try {
                    val r = Api.post("/brokers/connect", body)
                    switching = false; load(); vm.reloadDash()
                    val warn = r.arr("checks").mapNotNull { it as? JsonObject }.any { it.str("id") == "orders" && it.bool("warn") == true }
                    vm.toast(if (warn) "Connected. Add the static IP in Dhan so exits can run." else "Connected.", if (warn) Toast.Tone.Warn else Toast.Tone.Ok); null
                } catch (e: ApiError) { e.message }
            }
            else -> AccountPane(real, data!!, link, busy,
                onRefresh = { act("sync", "Refreshed from ${real.str("label")}.") { Api.post("/brokers/${real.str("id")}/sync") } },
                onReconnect = { ask = BAsk.Reconnect }, onPermissions = { ask = BAsk.Permissions }, onDisconnect = { ask = BAsk.Disconnect },
                onSwitch = { switching = true },
                onTradeVia = { viaStox -> act("via", "Orders now go through ${if (viaStox) "StoxKart" else "Dhan"}.") { Api.post("/brokers/links/stoxkart/trade-via", buildJsonObject { put("on", viaStox) }) } })
        }
    }

    val name = real?.str("label") ?: "broker"
    when (ask) {
        BAsk.None -> Unit
        BAsk.Reconnect -> {
            var token by remember { mutableStateOf("") }
            var err by remember { mutableStateOf<String?>(null) }
            TlSheet({ ask = BAsk.None }) {
                Text("Reconnect $name", style = TlType.title.copy(fontSize = 22.sp), color = Tl.text)
                Spacer(Modifier.height(8.dp))
                Text("Paste a fresh access token: web.dhan.co → My Profile → Access DhanHQ APIs. Dhan tokens last 24 hours.", style = TlType.body, color = Tl.muted)
                BField("New access token", token, secret = true) { token = it.trim() }
                err?.let { Text(it, style = TlType.small, color = Tl.red) }
                Spacer(Modifier.height(14.dp))
                PrimaryButton(if (busy == "reconnect") "Checking…" else "Verify and save") {
                    if (token.length < 20) { err = "Paste the full access token."; return@PrimaryButton }
                    busy = "reconnect"
                    scope.launch {
                        try { Api.post("/brokers/${real?.str("id")}/reconnect", buildJsonObject { put("accessToken", token) }); ask = BAsk.None; load(); vm.reloadDash(); vm.toast("$name reconnected.") }
                        catch (e: ApiError) { err = e.message }
                        busy = null
                    }
                }
            }
        }
        BAsk.Disconnect -> ConfirmSheet("Disconnect $name?",
            listOf("Monitoring and rule enforcement stop immediately.", "Your stored access token is deleted.", "Connect again any time with a new token."),
            "Disconnect", "Keep it", danger = true, onDismiss = { ask = BAsk.None }) {
            ask = BAsk.None
            act("disconnect", "$name disconnected.") { Api.delete("/brokers/${real?.str("id")}") }
        }
        BAsk.Permissions -> TlSheet({ ask = BAsk.None }) {
            Text("$name APIs TradeLock uses", style = TlType.title.copy(fontSize = 20.sp), color = Tl.text)
            Spacer(Modifier.height(10.dp))
            listOf(
                "GET /positions, /orders, /trades" to "Positions, P&L, order book and fills, every 2 s while the market is open",
                "GET /fundlimit" to "Available margin, used margin and capital",
                "GET /profile" to "Token expiry and active segments",
                "GET /ip/getIP" to "Whether $name accepts orders from this server (static IP)",
                "GET /killswitch" to "Kill switch status, checked every 10 s",
                "POST /killswitch" to "Lock the account when a rule is hit or you press the kill switch",
                "POST /orders, DELETE /orders" to "Orders you place in TradeLock, exits and the kill switch",
            ).forEach { (k, v) ->
                Text(k, style = TlType.numSm.copy(fontSize = 13.sp, fontWeight = FontWeight.Bold), color = Tl.mint, modifier = Modifier.padding(top = 8.dp))
                Text(v, style = TlType.small.copy(fontSize = 13.sp), color = Tl.muted)
            }
        }
    }
}

/** A round broker mark: the brand's first letter on its colour (Paper: P on blue). */
@Composable
private fun BrokerMark(id: String, name: String, size: Int) {
    val (bg, fg) = when (id) {
        "dhan" -> Color.White to Color(0xFF0E8F6E); "paper" -> Color(0xFF1C2E4A) to Color(0xFF5AA9FF); "stoxkart" -> Color(0xFF0B3D2E) to Color(0xFF2BD67B)
        "zerodha" -> Color.White to Color(0xFF387ED1); "upstox" -> Color(0xFF5A2D91) to Color.White; "angelone" -> Color.White to Color(0xFF1C47B9); else -> Tl.raised to Tl.text
    }
    Box(Modifier.size(size.dp).clip(RoundedCornerShape((size / 3.5).dp)).background(bg), contentAlignment = Alignment.Center) {
        Text(name.take(1), color = fg, fontWeight = FontWeight.Black, fontSize = (size * 0.5).sp)
    }
}

@Composable
private fun Pill(text: String, c: Color) = Text(text.uppercase(), style = TlType.eyebrow.copy(fontSize = 9.sp), color = c,
    modifier = Modifier.clip(CircleShape).background(c.copy(alpha = 0.13f)).padding(horizontal = 8.dp, vertical = 4.dp))

/** One capability row: what it is, its state, and a line of detail. */
@Composable
private fun Cap(title: String, state: String, tone: Color, detail: String, extra: (@Composable ColumnScope.() -> Unit)? = null) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 11.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(title, style = TlType.label, color = Tl.text, modifier = Modifier.weight(1f))
            Pill(state, tone)
        }
        Spacer(Modifier.height(4.dp))
        Text(detail, style = TlType.small.copy(fontSize = 13.sp), color = Tl.muted)
        extra?.invoke(this)
    }
}

@Composable
private fun PaperPane(a: JsonObject?, real: JsonObject?, wallet: JsonObject?, busy: String?, usePaper: () -> Unit, useReal: () -> Unit, onOpen: (String) -> Unit) {
    val inUse = a == null || a.str("broker") == "paper" || a.bool("paperMode") == true
    TlCard(Modifier.fillMaxWidth(), padding = 20.dp) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            BrokerMark("paper", "Paper", 48); Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text("Paper trading", style = TlType.title, color = Tl.text)
                Row(verticalAlignment = Alignment.CenterVertically) { Pill(if (inUse) "In use" else "Not in use", if (inUse) Tl.mint else Tl.dim) }
            }
        }
        Spacer(Modifier.height(12.dp))
        wallet?.num("balance")?.let { Text("Paper wallet ${inr(it)}", style = TlType.num.copy(fontSize = 16.sp), color = Tl.text) }
        Text("Live prices, simulated fills: no order goes to any broker.", style = TlType.small, color = Tl.muted)
    }
    Spacer(Modifier.height(12.dp))
    TlCard(Modifier.fillMaxWidth(), padding = 6.dp) {
        Cap("Orders", "Simulated", Tl.mint, "Filled at the live price with the paper wallet's money; stop-losses rest until the price reaches them, as at a broker.")
        Cap("Prices", "Live", Tl.mint, "From TradeLock's Dhan market data: option chain, quotes and the live feed. No broker account needed.")
        Cap("Algo Trading and risk rules", "Available", Tl.mint, "Strategies, stop-loss, exits, your Risk rules and the day lock run exactly as with real money.")
    }
    Spacer(Modifier.height(14.dp))
    when {
        !inUse -> PrimaryButton(if (busy == "paper") "Switching…" else "Use paper trading") { usePaper() }
        real != null -> PrimaryButton(if (busy == "real") "Switching…" else "Switch to real money (${real.str("label")?.takeIf { it != "Paper" } ?: "Dhan"})") { useReal() }
        else -> Text("To trade with real money, open the Dhan tab and connect your account. It starts on Paper, and Real is one switch away.", style = TlType.small, color = Tl.muted)
    }
    Spacer(Modifier.height(10.dp))
    GhostButton("Set paper balance", Modifier.fillMaxWidth()) { onOpen("wallet?web=1") }
}

@Composable
private fun AccountPane(
    a: JsonObject, data: JsonObject, link: JsonObject?, busy: String?,
    onRefresh: () -> Unit, onReconnect: () -> Unit, onPermissions: () -> Unit, onDisconnect: () -> Unit, onSwitch: () -> Unit, onTradeVia: (Boolean) -> Unit,
) {
    val name = data.arr("catalog").mapNotNull { it as? JsonObject }.firstOrNull { it.str("id") == a.str("broker") }?.str("name") ?: a.str("label") ?: "Broker"
    val status = a.str("status")
    val (badge, tone) = when (status) { "connected" -> "Connected" to Tl.mint; "delayed" -> "Reconnecting…" to Tl.amber; "expired" -> "Disconnected · token expired" to Tl.red; else -> "Disconnected" to Tl.red }
    val perms = a.obj("permissions")
    val ip = data.obj("staticIp")
    val ks = a.obj("killSwitch")
    val clip = LocalClipboardManager.current

    TlCard(Modifier.fillMaxWidth(), padding = 20.dp) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            BrokerMark(a.str("broker") ?: "", name, 52); Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(name, style = TlType.title, color = Tl.text); Spacer(Modifier.width(8.dp))
                    Text(a.str("clientId") ?: "", style = TlType.numSm.copy(fontSize = 13.sp), color = Tl.muted)
                }
                Spacer(Modifier.height(4.dp))
                Pill(badge, tone)
            }
        }
        Spacer(Modifier.height(12.dp))
        Text("Last successful sync: ${a.long("lastSyncAt")?.let { ago(it) } ?: "—"}" + (a.str("lastError")?.takeIf { it.isNotBlank() && status != "connected" }?.let { " · $it" } ?: ""),
            style = TlType.small, color = Tl.muted)
        Spacer(Modifier.height(16.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(Modifier.weight(1f).height(50.dp).tactile(onRefresh).clip(RoundedCornerShape(16.dp)).background(Tl.mintBrush),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center) {
                if (busy == "sync") CircularProgressIndicator(Modifier.size(18.dp), color = Color(0xFF04261F), strokeWidth = 2.dp) else Icon(Icons.Rounded.Sync, null, tint = Color(0xFF04261F), modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp)); Text("Refresh now", color = Color(0xFF04261F), fontWeight = FontWeight.Bold)
            }
            if (a.str("broker") != "mock") GhostButton("Reconnect", Modifier.weight(1f)) { onReconnect() }
        }
    }

    // StoxKart linked and tested: which broker the orders go to.
    if (link?.bool("linked") == true && link.str("status") == "verified") {
        Spacer(Modifier.height(12.dp))
        TlCard(Modifier.fillMaxWidth(), padding = 16.dp) {
            Eyebrow("Orders go through")
            Spacer(Modifier.height(10.dp))
            Row(Modifier.clip(RoundedCornerShape(12.dp)).background(Tl.surfaceHi).padding(3.dp)) {
                listOf(false to "Dhan", true to "StoxKart").forEach { (via, label) ->
                    val on = (link.bool("trading") == true) == via
                    Box(Modifier.weight(1f).tactile({ if (!on) onTradeVia(via) }).clip(RoundedCornerShape(10.dp)).background(if (on) Tl.raised else Color.Transparent).padding(vertical = 10.dp), contentAlignment = Alignment.Center) {
                        Text(if (busy == "via" && !on) "Switching…" else label, style = TlType.label, color = if (on) Tl.mint else Tl.muted)
                    }
                }
            }
            Text("Dhan keeps supplying the market data. Switch only with nothing open.", style = TlType.small, color = Tl.dim, modifier = Modifier.padding(top = 8.dp))
        }
    }

    Spacer(Modifier.height(12.dp))
    Eyebrow("What TradeLock can do on it", Modifier.padding(start = 4.dp, bottom = 10.dp))
    TlCard(Modifier.fillMaxWidth(), padding = 6.dp) {
        Cap("Positions and orders", "Available", Tl.mint, "Read every 2 seconds while the market is open.")
        when (perms?.bool("ordersAllowed")) {
            true -> Cap("Automated square-off", "Available", Tl.mint, "$name accepts orders from TradeLock, so exits and the kill switch can run.")
            false -> Cap("Automated square-off", "Blocked · static IP", Tl.red,
                "$name will reject exit orders from TradeLock. Under SEBI rules it only accepts API orders from your registered static IP.") {
                val registered = perms.arr("registeredIps").mapNotNull { (it as? JsonPrimitive)?.content }
                Spacer(Modifier.height(8.dp))
                Text("TradeLock sends your orders from:", style = TlType.small, color = Tl.text)
                IpRow(ip?.str("ip") ?: "34.93.19.54") { clip.setText(AnnotatedString(it)) }
                Text("Registered in $name: " + (registered.joinToString(", ").ifEmpty { "none" }), style = TlType.small, color = Tl.muted)
                Text("Fix: web.dhan.co → My Profile → DhanHQ Trading APIs → Static IP Setting → Edit IP Address 1 or 2 → paste the IP above." +
                    (if (ip?.bool("own") != true) ip?.str("alt")?.let { "\nIf Dhan says it's used by another account, use the IPv6: $it" } ?: "" else ""), style = TlType.small, color = Tl.muted, modifier = Modifier.padding(top = 6.dp))
            }
            else -> Cap("Automated square-off", if (a.str("broker") == "mock") "Available" else "Checking…", if (a.str("broker") == "mock") Tl.mint else Tl.dim,
                "Checking whether $name accepts orders from this server. Refresh now to check immediately.")
        }
        val ksOn = ks?.bool("active")
        Cap("Account-wide lock (kill switch)", when (ksOn) { true -> "On · locked"; false -> "Available · off"; else -> "Kill switch" }, when (ksOn) { true -> Tl.red; false -> Tl.mint; else -> Color(0xFF5AA9FF) },
            "Uses $name's kill switch, which also blocks orders from the $name app. It needs a flat account to switch on." + (ks?.long("checkedAt")?.let { " Status read ${ago(it)}." } ?: ""))
        a.long("tokenExpiresAt")?.let { exp ->
            val left = exp - System.currentTimeMillis()
            Cap("Access token expires", if (left < 0) "Expired" else if (left < 3 * 3600_000) "Soon" else WHEN.format(Instant.ofEpochMilli(exp)), if (left < 0) Tl.red else if (left < 3 * 3600_000) Tl.amber else Tl.muted,
                "${WHEN.format(Instant.ofEpochMilli(exp))} IST. Dhan tokens last 24 hours: paste a fresh one with Reconnect.")
        }
    }
    Spacer(Modifier.height(14.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        GhostButton("View permissions", Modifier.weight(1f)) { onPermissions() }
        GhostButton("Switch broker", Modifier.weight(1f)) { onSwitch() }
    }
    Spacer(Modifier.height(10.dp))
    Box(Modifier.fillMaxWidth().height(50.dp).tactile(onDisconnect).clip(RoundedCornerShape(16.dp)).background(Tl.red.copy(alpha = 0.10f)).border(1.dp, Tl.red.copy(alpha = 0.4f), RoundedCornerShape(16.dp)),
        contentAlignment = Alignment.Center) { Text(if (busy == "disconnect") "Disconnecting…" else "Disconnect $name", style = TlType.label, color = Tl.red) }
}

@Composable
private fun IpRow(ip: String, onCopy: (String) -> Unit) {
    var copied by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp).clip(RoundedCornerShape(12.dp)).background(Tl.surfaceHi).padding(start = 14.dp, end = 6.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(ip, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, fontSize = 17.sp, color = Tl.text, modifier = Modifier.weight(1f))
        Row(Modifier.tactile({ onCopy(ip); copied = true }).clip(RoundedCornerShape(10.dp)).background(Tl.raised).padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Rounded.ContentCopy, null, tint = Tl.mint, modifier = Modifier.size(15.dp)); Spacer(Modifier.width(6.dp))
            Text(if (copied) "Copied" else "Copy IP", style = TlType.small.copy(fontWeight = FontWeight.Bold), color = Tl.mint)
        }
    }
}

/** Connect (no broker yet) or switch to another broker: the static IP step, then client ID + access token. onConnect returns null when done. */
@Composable
private fun ConnectPane(data: JsonObject, broker: String, cancel: (() -> Unit)?, onConnect: suspend (JsonObject) -> String?) {
    val ctx = LocalContext.current
    val clip = LocalClipboardManager.current
    val ip = data.obj("staticIp")
    var client by remember { mutableStateOf("") }
    var token by remember { mutableStateOf("") }
    var err by remember { mutableStateOf<String?>(null) }
    var running by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val name = data.arr("catalog").mapNotNull { it as? JsonObject }.firstOrNull { it.str("id") == broker }?.str("name") ?: "Dhan"
    val mock = broker == "mock"

    if (!mock) {
        TlCard(Modifier.fillMaxWidth(), padding = 18.dp) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("1", style = TlType.label, color = Tl.mint, modifier = Modifier.clip(CircleShape).background(Tl.mint.copy(alpha = 0.14f)).padding(horizontal = 10.dp, vertical = 4.dp))
                Spacer(Modifier.width(10.dp)); Text("Allow TradeLock's IP in $name", style = TlType.label.copy(fontSize = 16.sp), color = Tl.text)
            }
            Spacer(Modifier.height(8.dp))
            Text("SEBI rules: $name only accepts API orders from your registered static IP. Add TradeLock's server IP so automatic exits and the kill switch can close positions. Monitoring works without it.",
                style = TlType.small.copy(fontSize = 13.sp), color = Tl.muted)
            if (ip?.bool("own") == true) Text("Your own TradeLock IP: only your account uses it.", style = TlType.small, color = Tl.mint, modifier = Modifier.padding(top = 6.dp))
            IpRow(ip?.str("ip") ?: "34.93.19.54") { clip.setText(AnnotatedString(it)) }
            if (ip?.bool("own") != true) ip?.str("alt")?.let { Text("Already used by another account in Dhan? Use the IPv6: $it", style = TlType.small, color = Tl.dim) }
            Spacer(Modifier.height(6.dp))
            listOf("Open web.dhan.co → My Profile → DhanHQ Trading APIs", "Static IP Setting (not TOTP) → Edit IP Address 1 or 2", "Paste the IP above and save").forEachIndexed { i, t ->
                Text("${i + 1}. $t", style = TlType.small.copy(fontSize = 13.sp), color = Tl.text, modifier = Modifier.padding(top = 4.dp))
            }
        }
        Spacer(Modifier.height(12.dp))
    }
    TlCard(Modifier.fillMaxWidth(), padding = 18.dp) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (!mock) { Text("2", style = TlType.label, color = Tl.mint, modifier = Modifier.clip(CircleShape).background(Tl.mint.copy(alpha = 0.14f)).padding(horizontal = 10.dp, vertical = 4.dp)); Spacer(Modifier.width(10.dp)) }
            Text(if (mock) "Connect the demo broker" else "Connect with your access token", style = TlType.label.copy(fontSize = 16.sp), color = Tl.text)
        }
        if (!mock) {
            BField("$name client ID", client, type = KeyboardType.Number) { client = it.trim() }
            BField("Access token", token, secret = true) { token = it.trim() }
            Text("Generate a token at web.dhan.co → My Profile → Access DhanHQ APIs. Tokens expire every 24 hours; TradeLock reminds you to reconnect.", style = TlType.small, color = Tl.dim, modifier = Modifier.padding(top = 6.dp))
        }
        err?.let { Text(it, style = TlType.small, color = Tl.red, modifier = Modifier.padding(top = 8.dp)) }
        Spacer(Modifier.height(14.dp))
        PrimaryButton(if (running) "Connecting…" else "Connect $name") {
            if (running) return@PrimaryButton
            if (!mock && (client.length < 4 || token.length < 20)) { err = "Enter your client ID and the full access token."; return@PrimaryButton }
            running = true; err = null
            scope.launch { err = onConnect(buildJsonObject { put("broker", broker); if (!mock) { put("clientId", client); put("accessToken", token) } }); running = false }
        }
        if (broker == "dhan") {
            Spacer(Modifier.height(10.dp))
            GhostButton("Open a Dhan account", Modifier.fillMaxWidth()) { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(DHAN_JOIN))) }
        }
        cancel?.let { Spacer(Modifier.height(6.dp)); Text("Cancel", style = TlType.label, color = Tl.muted, modifier = Modifier.fillMaxWidth().tactile(it).padding(12.dp), textAlign = androidx.compose.ui.text.style.TextAlign.Center) }
    }
}

/** StoxKart (orders through StoxKart, Dhan keeps the market data): link status, test, update, remove. */
@Composable
private fun StoxkartPane(link: JsonObject?, real: JsonObject?, busy: String?, act: (String, String?, suspend () -> Unit) -> Unit, onOpen: (String) -> Unit) {
    val linked = link?.bool("linked") == true
    var editing by remember { mutableStateOf(false) }
    val (label, tone) = when (link?.str("status")) { "verified" -> "Connected" to Tl.mint; "failed" -> "Disconnected · login failed" to Tl.red; "linked" -> "Saved, not tested" to Tl.amber; else -> "Beta" to Color(0xFF5AA9FF) }
    TlCard(Modifier.fillMaxWidth(), padding = 20.dp) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            BrokerMark("stoxkart", "StoxKart", 52); Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("StoxKart", style = TlType.title, color = Tl.text)
                    link?.str("clientId")?.let { Spacer(Modifier.width(8.dp)); Text(it, style = TlType.numSm, color = Tl.muted) }
                }
                Spacer(Modifier.height(4.dp)); Pill(label, tone)
            }
        }
        Spacer(Modifier.height(10.dp))
        Text(if (linked) "Last successful login: ${link?.long("verifiedAt")?.let { ago(it) } ?: "not yet"}" else "Link your StoxKart account (Superr API). Dhan keeps supplying the market data.", style = TlType.small, color = Tl.muted)
        if (real == null) Text("Connect Dhan first: it supplies the market data.", style = TlType.small, color = Tl.amber, modifier = Modifier.padding(top = 6.dp))
    }
    if (link?.str("status") == "failed" && !link.str("lastError").isNullOrBlank()) {
        Spacer(Modifier.height(10.dp))
        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Tl.red.copy(alpha = 0.10f)).padding(14.dp)) {
            Icon(Icons.Rounded.ErrorOutline, null, tint = Tl.red); Spacer(Modifier.width(10.dp))
            Text("StoxKart refused the login: ${link.str("lastError")}", style = TlType.small, color = Tl.text)
        }
    }
    Spacer(Modifier.height(12.dp))
    if (linked && !editing) {
        TlCard(Modifier.fillMaxWidth(), padding = 6.dp) {
            Cap("Positions and orders", "Available", Tl.mint, "Read every 2 seconds while the market is open.")
            Cap("Automated square-off", "Available", Tl.mint, "StoxKart accepts orders from TradeLock. Keep 34.93.19.54 in your Superr API app's static IPs.")
            Cap("Account-wide lock", "Not offered", Tl.dim, "StoxKart has no API kill switch. When a rule is hit TradeLock closes positions and blocks its own orders.")
            Cap("Algo ID", link?.str("algoId") ?: "99999", Tl.muted, "Sent with every order, as SEBI's algo rules require.")
            Cap("Session", "Renews daily", Tl.muted, "TradeLock logs in to StoxKart each day with your TOTP, so there is no token to paste.")
        }
        Spacer(Modifier.height(14.dp))
        PrimaryButton(if (busy == "sktest") "Logging in to StoxKart…" else "Test connection") { act("sktest", "StoxKart connection tested.") { Api.post("/brokers/links/stoxkart/test") } }
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            GhostButton("Update details", Modifier.weight(1f)) { editing = true }
            GhostButton("Remove", Modifier.weight(1f)) { act("skremove", "StoxKart details removed.") { Api.delete("/brokers/links/stoxkart") } }
        }
        if (link?.str("status") == "verified" && real != null) {
            Spacer(Modifier.height(10.dp))
            val trading = link.bool("trading") == true
            GhostButton(if (busy == "via") "Switching…" else if (trading) "Send orders through Dhan again" else "Send orders through StoxKart", Modifier.fillMaxWidth()) {
                act("via", "Orders now go through ${if (trading) "Dhan" else "StoxKart"}.") { Api.post("/brokers/links/stoxkart/trade-via", buildJsonObject { put("on", !trading) }) }
            }
        }
    } else {
        var client by remember { mutableStateOf("") }; var pass by remember { mutableStateOf("") }; var key by remember { mutableStateOf("") }
        var secret by remember { mutableStateOf("") }; var totp by remember { mutableStateOf("") }; var algo by remember { mutableStateOf(link?.str("algoId") ?: "99999") }
        TlCard(Modifier.fillMaxWidth(), padding = 18.dp) {
            val keep = if (linked) " (blank keeps the saved one)" else ""
            BField("StoxKart client ID", client) { client = it }
            BField("StoxKart password$keep", pass, secret = true) { pass = it }
            BField("API key$keep", key, secret = true) { key = it }
            BField("API secret$keep", secret, secret = true) { secret = it }
            BField("TOTP secret (setup key)$keep", totp, secret = true) { totp = it }
            BField("Algo ID", algo) { algo = it }
            Text("Stored encrypted on TradeLock's server for your account only, never shown again, and sent only to StoxKart.", style = TlType.small, color = Tl.dim, modifier = Modifier.padding(top = 6.dp))
            Spacer(Modifier.height(14.dp))
            PrimaryButton(if (busy == "sksave") "Saving…" else "Save and test") {
                act("sksave", "StoxKart details saved.") {
                    Api.put("/brokers/links/stoxkart", buildJsonObject { put("clientId", client); put("password", pass); put("apiKey", key); put("apiSecret", secret); put("totpSecret", totp); put("algoId", algo) })
                    runCatching { Api.post("/brokers/links/stoxkart/test") }
                    editing = false
                }
            }
            if (linked) Text("Cancel", style = TlType.label, color = Tl.muted, modifier = Modifier.fillMaxWidth().tactile({ editing = false }).padding(12.dp), textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        }
    }
}

@Composable
private fun BField(label: String, value: String, secret: Boolean = false, type: KeyboardType = KeyboardType.Text, onChange: (String) -> Unit) =
    OutlinedTextField(value, onChange, label = { Text(label) }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 10.dp), shape = RoundedCornerShape(14.dp),
        visualTransformation = if (secret) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = KeyboardOptions(keyboardType = if (secret) KeyboardType.Password else type),
        colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = Tl.mint, unfocusedBorderColor = Tl.lineHi, focusedLabelColor = Tl.mint, cursorColor = Tl.mint, focusedTextColor = Tl.text, unfocusedTextColor = Tl.text))
