package com.nexlogic.tradelock.ui.screens

import com.nexlogic.tradelock.ui.components.ambient
import androidx.compose.foundation.border
import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.Computer
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.QrCodeScanner
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
import androidx.compose.ui.draw.scale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import com.nexlogic.tradelock.data.Api
import com.nexlogic.tradelock.data.ApiError
import com.nexlogic.tradelock.data.AppViewModel
import com.nexlogic.tradelock.data.long
import com.nexlogic.tradelock.data.str
import com.nexlogic.tradelock.ui.components.HoldToConfirm
import com.nexlogic.tradelock.ui.components.TlCard
import com.nexlogic.tradelock.ui.components.tactile
import com.nexlogic.tradelock.ui.theme.Tl
import com.nexlogic.tradelock.ui.theme.TlType
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlin.coroutines.resume

private sealed interface Qr {
    data object Scanning : Qr
    data class Confirm(val code: String, val browser: String, val ip: String, val at: Long?) : Qr
    data object Working : Qr
    data class Done(val browser: String) : Qr
    data class Failed(val message: String) : Qr
}
private val HM = DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.of("Asia/Kolkata"))

/** Sign in on the web: scan the QR on the login page, see which browser asks, approve with a hold. */
@Composable
fun QrLoginScreen(vm: AppViewModel, onBack: () -> Unit) {
    BackHandler { onBack() }
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var state by remember { mutableStateOf<Qr>(Qr.Scanning) }

    /** Google's scanner screen; null when closed without a code. */
    suspend fun scan(): String? = suspendCancellableCoroutine { cont ->
        val scanner = GmsBarcodeScanning.getClient(ctx, GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build())
        scanner.startScan()
            .addOnSuccessListener { cont.resume(it.rawValue) }
            .addOnCanceledListener { cont.resume(null) }
            .addOnFailureListener { cont.resume(null) }
    }
    fun start() {
        state = Qr.Scanning
        scope.launch {
            val raw = scan() ?: run { onBack(); return@launch }
            if (!raw.contains("/qr/")) { state = Qr.Failed("That isn't a TradeLock sign-in code. Open tradelock.in/login on your computer and scan the code there."); return@launch }
            state = Qr.Working
            state = try {
                val r = Api.post("/auth/qr/scan", buildJsonObject { put("code", raw) })
                Qr.Confirm(r.str("code") ?: "", r.str("browser") ?: "A browser", r.str("ip") ?: "", r.long("startedAt"))
            } catch (e: ApiError) { Qr.Failed(e.message) }
        }
    }
    fun answer(code: String, approve: Boolean) {
        state = Qr.Working
        scope.launch {
            state = try {
                val r = Api.post("/auth/qr/approve", buildJsonObject { put("code", code); put("approve", approve) })
                if (approve) Qr.Done(r.str("browser") ?: "your computer") else { onBack(); return@launch }
            } catch (e: ApiError) { Qr.Failed(e.message) }
        }
    }
    LaunchedEffect(Unit) { start() }

    Column(Modifier.fillMaxSize().ambient().statusBarsPadding().navigationBarsPadding().padding(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(44.dp).tactile(onBack).clip(RoundedCornerShape(14.dp)).background(Tl.glass).border(1.dp, Tl.edgeOff, RoundedCornerShape(14.dp)), contentAlignment = Alignment.Center) {
                Icon(Icons.AutoMirrored.Rounded.ArrowBack, null, tint = Tl.text)
            }
            Spacer(Modifier.width(12.dp))
            Text("Sign in on the web", fontSize = 24.sp, fontWeight = FontWeight.ExtraBold, color = Tl.text)
        }
        Spacer(Modifier.weight(1f))
        when (val s = state) {
            Qr.Scanning, Qr.Working -> Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                CircularProgressIndicator(color = Tl.mint)
                Spacer(Modifier.height(16.dp))
                Text(if (s == Qr.Scanning) "Opening the scanner…" else "One moment…", style = TlType.body, color = Tl.muted)
            }
            is Qr.Confirm -> TlCard(Modifier.fillMaxWidth(), padding = 22.dp) {
                Box(Modifier.size(60.dp).clip(RoundedCornerShape(18.dp)).background(Tl.mint.copy(alpha = 0.14f)), contentAlignment = Alignment.Center) {
                    Icon(Icons.Rounded.Computer, null, tint = Tl.mint, modifier = Modifier.size(30.dp))
                }
                Spacer(Modifier.height(16.dp))
                Text("Sign in on ${s.browser}?", style = TlType.title.copy(fontSize = 22.sp), color = Tl.text)
                Spacer(Modifier.height(8.dp))
                Text("Asked " + (s.at?.let { "at ${HM.format(Instant.ofEpochMilli(it))} " } ?: "") + (if (s.ip.isNotBlank()) "from ${s.ip}" else ""), style = TlType.small, color = Tl.muted)
                Spacer(Modifier.height(10.dp))
                Text("Only approve if it's your computer and you just opened the TradeLock sign-in page. It gets full access to your account.", style = TlType.body, color = Tl.muted)
                Spacer(Modifier.height(22.dp))
                HoldToConfirm("Hold to sign in", "Keep holding…", Tl.mint, Modifier.fillMaxWidth()) { answer(s.code, true) }
                Spacer(Modifier.height(10.dp))
                GhostButton("Not me · decline", Modifier.fillMaxWidth()) { answer(s.code, false) }
            }
            is Qr.Done -> {
                val pop by animateFloatAsState(1f, spring(dampingRatio = 0.45f, stiffness = Spring.StiffnessLow), label = "pop")
                Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                    Box(Modifier.size(96.dp).scale(pop).clip(CircleShape).background(Tl.mint.copy(alpha = 0.15f)), contentAlignment = Alignment.Center) {
                        Icon(Icons.Rounded.CheckCircle, null, tint = Tl.mint, modifier = Modifier.size(56.dp))
                    }
                    Spacer(Modifier.height(18.dp))
                    Text("Signed in on ${s.browser}", style = TlType.title, color = Tl.text, textAlign = TextAlign.Center)
                    Spacer(Modifier.height(6.dp))
                    Text("The page on your computer opens your dashboard in a moment.", style = TlType.body, color = Tl.muted, textAlign = TextAlign.Center)
                    Spacer(Modifier.height(24.dp))
                    PrimaryButton("Done") { onBack() }
                }
            }
            is Qr.Failed -> Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                Icon(Icons.Rounded.ErrorOutline, null, tint = Tl.amber, modifier = Modifier.size(52.dp))
                Spacer(Modifier.height(14.dp))
                Text(s.message, style = TlType.body, color = Tl.text, textAlign = TextAlign.Center)
                Spacer(Modifier.height(22.dp))
                Row(Modifier.fillMaxWidth().height(54.dp).tactile({ start() }).clip(RoundedCornerShape(16.dp)).background(Tl.mintBrush),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center) {
                    Icon(Icons.Rounded.QrCodeScanner, null, tint = androidx.compose.ui.graphics.Color(0xFF04261F)); Spacer(Modifier.width(8.dp))
                    Text("Scan again", color = androidx.compose.ui.graphics.Color(0xFF04261F), fontWeight = FontWeight.Bold)
                }
            }
        }
        Spacer(Modifier.weight(1.3f))
    }
}
