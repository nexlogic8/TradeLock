package com.nexlogic.tradelock.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.AccountBalanceWallet
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.LocalOffer
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.Verified
import androidx.compose.material.icons.rounded.WorkspacePremium
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
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.nexlogic.tradelock.data.Api
import com.nexlogic.tradelock.data.ApiError
import com.nexlogic.tradelock.data.AppViewModel
import com.nexlogic.tradelock.data.Toast
import com.nexlogic.tradelock.data.bool
import com.nexlogic.tradelock.data.long
import com.nexlogic.tradelock.data.num
import com.nexlogic.tradelock.data.obj
import com.nexlogic.tradelock.data.str
import com.nexlogic.tradelock.ui.components.IconBadge
import com.nexlogic.tradelock.ui.components.LivePulse
import com.nexlogic.tradelock.ui.components.PageHeader
import com.nexlogic.tradelock.ui.components.PillSwitch
import com.nexlogic.tradelock.ui.components.RollingText
import com.nexlogic.tradelock.ui.components.TlCard
import com.nexlogic.tradelock.ui.components.ambient
import com.nexlogic.tradelock.ui.components.tactile
import com.nexlogic.tradelock.ui.paise
import com.nexlogic.tradelock.ui.theme.Tl
import com.nexlogic.tradelock.ui.theme.TlType
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val SUB_DAY = DateTimeFormatter.ofPattern("d MMM yyyy").withZone(ZoneId.of("Asia/Kolkata"))
private val FEATURES = listOf("Dhan monitoring", "Risk rules", "Auto exits & kill switch", "Alerts & audit history", "Analytics", "AI Algo Trading")
private enum class CouponState { Closed, Editing, Applied }

/**
 * Subscription (as tradelock.in/billing): the plan, its validity, a coupon code, the wallet, and checkout through
 * Razorpay for whatever the wallet does not cover. Prices are in paise from the server (GET /billing, POST /billing/quote).
 */
@Composable
fun SubscriptionScreen(vm: AppViewModel, onBack: () -> Unit, onOpen: (String) -> Unit) {
    BackHandler { onBack() }
    var billing by remember { mutableStateOf<JsonObject?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var quote by remember { mutableStateOf<JsonObject?>(null) }   // the price with the applied coupon
    var useWallet by remember { mutableStateOf<Boolean?>(null) }
    var paying by remember { mutableStateOf(false) }
    var askCancel by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val ctx = androidx.compose.ui.platform.LocalContext.current

    suspend fun load() { try { billing = Api.get("/billing"); error = null; vm.loadWallet() } catch (e: ApiError) { error = e.message } }
    LaunchedEffect(Unit) { load() }
    LaunchedEffect(Unit) { com.nexlogic.tradelock.data.RazorpayPay.updates.collect { load() } }

    val sub = billing?.obj("subscription")
    val wallet = billing?.obj("wallet")
    val inWallet = wallet?.long("total") ?: 0L
    val months = quote?.long("months")?.toInt() ?: 1
    val total = quote?.long("total") ?: billing?.long("total") ?: 0L
    val use = useWallet ?: (inWallet > 0)
    val fromWallet = if (use) minOf(inWallet, total) else 0L
    val due = total - fromWallet
    val active = sub?.bool("active") == true
    val paid = sub?.str("status") == "active"
    val trial = sub?.str("status") == "trial"
    val span = "$months month${if (months == 1) "" else "s"}"

    fun checkout() {
        if (paying) return
        paying = true
        scope.launch {
            try {
                val res = Api.post("/billing/checkout", buildJsonObject {
                    put("useWallet", use); quote?.obj("coupon")?.str("code")?.let { put("coupon", it) }
                })
                if (res.bool("paid") != true && res.str("provider") == "razorpay") {
                    val activity = activityOf(ctx)
                    if (activity == null) { vm.toast("Could not open the payment screen.", Toast.Tone.Error); paying = false; return@launch }
                    com.nexlogic.tradelock.data.RazorpayPay.pay(activity, res, "${sub?.str("plan") ?: "TradeLock"} · $span").getOrElse {
                        val received = it.message?.startsWith("Payment received") == true
                        vm.toast(it.message ?: "Payment failed.", if (received) Toast.Tone.Ok else Toast.Tone.Error)
                        paying = false; load(); return@launch
                    }
                }
                vm.toast(if (total == 0L) "Activated: $span of ${sub?.str("plan") ?: "TradeLock"}." else "Paid. Your subscription is active.")
                quote = null
            } catch (e: ApiError) { vm.toast(e.message, Toast.Tone.Error) }
            paying = false
            load()
        }
    }

    LazyColumn(
        Modifier.fillMaxSize().ambient().statusBarsPadding().navigationBarsPadding().imePadding(),
        contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        item { PageHeader("Subscription", "Your TradeLock plan and payments", onBack) }
        if (billing == null || sub == null) {
            item { Box(Modifier.fillMaxWidth().padding(48.dp), contentAlignment = Alignment.Center) { if (error != null) Text(error!!, color = Tl.red, style = TlType.body) else CircularProgressIndicator(color = Tl.mint) } }
            return@LazyColumn
        }

        // ---- the plan ----
        item { PlanCard(sub, active, paid, trial) }

        // ---- checkout: coupon, wallet, breakdown, pay ----
        item {
            TlCard(Modifier.fillMaxWidth().animateContentSize(), padding = 20.dp, accent = Tl.mint) {
                Text(when { paid && active -> "Extend by ${if (months == 1) "a month" else span}"; trial || active -> "Subscribe now"; else -> "Renew now" },
                    style = TlType.title.copy(fontSize = 19.sp), color = Tl.text)
                Spacer(Modifier.height(14.dp))
                CouponBlock(quote, onApplied = { quote = it }, onRemove = { quote = null; vm.toast("Coupon removed.") })
                Spacer(Modifier.height(14.dp))
                // Use the wallet first
                Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Tl.surfaceHi.copy(alpha = 0.6f))
                    .tactile({ if (inWallet > 0) useWallet = !use }, enabled = inWallet > 0).padding(horizontal = 14.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    IconBadge(Icons.Rounded.AccountBalanceWallet, Tl.ice, 36.dp)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text("Use wallet balance", style = TlType.label, color = if (inWallet > 0) Tl.text else Tl.dim)
                        Text("${paise(inWallet)} available", style = TlType.small, color = Tl.muted)
                    }
                    PillSwitch(use && inWallet > 0, Tl.ice, compact = true)
                }
                Spacer(Modifier.height(16.dp))
                // Breakdown
                val q = quote
                if (q?.obj("coupon") != null) {
                    Line("Plan · $span", paise(q.long("base")))
                    Line("Coupon ${q.obj("coupon")?.str("code")}", "−${paise(q.long("discount"))}", Tl.green)
                    Line("GST (${Math.round((sub.num("gstRate") ?: 0.18) * 100)}%)", paise(q.long("gst")))
                }
                Line("Total", paise(total))
                AnimatedVisibility(fromWallet > 0, enter = fadeIn() + expandVertically(), exit = fadeOut() + shrinkVertically()) { Line("From wallet", "−${paise(fromWallet)}", Tl.green) }
                Box(Modifier.fillMaxWidth().padding(vertical = 10.dp).height(1.dp).drawBehind {
                    drawLine(Tl.lineHi, Offset(0f, 0f), Offset(size.width, 0f), 2f, pathEffect = PathEffect.dashPathEffect(floatArrayOf(8f, 8f)))
                })
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Pay now", style = TlType.label.copy(fontSize = 16.sp), color = Tl.text, modifier = Modifier.weight(1f))
                    RollingText(paise(due), TlType.big.copy(fontSize = 26.sp), if (due == 0L) Tl.green else Tl.text)
                }
                Spacer(Modifier.height(16.dp))
                PayButton(
                    when { total == 0L -> "Activate $span free"; due == 0L -> "Pay ${paise(total)} from wallet"; else -> "Pay ${paise(due)} securely" },
                    busy = paying, onClick = ::checkout,
                )
                if (due > 0) Text("UPI · Cards · Netbanking · Wallets, via Razorpay", style = TlType.small, color = Tl.dim, modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                val note = when {
                    paid && active -> "Adds ${months * 30} days after ${sub.long("currentPeriodEnd")?.let { SUB_DAY.format(Instant.ofEpochMilli(it)) } ?: "your current period"}."
                    trial && active -> "Your remaining trial days are kept: the paid ${if (months == 1) "month starts" else "months start"} after the trial."
                    else -> null
                }
                note?.let { Text(it, style = TlType.small, color = Tl.muted, modifier = Modifier.padding(top = 10.dp)) }
            }
        }

        // ---- billing summary ----
        item {
            val price = sub.num("priceInr") ?: 0.0; val gst = price * (sub.num("gstRate") ?: 0.18)
            TlCard(Modifier.fillMaxWidth(), padding = 18.dp) {
                Text("Billing summary", style = TlType.label.copy(fontSize = 16.sp), color = Tl.text)
                Spacer(Modifier.height(10.dp))
                Line("Monthly plan", com.nexlogic.tradelock.ui.inr(price, dp = 2))
                Line("GST (${Math.round((sub.num("gstRate") ?: 0.18) * 100)}%)", com.nexlogic.tradelock.ui.inr(gst, dp = 2))
                Line("Total per month", com.nexlogic.tradelock.ui.inr(price + gst, dp = 2), Tl.text, bold = true)
                Line("Wallet balance", paise(inWallet))
                Spacer(Modifier.height(8.dp))
                Text("No auto-debit: you pay each month yourself. GST is included at checkout and Razorpay emails your receipt.", style = TlType.small, color = Tl.dim)
                Spacer(Modifier.height(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    GhostButton("Open wallet", Modifier.weight(1f)) { onOpen("wallet") }
                    if (paid && active) {
                        if (sub.bool("cancelAtPeriodEnd") == true) GhostButton("Resume renewal", Modifier.weight(1f)) {
                            scope.launch { runCatching { Api.post("/billing/resume") }.onSuccess { vm.toast("Renewal is on.") }; load() }
                        } else GhostButton("Cancel renewal", Modifier.weight(1f)) { askCancel = true }
                    }
                }
            }
        }
    }

    if (askCancel) ConfirmSheet("Cancel renewal?",
        listOf("Your plan stays active until the end of this period.", "After that, Protection and Algo Trading stop.", "You can turn renewal back on any time before then."),
        "Cancel renewal", "Keep it", danger = true, onDismiss = { askCancel = false }) {
        askCancel = false
        scope.launch { runCatching { Api.post("/billing/cancel") }.onSuccess { vm.toast("Renewal cancelled.") }; load() }
    }
}

/** The plan: name and status, the price, validity with a days-left meter, what is included. A glowing edge while active. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PlanCard(sub: JsonObject, active: Boolean, paid: Boolean, trial: Boolean) {
    val now = System.currentTimeMillis()
    val end = if (paid) sub.long("currentPeriodEnd") else sub.long("trialEndsAt")
    val daysLeft = end?.let { maxOf(0L, Math.ceil((it - now) / 86_400_000.0).toLong()) } ?: 0L
    val left = if (!active) 0f else (daysLeft / (if (paid) 30f else 7f)).coerceIn(0.03f, 1f)
    val meter by animateFloatAsState(left, tween(900), label = "meter")
    val tint = when { !active -> Tl.red; paid -> Tl.mint; else -> Tl.ice }
    val spin by rememberInfiniteTransition(label = "edge").animateFloat(0f, 360f, infiniteRepeatable(tween(7000, easing = LinearEasing)), label = "spin")
    val shape = RoundedCornerShape(26.dp)
    Box(Modifier.fillMaxWidth().clip(shape)) {
        // A slowly turning aurora behind a 1.5 dp gap: the card's edge glows while the plan is active.
        // Drawn as a turning circle larger than the card, so every corner stays covered at any angle.
        if (active) Box(Modifier.matchParentSize().drawBehind {
            rotate(spin) { drawCircle(Brush.sweepGradient(listOf(Tl.mint, Tl.ice, Color(0xFFB794FF), Tl.amber, Tl.mint)), radius = size.width + size.height) }
        })
        else Box(Modifier.matchParentSize().background(Tl.lineHi))
        Column(
            Modifier.padding(1.5.dp).fillMaxWidth().clip(RoundedCornerShape(24.5.dp))
                .background(Brush.linearGradient(listOf(Color(0xFF10302C), Color(0xFF0C141C), Color(0xFF151A2A))))
                .drawBehind {
                    val r = size.width * 0.8f
                    drawCircle(Brush.radialGradient(listOf(tint.copy(alpha = 0.16f), Color.Transparent), center = Offset(size.width, 0f), radius = r), radius = r, center = Offset(size.width, 0f))
                }
                .padding(20.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconBadge(Icons.Rounded.WorkspacePremium, Tl.amber, 46.dp)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text("PLAN", style = TlType.eyebrow, color = Tl.muted)
                    Text(sub.str("plan") ?: "TradeLock Pro", style = TlType.title.copy(fontSize = 21.sp), color = Tl.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Row(Modifier.clip(CircleShape).background(tint.copy(alpha = 0.14f)).padding(start = 4.dp, end = 10.dp, top = 3.dp, bottom = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                    LivePulse(tint, active && paid)
                    Text(when { !active && sub.str("trialBlocked") != null -> "NO TRIAL"; !active -> if (paid) "ENDED" else "TRIAL ENDED"; paid -> "ACTIVE"; else -> "FREE TRIAL" },
                        style = TlType.eyebrow.copy(fontSize = 10.sp), color = tint)
                }
            }
            Spacer(Modifier.height(16.dp))
            Row(verticalAlignment = Alignment.Bottom) {
                Text("₹${(sub.num("priceInr") ?: 0.0).let { if (it % 1.0 == 0.0) it.toLong().toString() else "%.2f".format(it) }}",
                    style = TextStyle(brush = Tl.aurora, fontSize = 40.sp, fontWeight = FontWeight.ExtraBold, fontFamily = FontFamily.Monospace, letterSpacing = (-1).sp))
                Spacer(Modifier.width(6.dp))
                Text("/ month + ${Math.round((sub.num("gstRate") ?: 0.18) * 100)}% GST", style = TlType.small, color = Tl.muted, modifier = Modifier.padding(bottom = 8.dp))
            }
            Spacer(Modifier.height(14.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(if (!active) "Ended on" else if (paid) "Active until" else "Trial ends on", style = TlType.small, color = Tl.muted, modifier = Modifier.weight(1f))
                Text(end?.let { SUB_DAY.format(Instant.ofEpochMilli(it)) } ?: "–", style = TlType.num, color = Tl.text)
            }
            Spacer(Modifier.height(8.dp))
            Box(Modifier.fillMaxWidth().height(8.dp).clip(CircleShape).background(Color(0x22FFFFFF))) {
                Box(Modifier.fillMaxHeight().fillMaxWidth(meter).clip(CircleShape)
                    .background(Brush.horizontalGradient(if (active && daysLeft > 3) listOf(Tl.mint, Tl.ice) else listOf(Tl.amber, Tl.red))))
            }
            Spacer(Modifier.height(6.dp))
            Text(if (!active) "Protection is paused until you renew" else "$daysLeft day${if (daysLeft == 1L) "" else "s"} left${if (sub.bool("cancelAtPeriodEnd") == true) " · renewal off" else ""}",
                style = TlType.small, color = if (!active) Tl.red else if (daysLeft <= 3) Tl.amber else Tl.muted)
            sub.str("trialBlocked")?.takeIf { !active }?.let { Spacer(Modifier.height(6.dp)); Text("Free trial not available: $it (one free trial per person).", style = TlType.small, color = Tl.amber) }
            Spacer(Modifier.height(16.dp))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                FEATURES.forEach { f ->
                    Row(Modifier.clip(CircleShape).background(Color(0x14FFFFFF)).padding(horizontal = 10.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Rounded.CheckCircle, null, tint = Tl.mint, modifier = Modifier.size(14.dp)); Spacer(Modifier.width(5.dp))
                        Text(f, style = TlType.small.copy(fontWeight = FontWeight.SemiBold), color = Tl.text)
                    }
                }
            }
        }
    }
}

/**
 * Coupon: a "Have a coupon code?" chip that opens into a field (checked with the server: POST /billing/quote), and once
 * applied a ticket with the code, what it gives, and Remove.
 */
@Composable
private fun CouponBlock(quote: JsonObject?, onApplied: (JsonObject) -> Unit, onRemove: () -> Unit) {
    var state by remember { mutableStateOf(CouponState.Closed) }
    var code by remember { mutableStateOf("") }
    var checking by remember { mutableStateOf(false) }
    var err by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val focus = remember { FocusRequester() }
    val focusManager = LocalFocusManager.current
    val shown = if (quote?.obj("coupon") != null) CouponState.Applied else if (state == CouponState.Applied) CouponState.Closed else state

    fun apply() {
        val c = code.trim().uppercase()
        if (c.isEmpty() || checking) return
        checking = true; err = null
        scope.launch {
            try {
                val q = Api.post("/billing/quote", buildJsonObject { put("coupon", c) }).obj("quote")
                if (q?.obj("coupon") != null) { onApplied(q); state = CouponState.Applied; focusManager.clearFocus() } else err = "That code does not apply."
            } catch (e: ApiError) { err = e.message }
            checking = false
        }
    }

    AnimatedContent(shown, transitionSpec = { (fadeIn(tween(220)) + scaleIn(tween(220), initialScale = 0.96f)) togetherWith fadeOut(tween(150)) }, label = "coupon") { s ->
        when (s) {
            CouponState.Closed -> Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).tactile({ state = CouponState.Editing })
                    .drawBehind {
                        drawRoundRect(Tl.amber.copy(alpha = 0.6f), cornerRadius = androidx.compose.ui.geometry.CornerRadius(14.dp.toPx()),
                            style = androidx.compose.ui.graphics.drawscope.Stroke(1.5.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(10f, 8f))))
                    }.padding(horizontal = 14.dp, vertical = 13.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Rounded.LocalOffer, null, tint = Tl.amber, modifier = Modifier.size(18.dp)); Spacer(Modifier.width(10.dp))
                Text("Have a coupon code?", style = TlType.label, color = Tl.amber, modifier = Modifier.weight(1f))
                Text("Apply", style = TlType.small.copy(fontWeight = FontWeight.Bold), color = Tl.amber.copy(alpha = 0.8f))
            }
            CouponState.Editing -> Column {
                LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Row(Modifier.weight(1f).height(52.dp).clip(RoundedCornerShape(14.dp)).background(Tl.surfaceHi)
                        .border(1.5.dp, if (err != null) Tl.red.copy(alpha = 0.7f) else Tl.amber.copy(alpha = 0.55f), RoundedCornerShape(14.dp)).padding(horizontal = 14.dp),
                        verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Rounded.LocalOffer, null, tint = Tl.amber, modifier = Modifier.size(18.dp)); Spacer(Modifier.width(10.dp))
                        Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
                            if (code.isEmpty()) Text("Enter coupon code", style = TlType.body, color = Tl.dim)
                            BasicTextField(code, { v -> code = v.uppercase().filter { it.isLetterOrDigit() || it == '-' || it == '_' }.take(24); err = null },
                                singleLine = true, cursorBrush = SolidColor(Tl.amber),
                                textStyle = TlType.num.copy(fontSize = 16.sp, letterSpacing = 1.5.sp, color = Tl.text),
                                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, autoCorrectEnabled = false, imeAction = ImeAction.Done),
                                keyboardActions = KeyboardActions(onDone = { apply() }),
                                modifier = Modifier.fillMaxWidth().focusRequester(focus))
                        }
                        if (code.isNotEmpty()) Icon(Icons.Rounded.Close, "Clear", tint = Tl.dim, modifier = Modifier.size(18.dp).tactile({ code = ""; err = null }))
                    }
                    Spacer(Modifier.width(10.dp))
                    Box(Modifier.height(52.dp).width(92.dp).clip(RoundedCornerShape(14.dp))
                        .background(if (code.isBlank()) Brush.linearGradient(listOf(Tl.raised, Tl.raised)) else Brush.horizontalGradient(listOf(Color(0xFFFFC46B), Color(0xFFFF9F43))))
                        .tactile({ apply() }, enabled = code.isNotBlank() && !checking), contentAlignment = Alignment.Center) {
                        if (checking) CircularProgressIndicator(Modifier.size(20.dp), color = Color(0xFF2A1A02), strokeWidth = 2.5.dp)
                        else Text("Apply", fontWeight = FontWeight.Bold, fontSize = 15.sp, color = if (code.isBlank()) Tl.dim else Color(0xFF2A1A02))
                    }
                }
                err?.let { Text(it, style = TlType.small, color = Tl.red, modifier = Modifier.padding(top = 6.dp, start = 4.dp)) }
                Text("Cancel", style = TlType.small.copy(fontWeight = FontWeight.SemiBold), color = Tl.muted,
                    modifier = Modifier.padding(top = 8.dp, start = 4.dp).tactile({ state = CouponState.Closed; code = ""; err = null; focusManager.clearFocus() }))
            }
            CouponState.Applied -> {
                val c = quote?.obj("coupon")
                // A ticket: two notches cut into the sides and a dashed tear line.
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp))
                        .background(Brush.horizontalGradient(listOf(Color(0xFF0F3D35), Color(0xFF173226))))
                        .border(1.dp, Tl.green.copy(alpha = 0.45f), RoundedCornerShape(16.dp))
                        .drawBehind {
                            val cy = size.height / 2f; val r = 9.dp.toPx(); val x = 64.dp.toPx()
                            drawCircle(Color(0xFF0D1218), r, Offset(0f, cy)); drawCircle(Color(0xFF0D1218), r, Offset(size.width, cy))
                            drawLine(Tl.green.copy(alpha = 0.4f), Offset(x, 10.dp.toPx()), Offset(x, size.height - 10.dp.toPx()), 2f, pathEffect = PathEffect.dashPathEffect(floatArrayOf(6f, 6f)))
                        }
                        .padding(vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.width(64.dp), contentAlignment = Alignment.Center) { Icon(Icons.Rounded.Verified, null, tint = Tl.green, modifier = Modifier.size(26.dp)) }
                    Column(Modifier.weight(1f).padding(start = 12.dp)) {
                        Text(c?.str("code") ?: "", style = TlType.num.copy(fontSize = 17.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.5.sp), color = Tl.text)
                        Text("${c?.str("label") ?: ""} · applied", style = TlType.small, color = Tl.green)
                    }
                    Text("Remove", style = TlType.small.copy(fontWeight = FontWeight.Bold), color = Tl.muted,
                        modifier = Modifier.padding(end = 16.dp).tactile({ code = ""; state = CouponState.Closed; onRemove() }))
                }
            }
        }
    }
}

@Composable
private fun Line(k: String, v: String, color: Color = Tl.text, bold: Boolean = false) = Row(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
    Text(k, style = TlType.body, color = if (bold) Tl.text else Tl.muted, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
    Text(v, style = TlType.num.copy(fontWeight = if (bold) FontWeight.Bold else FontWeight.SemiBold), color = color)
}

/** The checkout button: a mint gradient with a lock, a spinner while the payment opens. */
@Composable
private fun PayButton(text: String, busy: Boolean, onClick: () -> Unit) {
    val shape = RoundedCornerShape(16.dp)
    Box(
        Modifier.fillMaxWidth().height(56.dp).tactile(onClick, enabled = !busy)
            .shadow(18.dp, shape, spotColor = Tl.mint, ambientColor = Tl.mint).clip(shape).background(Tl.mintBrush),
        contentAlignment = Alignment.Center,
    ) {
        if (busy) CircularProgressIndicator(Modifier.size(22.dp), color = Color(0xFF04261F), strokeWidth = 2.5.dp)
        else Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Rounded.Lock, null, tint = Color(0xFF04261F), modifier = Modifier.size(18.dp)); Spacer(Modifier.width(8.dp))
            Text(text, color = Color(0xFF04261F), fontWeight = FontWeight.Bold, fontSize = 16.sp)
        }
    }
}

