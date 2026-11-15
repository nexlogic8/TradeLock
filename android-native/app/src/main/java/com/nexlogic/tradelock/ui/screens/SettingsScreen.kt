package com.nexlogic.tradelock.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.nexlogic.tradelock.BuildConfig
import com.nexlogic.tradelock.data.Api
import com.nexlogic.tradelock.data.ApiError
import com.nexlogic.tradelock.data.AppViewModel
import com.nexlogic.tradelock.data.Toast
import com.nexlogic.tradelock.data.bool
import com.nexlogic.tradelock.data.obj
import com.nexlogic.tradelock.data.str
import com.nexlogic.tradelock.ui.components.Eyebrow
import com.nexlogic.tradelock.ui.components.PillSwitch
import com.nexlogic.tradelock.ui.components.TlCard
import com.nexlogic.tradelock.ui.components.tactile
import com.nexlogic.tradelock.ui.theme.Tl
import com.nexlogic.tradelock.ui.theme.TlType
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private val PREFS = listOf(
    Triple("push", "Notifications in the app", "Show risk, broker and billing messages as they happen"),
    Triple("brokerAlerts", "Broker warnings", "Tell me when the broker connection has a problem"),
    Triple("emergencyConfirm", "Confirm the kill switch", "Ask before closing everything and locking the account"),
)

/** Settings: name and mobile, preferences, the trade alarm, links to the rest, the app version. */
@Composable
fun SettingsScreen(vm: AppViewModel, onBack: () -> Unit, onOpen: (String) -> Unit) {
    BackHandler { onBack() }
    var user by remember { mutableStateOf<JsonObject?>(null) }
    var name by remember { mutableStateOf("") }
    var phone by remember { mutableStateOf("") }
    var saving by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) {
        runCatching { Api.get("/settings").obj("user") }.getOrNull()?.let { u -> user = u; name = u.str("name") ?: ""; phone = (u.str("phone") ?: "").removePrefix("+91") }
    }
    fun patch(body: JsonObject, ok: String? = null) = scope.launch {
        try { user = Api.patch("/settings", body).obj("user"); ok?.let { vm.toast(it) } } catch (e: ApiError) { vm.toast(e.message, Toast.Tone.Error) }
    }

    Column(Modifier.fillMaxSize().background(Tl.bg).statusBarsPadding().navigationBarsPadding().verticalScroll(rememberScrollState()).padding(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(44.dp).tactile(onBack).clip(RoundedCornerShape(14.dp)).background(Tl.surface), contentAlignment = Alignment.Center) {
                Icon(Icons.AutoMirrored.Rounded.ArrowBack, null, tint = Tl.text)
            }
            Spacer(Modifier.width(12.dp))
            Text("Settings", fontSize = 26.sp, fontWeight = FontWeight.ExtraBold, color = Tl.text)
        }
        Spacer(Modifier.height(16.dp))
        Eyebrow("Profile", Modifier.padding(start = 4.dp, bottom = 10.dp))
        TlCard(Modifier.fillMaxWidth(), padding = 18.dp) {
            Text(user?.str("email") ?: "", style = TlType.body, color = Tl.muted)
            Spacer(Modifier.height(10.dp))
            SField("Display name", name) { name = it }
            SField("Mobile (10 digits)", phone, KeyboardType.Phone) { phone = it.filter(Char::isDigit).take(10) }
            Spacer(Modifier.height(12.dp))
            PrimaryButton(if (saving) "Saving…" else "Save") {
                if (saving) return@PrimaryButton
                saving = true
                scope.launch {
                    try { user = Api.patch("/settings", buildJsonObject { put("name", name.trim()); put("phone", phone) }).obj("user"); vm.toast("Saved.") }
                    catch (e: ApiError) { vm.toast(e.message, Toast.Tone.Error) }
                    saving = false
                }
            }
        }
        Spacer(Modifier.height(18.dp))
        Eyebrow("Preferences", Modifier.padding(start = 4.dp, bottom = 10.dp))
        TlCard(Modifier.fillMaxWidth(), padding = 6.dp) {
            PREFS.forEach { (k, title, detail) ->
                val on = user?.obj("prefs")?.bool(k) != false
                Row(Modifier.fillMaxWidth().tactile({ patch(buildJsonObject { put("prefs", buildJsonObject { put(k, !on) }) }) }).padding(horizontal = 12.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(title, style = TlType.label, color = Tl.text)
                        Text(detail, style = TlType.small, color = Tl.muted)
                    }
                    Spacer(Modifier.width(10.dp))
                    PillSwitch(on, Tl.mint)
                }
            }
        }
        Spacer(Modifier.height(18.dp))
        Eyebrow("More", Modifier.padding(start = 4.dp, bottom = 10.dp))
        TlCard(Modifier.fillMaxWidth(), padding = 6.dp) {
            Link("Trade alarm") { onOpen("alarm") }
            Link("Two-step sign-in and account") { onOpen("profile") }
            Link("Refer & earn") { onOpen("affiliate") }
        }
        Spacer(Modifier.height(18.dp))
        Text("TradeLock ${BuildConfig.VERSION_NAME} · native", style = TlType.small, color = Tl.dim, modifier = Modifier.padding(start = 4.dp))
    }
}

@Composable
private fun Link(label: String, onClick: () -> Unit) = Row(Modifier.fillMaxWidth().tactile(onClick).padding(horizontal = 12.dp, vertical = 16.dp), verticalAlignment = Alignment.CenterVertically) {
    Text(label, style = TlType.label, color = Tl.text, modifier = Modifier.weight(1f)); Icon(Icons.AutoMirrored.Rounded.KeyboardArrowRight, null, tint = Tl.dim)
}

@Composable
private fun SField(label: String, value: String, type: KeyboardType = KeyboardType.Text, onChange: (String) -> Unit) =
    OutlinedTextField(value, onChange, label = { Text(label) }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp), shape = RoundedCornerShape(14.dp),
        keyboardOptions = KeyboardOptions(keyboardType = type),
        colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = Tl.mint, unfocusedBorderColor = Tl.lineHi, focusedLabelColor = Tl.mint, cursorColor = Tl.mint, focusedTextColor = Tl.text, unfocusedTextColor = Tl.text))
