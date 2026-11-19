package com.nexlogic.tradelock.ui.screens

import androidx.compose.animation.AnimatedVisibility
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
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.activity.compose.LocalActivity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.nexlogic.tradelock.BuildConfig
import com.nexlogic.tradelock.data.AppViewModel
import com.nexlogic.tradelock.ui.components.tactile
import com.nexlogic.tradelock.ui.theme.Tl
import com.nexlogic.tradelock.ui.theme.TlType
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout

@Composable
fun LoginScreen(vm: AppViewModel) {
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var needCode by remember { mutableStateOf(false) }
    // Two-step sign-in after Google: only the code is asked for (the server keeps the pending sign-in).
    var googleCode by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val activity = LocalActivity.current

    fun signIn() {
        if (busy) return
        busy = true; error = null
        scope.launch {
            val r = if (googleCode) vm.googleMfa(code) else vm.login(email, password, if (needCode) code else null)
            busy = false
            when (r) {
                null -> Unit
                "MFA_REQUIRED" -> needCode = true
                else -> error = r
            }
        }
    }

    fun google() {
        if (busy) return
        busy = true; error = null
        scope.launch {
            try {
                // "Sign in with Google" opens Google's own account sheet. (The generic Android credential picker
                // fails to start on some Samsung phones and never returns.)
                val act = activity ?: error("Google sign-in needs the app window. Try again.")
                val option = GetSignInWithGoogleOption.Builder(BuildConfig.GOOGLE_WEB_CLIENT_ID).build()
                val res = withTimeout(45_000) {
                    CredentialManager.create(act).getCredential(act, GetCredentialRequest.Builder().addCredentialOption(option).build())
                }
                val token = GoogleIdTokenCredential.createFrom(res.credential.data).idToken
                when (val r = vm.googleLogin(token)) {
                    "MFA_REQUIRED_GOOGLE" -> { googleCode = true; needCode = true; code = ""; error = null }
                    else -> error = r
                }
            } catch (e: Exception) {
                android.util.Log.w("TradeLockLogin", "Google sign-in failed", e)
                error = when (e) {
                    is androidx.credentials.exceptions.GetCredentialCancellationException -> null
                    is kotlinx.coroutines.TimeoutCancellationException -> "Google didn't answer. Try again."
                    else -> "Google sign-in failed: ${e.message ?: e.javaClass.simpleName}"
                }
            } finally { busy = false }
        }
    }

    Box(
        Modifier.fillMaxSize()
            .background(Brush.radialGradient(listOf(Color(0xFF0E3B33), Tl.bg), radius = 1400f, center = androidx.compose.ui.geometry.Offset(0f, 0f)))
    ) {
        Column(
            Modifier.fillMaxSize().statusBarsPadding().imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp),
        ) {
            Spacer(Modifier.height(72.dp))
            Box(
                Modifier.size(64.dp).shadow(24.dp, RoundedCornerShape(20.dp), spotColor = Tl.mint)
                    .clip(RoundedCornerShape(20.dp)).background(Tl.mintBrush),
                contentAlignment = Alignment.Center,
            ) { Icon(Icons.Rounded.Lock, null, tint = Color(0xFF04261F), modifier = Modifier.size(30.dp)) }
            Spacer(Modifier.height(28.dp))
            if (googleCode) {
                // Second step of a Google sign-in: only the code (the email and password don't apply here).
                Text("Two-step\nsign-in", color = Tl.text, fontSize = 40.sp, lineHeight = 44.sp, fontWeight = FontWeight.ExtraBold)
                Spacer(Modifier.height(12.dp))
                Text("You're signing in with Google. Enter the 6-digit code from your authenticator app.", style = TlType.body, color = Tl.muted)
                Spacer(Modifier.height(36.dp))
                Field("6-digit code", code, { code = it.filter(Char::isDigit).take(6); if (code.length == 6) signIn() }, KeyboardType.NumberPassword, done = true, big = true) { signIn() }
            } else {
                Text("Trade with\ndiscipline.", color = Tl.text, fontSize = 40.sp, lineHeight = 44.sp, fontWeight = FontWeight.ExtraBold)
                Spacer(Modifier.height(12.dp))
                Text("Your limits, enforced at your broker. Sign in to TradeLock.", style = TlType.body, color = Tl.muted)
                Spacer(Modifier.height(36.dp))
                Field("Email", email, { email = it }, KeyboardType.Email)
                Spacer(Modifier.height(12.dp))
                Field("Password", password, { password = it }, KeyboardType.Password, secret = true, done = !needCode) { signIn() }
                AnimatedVisibility(needCode) {
                    Column { Spacer(Modifier.height(12.dp)); Field("6-digit code", code, { code = it.filter(Char::isDigit).take(6) }, KeyboardType.NumberPassword, done = true) { signIn() } }
                }
            }
            error?.let { Spacer(Modifier.height(12.dp)); Text(it, style = TlType.small, color = Tl.red) }
            Spacer(Modifier.height(24.dp))

            Box(
                Modifier.fillMaxWidth().height(56.dp).tactile({ signIn() }, enabled = !busy)
                    .shadow(18.dp, RoundedCornerShape(16.dp), spotColor = Tl.mint).clip(RoundedCornerShape(16.dp)).background(Tl.mintBrush),
                contentAlignment = Alignment.Center,
            ) {
                if (busy) CircularProgressIndicator(Modifier.size(22.dp), color = Color(0xFF04261F), strokeWidth = 2.5.dp)
                else Text(if (needCode) "Verify and sign in" else "Sign in", color = Color(0xFF04261F), fontWeight = FontWeight.Bold, fontSize = 16.sp)
            }
            Spacer(Modifier.height(12.dp))
            if (googleCode) {
                Text("← Use a different sign-in", style = TlType.label, color = Tl.mint, modifier = Modifier.fillMaxWidth()
                    .tactile({ googleCode = false; needCode = false; code = ""; error = null }).padding(vertical = 14.dp),
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center)
            } else Row(
                Modifier.fillMaxWidth().height(56.dp).tactile({ google() }, enabled = !busy)
                    .clip(RoundedCornerShape(16.dp)).background(Tl.surface).border(1.dp, Tl.lineHi, RoundedCornerShape(16.dp)),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center,
            ) {
                Text("G", color = Tl.text, fontWeight = FontWeight.Black, fontSize = 18.sp)
                Spacer(Modifier.size(10.dp))
                Text("Continue with Google", style = TlType.label, color = Tl.text)
            }
            Spacer(Modifier.height(40.dp))
        }
    }
}

@Composable
private fun Field(label: String, value: String, onChange: (String) -> Unit, type: KeyboardType, secret: Boolean = false, done: Boolean = false, big: Boolean = false, onDone: () -> Unit = {}) {
    OutlinedTextField(
        value = value, onValueChange = onChange, label = { Text(label) }, singleLine = true,
        textStyle = if (big) TlType.num.copy(fontSize = 26.sp, letterSpacing = 10.sp, color = Tl.text) else androidx.compose.ui.text.TextStyle.Default.copy(color = Tl.text),
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        visualTransformation = if (secret) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
        keyboardOptions = KeyboardOptions(keyboardType = type, imeAction = if (done) ImeAction.Done else ImeAction.Next),
        keyboardActions = androidx.compose.foundation.text.KeyboardActions(onDone = { onDone() }),
        colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = Tl.mint, unfocusedBorderColor = Tl.lineHi, focusedLabelColor = Tl.mint, unfocusedLabelColor = Tl.muted,
            focusedContainerColor = Tl.surface, unfocusedContainerColor = Tl.surface, cursorColor = Tl.mint,
            focusedTextColor = Tl.text, unfocusedTextColor = Tl.text,
        ),
    )
}
