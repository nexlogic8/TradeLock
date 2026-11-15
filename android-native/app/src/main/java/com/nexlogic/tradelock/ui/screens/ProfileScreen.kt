package com.nexlogic.tradelock.ui.screens

import android.content.Intent
import android.net.Uri
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
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Shield
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
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.nexlogic.tradelock.data.Api
import com.nexlogic.tradelock.data.ApiError
import com.nexlogic.tradelock.data.AppViewModel
import com.nexlogic.tradelock.data.Toast
import com.nexlogic.tradelock.data.bool
import com.nexlogic.tradelock.data.obj
import com.nexlogic.tradelock.data.str
import com.nexlogic.tradelock.ui.components.Eyebrow
import com.nexlogic.tradelock.ui.components.TlCard
import com.nexlogic.tradelock.ui.components.tactile
import com.nexlogic.tradelock.ui.theme.Tl
import com.nexlogic.tradelock.ui.theme.TlType
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Profile: who you are, two-step sign-in (authenticator code), sign out, delete the account. */
@Composable
fun ProfileScreen(vm: AppViewModel, onBack: () -> Unit, onOpen: (String) -> Unit) {
    BackHandler { onBack() }
    var user by remember { mutableStateOf<JsonObject?>(null) }
    var setup by remember { mutableStateOf<JsonObject?>(null) }   // { secret, otpauth } while turning MFA on
    var code by remember { mutableStateOf("") }
    var err by remember { mutableStateOf<String?>(null) }
    var askOff by remember { mutableStateOf(false) }
    var askDelete by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    val clip = LocalClipboardManager.current
    LaunchedEffect(Unit) { runCatching { Api.get("/settings").obj("user") }.getOrNull()?.let { user = it } }
    val mfaOn = user?.bool("mfaEnabled") == true

    Column(Modifier.fillMaxSize().background(Tl.bg).statusBarsPadding().navigationBarsPadding().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(44.dp).tactile(onBack).clip(RoundedCornerShape(14.dp)).background(Tl.surface), contentAlignment = Alignment.Center) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, null, tint = Tl.text) }
            Spacer(Modifier.width(12.dp))
            Text("Profile", fontSize = 26.sp, fontWeight = FontWeight.ExtraBold, color = Tl.text)
        }
        TlCard(Modifier.fillMaxWidth(), padding = 20.dp) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(64.dp).clip(CircleShape).background(Tl.mintBrush), contentAlignment = Alignment.Center) {
                    Text(user?.str("initials") ?: "", fontWeight = FontWeight.Black, fontSize = 22.sp, color = androidx.compose.ui.graphics.Color(0xFF04261F))
                    user?.str("avatar")?.let { AsyncImage(it, null, Modifier.size(64.dp).clip(CircleShape)) }
                }
                Spacer(Modifier.width(16.dp))
                Column(Modifier.weight(1f)) {
                    Text(user?.str("name") ?: "", style = TlType.title, color = Tl.text)
                    Text(user?.str("email") ?: "", style = TlType.body, color = Tl.muted)
                    user?.str("phone")?.let { Text(it, style = TlType.small, color = Tl.dim) }
                }
            }
            Spacer(Modifier.height(14.dp))
            GhostButton("Edit name and mobile", Modifier.fillMaxWidth()) { onOpen("settings") }
        }

        // ---- two-step sign-in ----
        Eyebrow("Security", Modifier.padding(start = 4.dp))
        TlCard(Modifier.fillMaxWidth(), padding = 20.dp) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Rounded.Shield, null, tint = if (mfaOn) Tl.mint else Tl.amber, modifier = Modifier.size(26.dp))
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text("Two-step sign-in", style = TlType.label.copy(fontSize = 16.sp), color = Tl.text)
                    Text(if (mfaOn) "On: a code from your authenticator app is needed to sign in and to use the kill switch." else "Recommended: adds a 6-digit code from an authenticator app at sign-in.",
                        style = TlType.small.copy(fontSize = 13.sp), color = Tl.muted)
                }
            }
            Spacer(Modifier.height(14.dp))
            val s = setup
            when {
                mfaOn -> GhostButton("Turn off", Modifier.fillMaxWidth()) { askOff = true; code = ""; err = null }
                s == null -> PrimaryButton("Set up") {
                    scope.launch { try { setup = Api.post("/auth/mfa/setup"); code = ""; err = null } catch (e: ApiError) { vm.toast(e.message, Toast.Tone.Error) } }
                }
                else -> {
                    Text("Add this key to Google Authenticator or any TOTP app, then enter the code it shows.", style = TlType.small, color = Tl.muted)
                    Spacer(Modifier.height(10.dp))
                    Text((s.str("secret") ?: "").chunked(4).joinToString(" "), fontFamily = FontFamily.Monospace, fontSize = 17.sp, fontWeight = FontWeight.Bold, color = Tl.text,
                        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Tl.surfaceHi).border(1.dp, Tl.lineHi, RoundedCornerShape(12.dp)).padding(14.dp))
                    Spacer(Modifier.height(10.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        GhostButton("Open authenticator", Modifier.weight(1f)) {
                            runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(s.str("otpauth")))) }.onFailure { vm.toast("No authenticator app found: copy the key instead.", Toast.Tone.Warn) }
                        }
                        GhostButton("Copy key", Modifier.weight(1f)) { clip.setText(AnnotatedString(s.str("secret") ?: "")); vm.toast("Key copied.") }
                    }
                    CodeField(code) { code = it }
                    err?.let { Text(it, style = TlType.small, color = Tl.red) }
                    Spacer(Modifier.height(10.dp))
                    PrimaryButton("Turn on") {
                        scope.launch {
                            try { user = Api.post("/auth/mfa/enable", buildJsonObject { put("code", code) }).obj("user"); setup = null; vm.toast("Two-step sign-in is on.") }
                            catch (e: ApiError) { err = e.message }
                        }
                    }
                }
            }
        }

        Eyebrow("Account", Modifier.padding(start = 4.dp))
        TlCard(Modifier.fillMaxWidth(), padding = 20.dp) {
            GhostButton("Sign out", Modifier.fillMaxWidth()) { vm.logout() }
            Spacer(Modifier.height(10.dp))
            Text("Delete account", style = TlType.label, color = Tl.red, modifier = Modifier.fillMaxWidth().tactile({ askDelete = true; code = ""; err = null }).padding(vertical = 10.dp))
        }
    }

    if (askOff) TlSheet({ askOff = false }) {
        Text("Turn off two-step sign-in?", style = TlType.title.copy(fontSize = 22.sp), color = Tl.text)
        Spacer(Modifier.height(8.dp))
        Text("Enter the current code from your authenticator app.", style = TlType.body, color = Tl.muted)
        CodeField(code) { code = it }
        err?.let { Text(it, style = TlType.small, color = Tl.red) }
        Spacer(Modifier.height(12.dp))
        DangerButton("Turn off") {
            scope.launch {
                try { user = Api.post("/auth/mfa/disable", buildJsonObject { put("code", code) }).obj("user"); askOff = false; vm.toast("Two-step sign-in is off.") }
                catch (e: ApiError) { err = e.message }
            }
        }
    }
    if (askDelete) {
        var confirm by remember { mutableStateOf("") }
        TlSheet({ askDelete = false }) {
            Text("Delete your TradeLock account?", style = TlType.title.copy(fontSize = 22.sp), color = Tl.red)
            Spacer(Modifier.height(10.dp))
            listOf("Your rules, journal, history and wallet records are erased.", "Your broker account is disconnected; your money stays with your broker.", "This can't be undone.").forEach {
                Text("•  $it", style = TlType.body, color = Tl.muted, modifier = Modifier.padding(vertical = 3.dp))
            }
            Spacer(Modifier.height(10.dp))
            OutlinedTextField(confirm, { confirm = it }, label = { Text("Type DELETE") }, singleLine = true, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(14.dp), colors = fieldColors())
            if (mfaOn) CodeField(code) { code = it }
            err?.let { Text(it, style = TlType.small, color = Tl.red) }
            Spacer(Modifier.height(12.dp))
            DangerButton("Delete my account") {
                if (confirm.trim().uppercase() != "DELETE") { err = "Type DELETE to confirm."; return@DangerButton }
                scope.launch {
                    try { Api.post("/account/delete", buildJsonObject { put("confirm", confirm); put("code", code) }); askDelete = false; vm.toast("Your TradeLock account has been deleted."); vm.logout() }
                    catch (e: ApiError) { err = e.message }
                }
            }
        }
    }
}

@Composable
private fun fieldColors() = OutlinedTextFieldDefaults.colors(focusedBorderColor = Tl.mint, unfocusedBorderColor = Tl.lineHi, focusedLabelColor = Tl.mint, cursorColor = Tl.mint, focusedTextColor = Tl.text, unfocusedTextColor = Tl.text)

@Composable
private fun CodeField(value: String, onChange: (String) -> Unit) =
    OutlinedTextField(value, { onChange(it.filter(Char::isDigit).take(6)) }, label = { Text("6-digit code") }, singleLine = true,
        modifier = Modifier.fillMaxWidth().padding(top = 10.dp), shape = RoundedCornerShape(14.dp),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword), colors = fieldColors(),
        textStyle = TlType.num.copy(fontSize = 20.sp, letterSpacing = 6.sp, color = Tl.text))
