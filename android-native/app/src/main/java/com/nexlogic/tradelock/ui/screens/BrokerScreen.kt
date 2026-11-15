package com.nexlogic.tradelock.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.ErrorOutline
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.nexlogic.tradelock.data.Api
import com.nexlogic.tradelock.data.ApiError
import com.nexlogic.tradelock.data.AppViewModel
import com.nexlogic.tradelock.data.Toast
import com.nexlogic.tradelock.data.bool
import com.nexlogic.tradelock.data.long
import com.nexlogic.tradelock.data.obj
import com.nexlogic.tradelock.data.str
import com.nexlogic.tradelock.ui.ago
import com.nexlogic.tradelock.ui.components.Dot
import com.nexlogic.tradelock.ui.components.Eyebrow
import com.nexlogic.tradelock.ui.components.TlCard
import com.nexlogic.tradelock.ui.components.tactile
import com.nexlogic.tradelock.ui.theme.Tl
import com.nexlogic.tradelock.ui.theme.TlType
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val WHEN = DateTimeFormatter.ofPattern("d MMM, HH:mm").withZone(ZoneId.of("Asia/Kolkata"))

/** The connected broker: status, last sync, token, order permission and static IP; sync now; paste a new token. */
@Composable
fun BrokerScreen(vm: AppViewModel, onBack: () -> Unit, onOpenWeb: (String) -> Unit) {
    BackHandler { onBack() }
    var data by remember { mutableStateOf<JsonObject?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var syncing by remember { mutableStateOf(false) }
    var reconnect by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    suspend fun load() { try { data = Api.get("/brokers"); error = null } catch (e: ApiError) { error = e.message } }
    LaunchedEffect(Unit) { load() }

    val a = data?.obj("account")
    val perms = a?.obj("permissions")
    val status = a?.str("status")
    val ok = status == "connected"
    val tint = if (ok) Tl.mint else Tl.amber

    Column(Modifier.fillMaxSize().background(Tl.bg).statusBarsPadding().navigationBarsPadding().verticalScroll(rememberScrollState()).padding(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(44.dp).tactile(onBack).clip(RoundedCornerShape(14.dp)).background(Tl.surface), contentAlignment = Alignment.Center) {
                Icon(Icons.AutoMirrored.Rounded.ArrowBack, null, tint = Tl.text)
            }
            Spacer(Modifier.width(12.dp))
            Text("Broker accounts", fontSize = 26.sp, fontWeight = FontWeight.ExtraBold, color = Tl.text)
        }
        Spacer(Modifier.height(16.dp))
        if (data == null) { Box(Modifier.fillMaxWidth().padding(40.dp), contentAlignment = Alignment.Center) { if (error != null) Text(error!!, color = Tl.red) else CircularProgressIndicator(color = Tl.mint) }; return@Column }
        if (a == null) {
            TlCard(Modifier.fillMaxWidth(), padding = 20.dp) {
                Text("No broker connected", style = TlType.title, color = Tl.text)
                Spacer(Modifier.height(8.dp))
                Text("Connect Dhan so TradeLock can watch your trades and enforce your rules.", style = TlType.body, color = Tl.muted)
                Spacer(Modifier.height(16.dp))
                PrimaryButton("Connect a broker") { onOpenWeb("brokers?web=1") }
            }
            return@Column
        }

        // ---- the account ----
        TlCard(Modifier.fillMaxWidth(), padding = 20.dp) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(56.dp).clip(RoundedCornerShape(16.dp)).background(Color.White), contentAlignment = Alignment.Center) {
                    Text((a.str("label") ?: "?").take(1), color = Color(0xFF0E8F6E), fontWeight = FontWeight.Black, fontSize = 26.sp)
                }
                Spacer(Modifier.width(14.dp))
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(a.str("label") ?: "Broker", style = TlType.title, color = Tl.text)
                        Spacer(Modifier.width(10.dp))
                        Text(a.str("clientId") ?: "", style = TlType.numSm.copy(fontSize = 13.sp), color = Tl.muted)
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Dot(tint, 7.dp); Spacer(Modifier.width(6.dp))
                        Text((status ?: "unknown").uppercase(), style = TlType.eyebrow, color = tint)
                    }
                }
            }
            Spacer(Modifier.height(14.dp))
            Fact("Last sync", a.long("lastSyncAt")?.let { ago(it) } ?: "—")
            Fact("Token valid until", a.long("tokenExpiresAt")?.let { WHEN.format(Instant.ofEpochMilli(it)) } ?: "—")
            a.str("lastError")?.takeIf { it.isNotBlank() }?.let { Spacer(Modifier.height(6.dp)); Text(it, style = TlType.small, color = Tl.amber) }
            Spacer(Modifier.height(16.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(
                    Modifier.weight(1f).height(50.dp).tactile({
                        if (syncing) return@tactile
                        syncing = true
                        scope.launch {
                            try { Api.post("/brokers/${a.str("id")}/sync"); load(); vm.reloadDash(); vm.toast("Refreshed from ${a.str("label")}.") }
                            catch (e: ApiError) { vm.toast(e.message, Toast.Tone.Error) }
                            syncing = false
                        }
                    }).clip(RoundedCornerShape(16.dp)).background(Tl.surfaceHi),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center,
                ) {
                    if (syncing) CircularProgressIndicator(Modifier.size(18.dp), color = Tl.mint, strokeWidth = 2.dp)
                    else Icon(Icons.Rounded.Sync, null, tint = Tl.mint, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp)); Text("Sync now", style = TlType.label, color = Tl.mint)
                }
                if (a.str("broker") != "paper" && a.str("broker") != "mock") GhostButton("New token", Modifier.weight(1f)) { reconnect = true }
            }
        }

        // ---- what TradeLock can do on it ----
        Spacer(Modifier.height(16.dp))
        Eyebrow("On this account", Modifier.padding(start = 4.dp, bottom = 10.dp))
        TlCard(Modifier.fillMaxWidth(), padding = 8.dp) {
            Check("Positions and orders", "Read every 2 seconds while the market is open", ok)
            Check("Automated square-off", if (perms?.bool("ordersAllowed") == false) "${a.str("label")} rejects orders from this server: add ${perms.str("serverIp") ?: "the server IP"} as your static IP." else "Exits and the kill switch can run", perms?.bool("ordersAllowed") != false)
            Check("Kill switch", if (a.obj("killSwitch")?.bool("active") == true) "On: account locked today" else "Available, off", true)
        }
        Spacer(Modifier.height(16.dp))
        GhostButton("Static IP, other brokers and more", Modifier.fillMaxWidth()) { onOpenWeb("brokers?web=1") }
    }

    if (reconnect) {
        var token by remember { mutableStateOf("") }
        var busy by remember { mutableStateOf(false) }
        var err by remember { mutableStateOf<String?>(null) }
        TlSheet({ reconnect = false }) {
            Text("New ${a?.str("label") ?: ""} access token", style = TlType.title.copy(fontSize = 22.sp), color = Tl.text)
            Spacer(Modifier.height(8.dp))
            Text("Generate it in ${a?.str("label") ?: "your broker"} (web: Profile → Access DhanHQ APIs) and paste it here.", style = TlType.body, color = Tl.muted)
            Spacer(Modifier.height(14.dp))
            OutlinedTextField(token, { token = it.trim() }, label = { Text("Access token") }, singleLine = true, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(14.dp),
                colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = Tl.mint, unfocusedBorderColor = Tl.lineHi, focusedLabelColor = Tl.mint, cursorColor = Tl.mint, focusedTextColor = Tl.text, unfocusedTextColor = Tl.text))
            err?.let { Spacer(Modifier.height(8.dp)); Text(it, style = TlType.small, color = Tl.red) }
            Spacer(Modifier.height(16.dp))
            PrimaryButton(if (busy) "Checking…" else "Save token") {
                if (busy || token.length < 20) { err = "Paste the full access token."; return@PrimaryButton }
                busy = true
                scope.launch {
                    try { Api.post("/brokers/${a?.str("id")}/reconnect", buildJsonObject { put("accessToken", token) }); reconnect = false; load(); vm.reloadDash(); vm.toast("${a?.str("label")} reconnected.") }
                    catch (e: ApiError) { err = e.message }
                    busy = false
                }
            }
        }
    }
}

@Composable
private fun Fact(k: String, v: String) = Row(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
    Text(k, style = TlType.body, color = Tl.muted, modifier = Modifier.weight(1f)); Text(v, style = TlType.num.copy(fontSize = 14.sp), color = Tl.text)
}

@Composable
private fun Check(title: String, detail: String, ok: Boolean) = Row(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
    Icon(if (ok) Icons.Rounded.CheckCircle else Icons.Rounded.ErrorOutline, null, tint = if (ok) Tl.mint else Tl.amber, modifier = Modifier.size(22.dp))
    Spacer(Modifier.width(12.dp))
    Column(Modifier.weight(1f)) {
        Text(title, style = TlType.label, color = Tl.text)
        Text(detail, style = TlType.small, color = Tl.muted)
    }
}
