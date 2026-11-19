package com.nexlogic.tradelock.ui.screens

import com.nexlogic.tradelock.ui.components.ambient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
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
import com.nexlogic.tradelock.ui.components.Eyebrow
import com.nexlogic.tradelock.ui.components.TlCard
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

private val DAY = DateTimeFormatter.ofPattern("d MMM yyyy").withZone(ZoneId.of("Asia/Kolkata"))
private val STAMP = DateTimeFormatter.ofPattern("d MMM, HH:mm").withZone(ZoneId.of("Asia/Kolkata"))
private enum class WAsk { None, Pay, Withdraw, Cancel, Add }

/** TradeLock wallet and subscription: balance, plan status, pay from the wallet, withdraw, history. */
@Composable
fun WalletScreen(vm: AppViewModel, onBack: () -> Unit, onOpenWeb: (String) -> Unit) {
    BackHandler { onBack() }
    var w by remember { mutableStateOf<JsonObject?>(null) }
    var sub by remember { mutableStateOf<JsonObject?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var ask by remember { mutableStateOf(WAsk.None) }
    val scope = rememberCoroutineScope()
    val ctx = androidx.compose.ui.platform.LocalContext.current
    suspend fun load() {
        try { w = Api.get("/wallet"); sub = Api.get("/billing").obj("subscription"); error = null; vm.loadWallet() } catch (e: ApiError) { error = e.message }
    }
    LaunchedEffect(Unit) { load() }
    // A payment was verified (or Razorpay's webhook may have credited it): show the new balance at once.
    LaunchedEffect(Unit) { com.nexlogic.tradelock.data.RazorpayPay.updates.collect { load() } }
    // Back from a UPI app or the background: refresh.
    val owner = androidx.lifecycle.compose.LocalLifecycleOwner.current
    androidx.compose.runtime.DisposableEffect(owner) {
        val obs = androidx.lifecycle.LifecycleEventObserver { _, e -> if (e == androidx.lifecycle.Lifecycle.Event.ON_RESUME) scope.launch { load() } }
        owner.lifecycle.addObserver(obs)
        onDispose { owner.lifecycle.removeObserver(obs) }
    }
    val b = w?.obj("balances")
    val plan = w?.obj("plan")

    LazyColumn(
        Modifier.fillMaxSize().ambient().statusBarsPadding().navigationBarsPadding(),
        contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(44.dp).tactile(onBack).clip(RoundedCornerShape(14.dp)).background(Tl.glass).border(1.dp, Tl.edgeOff, RoundedCornerShape(14.dp)), contentAlignment = Alignment.Center) {
                    Icon(Icons.AutoMirrored.Rounded.ArrowBack, null, tint = Tl.text)
                }
                Spacer(Modifier.width(12.dp))
                Text("Wallet", style = TlType.page)
            }
        }
        if (w == null) { item { Box(Modifier.fillMaxWidth().padding(40.dp), contentAlignment = Alignment.Center) { if (error != null) Text(error!!, color = Tl.red) else CircularProgressIndicator(color = Tl.mint) } }; return@LazyColumn }

        // ---- balance card ----
        item {
            Column(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(26.dp))
                    .background(Brush.linearGradient(listOf(Color(0xFF0F3D35), Color(0xFF0B1A20), Color(0xFF121826))))
                    .border(1.dp, Tl.mint.copy(alpha = 0.25f), RoundedCornerShape(26.dp)).padding(22.dp),
            ) {
                Eyebrow("TradeLock balance", color = Tl.mint.copy(alpha = 0.8f))
                Spacer(Modifier.height(8.dp))
                Text(paise(b?.long("total")), fontSize = 38.sp, fontWeight = FontWeight.Bold, fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace, color = Tl.text)
                Spacer(Modifier.height(14.dp))
                Row {
                    Column(Modifier.weight(1f)) { Text("Added funds", style = TlType.small, color = Tl.muted); Text(paise(b?.long("funds")), style = TlType.num, color = Tl.text) }
                    Column(Modifier.weight(1f)) { Text("Earnings", style = TlType.small, color = Tl.muted); Text(paise(b?.long("earnings")), style = TlType.num, color = Tl.green) }
                }
                (b?.long("pendingWithdrawals") ?: 0).takeIf { it > 0 }?.let { Spacer(Modifier.height(8.dp)); Text("${paise(it)} on its way to you", style = TlType.small, color = Tl.amber) }
                Spacer(Modifier.height(18.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    PrimaryButton("+  Add balance", Modifier.weight(1f)) { ask = WAsk.Add }
                    GhostButton("Withdraw", Modifier.weight(1f)) { ask = WAsk.Withdraw }
                }
            }
        }

        // ---- subscription ----
        item {
            val active = sub?.bool("active") == true
            val trial = sub?.str("status") == "trial"
            val tint = if (active) Tl.mint else Tl.amber
            TlCard(Modifier.fillMaxWidth(), padding = 20.dp) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Eyebrow("Subscription")
                        Spacer(Modifier.height(4.dp))
                        Text(sub?.str("plan") ?: plan?.str("name") ?: "TradeLock", style = TlType.title, color = Tl.text)
                    }
                    Text((if (trial && active) "TRIAL" else if (active) "ACTIVE" else "EXPIRED"), style = TlType.eyebrow, color = tint,
                        modifier = Modifier.clip(CircleShape).background(tint.copy(alpha = 0.14f)).padding(horizontal = 10.dp, vertical = 5.dp))
                }
                Spacer(Modifier.height(10.dp))
                Text(when {
                    trial && active -> "${sub?.num("trialDaysLeft")?.toInt() ?: 0} days of free trial left · ends ${sub?.long("trialEndsAt")?.let { DAY.format(Instant.ofEpochMilli(it)) } ?: ""}"
                    active && sub?.bool("cancelAtPeriodEnd") == true -> "Ends on ${sub?.long("currentPeriodEnd")?.let { DAY.format(Instant.ofEpochMilli(it)) }} · renewal off"
                    active -> "Renews on ${sub?.long("currentPeriodEnd")?.let { DAY.format(Instant.ofEpochMilli(it)) } ?: "—"}"
                    else -> "Protection and Algo Trading need an active plan."
                }, style = TlType.body, color = Tl.muted)
                sub?.str("trialBlocked")?.let { Spacer(Modifier.height(6.dp)); Text(it, style = TlType.small, color = Tl.amber) }
                Spacer(Modifier.height(4.dp))
                Text("${paise(plan?.long("total"))} a month incl. GST", style = TlType.small, color = Tl.dim)
                Spacer(Modifier.height(16.dp))
                // Plans, coupons and checkout live on the Subscription screen.
                PrimaryButton(if (active && !trial) "Extend · apply a coupon" else "Subscribe · apply a coupon") { onOpenWeb("billing") }
                if (active && !trial) {
                    Spacer(Modifier.height(10.dp))
                    if (sub?.bool("cancelAtPeriodEnd") == true) GhostButton("Turn renewal back on", Modifier.fillMaxWidth()) {
                        scope.launch { runCatching { Api.post("/billing/resume") }.onSuccess { vm.toast("Renewal is on.") }; load() }
                    } else GhostButton("Cancel renewal", Modifier.fillMaxWidth()) { ask = WAsk.Cancel }
                }
            }
        }

        // ---- broker funds (stay with the broker) ----
        w?.obj("broker")?.let { br ->
            item {
                TlCard(Modifier.fillMaxWidth(), padding = 18.dp) {
                    Eyebrow("${br.str("label")} · trading account")
                    Spacer(Modifier.height(10.dp))
                    WRow("Available margin", br.num("available")?.let { com.nexlogic.tradelock.ui.inr(it, dp = 2) } ?: "–")
                    WRow("Used margin", br.num("used")?.let { com.nexlogic.tradelock.ui.inr(it, dp = 2) } ?: "–")
                    Text("This money stays with ${br.str("label")}; TradeLock never holds it.", style = TlType.small, color = Tl.dim, modifier = Modifier.padding(top = 6.dp))
                }
            }
        }

        // ---- withdrawals + history ----
        val wds = w?.arr("withdrawals")?.mapNotNull { it as? JsonObject }.orEmpty()
        if (wds.isNotEmpty()) {
            item { Eyebrow("Withdrawals", Modifier.padding(start = 4.dp, top = 4.dp)) }
            wds.forEach { x ->
                item(key = "wd${x.long("id")}") {
                    val st = x.str("status") ?: ""
                    LedgerRow("To ${x.str("destination") ?: x.str("method")}", x.long("createdAt"), -(x.long("amount") ?: 0), st.uppercase(),
                        when (st) { "paid" -> Tl.mint; "rejected" -> Tl.red; else -> Tl.amber })
                }
            }
        }
        val lines = w?.arr("ledger")?.mapNotNull { it as? JsonObject }.orEmpty()
        item { Eyebrow("History", Modifier.padding(start = 4.dp, top = 4.dp)) }
        if (lines.isEmpty()) item { Text("No wallet activity yet.", style = TlType.body, color = Tl.dim, modifier = Modifier.padding(horizontal = 4.dp)) }
        lines.forEach { l ->
            item(key = "l${l.long("id")}") {
                LedgerRow(l.str("note")?.takeIf { it.isNotBlank() } ?: (l.str("type") ?: ""), l.long("createdAt"), l.long("amount") ?: 0, (l.str("bucket") ?: "").uppercase(), Tl.dim)
            }
        }
    }

    when (ask) {
        WAsk.None -> Unit
        // As on the website (/billing/checkout): the wallet pays first and Razorpay opens for whatever is left.
        WAsk.Pay -> {
            val total = plan?.long("total") ?: 0L
            val inWallet = b?.long("total") ?: 0L
            val due = (total - inWallet).coerceAtLeast(0L)
            ConfirmSheet(if (due == 0L) "Pay ${paise(total)} from your wallet?" else "Pay ${paise(total)}?",
                listOf("One month of ${plan?.str("name") ?: "TradeLock"}, GST included.",
                    when {
                        due == 0L -> "Added funds are used first, then earnings. Your wallet has ${paise(inWallet)}."
                        inWallet > 0L -> "${paise(inWallet)} from your wallet, ${paise(due)} through Razorpay (UPI, cards, netbanking)."
                        else -> "Through Razorpay: UPI, cards or netbanking."
                    }),
                if (due == 0L) "Pay now" else "Pay ${paise(due)}", "Not now", danger = false, onDismiss = { ask = WAsk.None }) {
                ask = WAsk.None
                scope.launch {
                    try {
                        val res = Api.post("/billing/checkout", buildJsonObject { put("useWallet", true) })
                        if (res.bool("paid") != true && res.str("provider") == "razorpay") {
                            val activity = activityOf(ctx)
                            if (activity == null) { vm.toast("Could not open the payment screen.", Toast.Tone.Error); return@launch }
                            com.nexlogic.tradelock.data.RazorpayPay.pay(activity, res, "${plan?.str("name") ?: "TradeLock"} · 1 month").getOrElse {
                                val received = it.message?.startsWith("Payment received") == true
                                if (received) vm.toast(it.message!!) else vm.toast(it.message ?: "Payment failed.", Toast.Tone.Error)
                                load(); return@launch
                            }
                        }
                        vm.toast("Paid. Your subscription is active.")
                    } catch (e: ApiError) { vm.toast(e.message, Toast.Tone.Error) }
                    load()
                }
            }
        }
        WAsk.Cancel -> ConfirmSheet("Cancel renewal?",
            listOf("Your plan stays active until the end of this period.", "After that, Protection and Algo Trading stop.", "You can turn renewal back on any time before then."),
            "Cancel renewal", "Keep it", danger = true, onDismiss = { ask = WAsk.None }) {
            ask = WAsk.None
            scope.launch { runCatching { Api.post("/billing/cancel") }.onSuccess { vm.toast("Renewal cancelled.") }; load() }
        }
        // The server creates the Razorpay order (as on the website); Razorpay Checkout opens natively; the signed
        // result is verified on the server, which credits the wallet (its webhook does it too if the app closes).
        WAsk.Add -> AddBalanceSheet(onDismiss = { ask = WAsk.None }, onPay = pay@{ rupees ->
            try {
                val order = Api.post("/wallet/topup", buildJsonObject { put("amount", rupees) })
                if (order.str("provider") == "razorpay") {
                    val activity = activityOf(ctx) ?: return@pay "Could not open the payment screen."
                    com.nexlogic.tradelock.data.RazorpayPay.pay(activity, order, "Wallet top-up").getOrElse {
                        // Paid but not yet confirmed: close the sheet; the balance refreshes as soon as the server credits it.
                        if (it.message?.startsWith("Payment received") == true) { ask = WAsk.None; vm.toast(it.message!!); load(); return@pay null }
                        return@pay it.message
                    }
                }
                val added = (order.long("amount") ?: 0L) / 100.0
                ask = WAsk.None; vm.toast("₹${"%,.0f".format(added)} added to your wallet."); load(); null
            } catch (e: ApiError) { e.message }
        })
        WAsk.Withdraw -> WithdrawSheet(b?.long("total") ?: 0, { ask = WAsk.None }) { body ->
            try { Api.post("/wallet/withdraw", body); ask = WAsk.None; vm.toast("Withdrawal requested: it arrives within 2 working days."); load(); null }
            catch (e: ApiError) { e.message }
        }
    }
}

@Composable
private fun WRow(k: String, v: String) = Row(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
    Text(k, style = TlType.body, color = Tl.muted, modifier = Modifier.weight(1f)); Text(v, style = TlType.num, color = Tl.text)
}

@Composable
private fun LedgerRow(title: String, at: Long?, amountPaise: Long, tag: String, tagColor: Color) {
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Tl.surface).padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, style = TlType.label.copy(fontSize = 14.sp), color = Tl.text, maxLines = 2)
            Text((at?.let { STAMP.format(Instant.ofEpochMilli(it)) } ?: "") + " · $tag", style = TlType.small.copy(fontSize = 11.sp), color = tagColor)
        }
        Text((if (amountPaise > 0) "+" else "") + paise(amountPaise), style = TlType.num, color = if (amountPaise > 0) Tl.green else Tl.text)
    }
}

internal fun activityOf(c: android.content.Context): android.app.Activity? {
    var x: android.content.Context? = c
    while (x is android.content.ContextWrapper) { if (x is android.app.Activity) return x; x = x.baseContext }
    return null
}

/** Add balance: an amount (typed or a quick chip), then Razorpay. onPay returns an error message, or null when done. */
@Composable
private fun AddBalanceSheet(onDismiss: () -> Unit, onPay: suspend (Double) -> String?) {
    var amount by remember { mutableStateOf("1000") }
    var err by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    TlSheet(onDismiss) {
        Text("Add balance", style = TlType.title.copy(fontSize = 22.sp), color = Tl.text)
        Text("UPI · cards · netbanking, through Razorpay", style = TlType.small, color = Tl.muted)
        Spacer(Modifier.height(14.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("500", "1000", "2000", "5000").forEach { v ->
                val on = amount == v
                Box(Modifier.tactile({ amount = v; err = null }).clip(RoundedCornerShape(12.dp)).background(if (on) Tl.mint.copy(alpha = 0.16f) else Tl.surfaceHi)
                    .border(1.dp, if (on) Tl.mint.copy(alpha = 0.6f) else Tl.line, RoundedCornerShape(12.dp)).padding(horizontal = 14.dp, vertical = 10.dp)) {
                    Text("₹$v", style = TlType.label, color = if (on) Tl.mint else Tl.text)
                }
            }
        }
        Spacer(Modifier.height(10.dp))
        WField("Amount (₹)", amount, KeyboardType.Number) { amount = it.filter(Char::isDigit); err = null }
        err?.let { Text(it, style = TlType.small, color = Tl.red, modifier = Modifier.padding(top = 6.dp)) }
        Spacer(Modifier.height(14.dp))
        PrimaryButton(if (busy) "Opening Razorpay…" else "Add ₹${amount.ifEmpty { "0" }}") {
            if (busy) return@PrimaryButton
            val rupees = amount.toDoubleOrNull() ?: 0.0
            if (rupees <= 0) { err = "Enter an amount."; return@PrimaryButton }
            busy = true
            scope.launch { err = onPay(rupees); busy = false }
        }
        Spacer(Modifier.height(8.dp))
        GhostButton("Cancel", Modifier.fillMaxWidth()) { onDismiss() }
    }
}

/** Withdraw earnings or funds to UPI or a bank account. onSubmit returns null when done, else the error. */
@Composable
private fun WithdrawSheet(totalPaise: Long, onDismiss: () -> Unit, onSubmit: suspend (JsonObject) -> String?) {
    var method by remember { mutableStateOf("upi") }
    var amount by remember { mutableStateOf("") }
    var upi by remember { mutableStateOf("") }
    var account by remember { mutableStateOf("") }
    var ifsc by remember { mutableStateOf("") }
    var name by remember { mutableStateOf("") }
    var err by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    TlSheet(onDismiss) {
        Text("Withdraw", style = TlType.title.copy(fontSize = 22.sp), color = Tl.text)
        Text("Up to ${paise(totalPaise)} · minimum ₹100 · arrives within 2 working days", style = TlType.small, color = Tl.muted)
        Spacer(Modifier.height(14.dp))
        Row(Modifier.clip(RoundedCornerShape(12.dp)).background(Tl.surfaceHi).padding(3.dp)) {
            listOf("upi" to "UPI", "bank" to "Bank transfer").forEach { (k, l) ->
                Box(Modifier.tactile({ method = k }).clip(RoundedCornerShape(10.dp)).background(if (method == k) Tl.raised else Color.Transparent).padding(horizontal = 18.dp, vertical = 10.dp)) {
                    Text(l, style = TlType.label, color = if (method == k) Tl.mint else Tl.muted)
                }
            }
        }
        Spacer(Modifier.height(12.dp))
        WField("Amount (₹)", amount, KeyboardType.Decimal) { amount = it.filter { c -> c.isDigit() || c == '.' } }
        if (method == "upi") WField("UPI ID", upi) { upi = it.trim() }
        else { WField("Account holder name", name) { name = it }; WField("Account number", account, KeyboardType.Number) { account = it.filter(Char::isDigit) }; WField("IFSC", ifsc) { ifsc = it.uppercase().trim() } }
        err?.let { Text(it, style = TlType.small, color = Tl.red, modifier = Modifier.padding(top = 6.dp)) }
        Spacer(Modifier.height(14.dp))
        PrimaryButton(if (busy) "Sending…" else "Request withdrawal") {
            if (busy) return@PrimaryButton
            busy = true
            scope.launch {
                err = onSubmit(buildJsonObject {
                    put("amount", amount.toDoubleOrNull() ?: 0.0); put("method", method)
                    if (method == "upi") put("upi", upi) else { put("account", account); put("ifsc", ifsc); put("name", name) }
                })
                busy = false
            }
        }
    }
}

@Composable
private fun WField(label: String, value: String, type: KeyboardType = KeyboardType.Text, onChange: (String) -> Unit) {
    OutlinedTextField(value, onChange, label = { Text(label) }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp), shape = RoundedCornerShape(14.dp),
        keyboardOptions = KeyboardOptions(keyboardType = type),
        colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = Tl.mint, unfocusedBorderColor = Tl.lineHi, focusedLabelColor = Tl.mint, cursorColor = Tl.mint, focusedTextColor = Tl.text, unfocusedTextColor = Tl.text))
}
