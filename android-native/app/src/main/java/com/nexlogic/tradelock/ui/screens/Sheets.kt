package com.nexlogic.tradelock.ui.screens

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.draw.drawBehind
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.nexlogic.tradelock.data.Dash
import com.nexlogic.tradelock.data.Wallet
import com.nexlogic.tradelock.ui.ago
import com.nexlogic.tradelock.ui.components.Divider
import com.nexlogic.tradelock.ui.components.Eyebrow
import com.nexlogic.tradelock.ui.components.HoldToConfirm
import com.nexlogic.tradelock.ui.components.tactile
import com.nexlogic.tradelock.ui.inr
import com.nexlogic.tradelock.ui.paise
import com.nexlogic.tradelock.ui.theme.Tl
import com.nexlogic.tradelock.ui.theme.TlType

/** The app's bottom sheet: dark, rounded, with a grab bar; slides up with Material's spring. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TlSheet(onDismiss: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = Color(0xFF0E131B),
        scrimColor = Color(0xB3020509),
        shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
        dragHandle = { Box(Modifier.padding(top = 12.dp, bottom = 6.dp).size(44.dp, 5.dp).clip(CircleShape).background(Tl.aurora)) },
    ) {
        // A faint aurora light at the top of the sheet.
        Column(Modifier.fillMaxWidth().drawBehind {
            val r = size.width * 0.8f
            drawCircle(Brush.radialGradient(listOf(Color(0x14A78BFA), Color.Transparent), center = Offset(size.width * 0.2f, 0f), radius = r), radius = r, center = Offset(size.width * 0.2f, 0f))
        }.padding(horizontal = 22.dp).padding(bottom = 18.dp).navigationBarsPadding(), content = content)
    }
}

@Composable
private fun SheetRow(label: String, value: String, color: Color = Tl.text, bold: Boolean = false, big: Boolean = false) {
    Row(Modifier.fillMaxWidth().padding(vertical = 7.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = TlType.body.copy(fontSize = 15.sp), color = if (big) Tl.text else Tl.muted, modifier = Modifier.weight(1f))
        Text(value, style = if (big) TlType.big else TlType.num.copy(fontWeight = if (bold) FontWeight.Bold else FontWeight.Medium), color = color)
    }
}

/** Today's P&L details: after charges, gross, charges, realized / open; broker margin; TradeLock wallet. */
@Composable
fun PnlSheet(dash: Dash?, wallet: Wallet?, onDismiss: () -> Unit, onOpen: (String) -> Unit) = TlSheet(onDismiss) {
    val b = dash?.broker
    Eyebrow("Today's P&L" + (b?.let { " · ${it.label}" } ?: ""))
    Spacer(Modifier.height(10.dp))
    if (dash == null || b == null) {
        Text("Connect a broker to see your P&L.", style = TlType.body, color = Tl.muted)
    } else {
        SheetRow("Day P&L after charges", inr(dash.netPnl, sign = true), Tl.money(dash.netPnl), big = true)
        SheetRow("Gross P&L", inr(dash.pnl, sign = true))
        SheetRow("Charges (estimated)", "−" + inr(dash.charges).removePrefix("−"))
        SheetRow("Realized", inr(dash.realized, sign = true))
        SheetRow("Open positions", inr(dash.unrealized, sign = true), Tl.money(dash.unrealized))
    }
    Spacer(Modifier.height(14.dp)); Divider(); Spacer(Modifier.height(16.dp))
    Eyebrow("${b?.label ?: "Broker"} · trading account")
    Spacer(Modifier.height(8.dp))
    SheetRow("Available margin", inr(dash?.fundsAvailable, dp = 2), bold = true)
    SheetRow("Used margin", inr(dash?.fundsUsed, dp = 2))
    Text(if (b?.lastSyncAt != null) "Updated ${ago(b.lastSyncAt)} · stays with ${b.label}" else "Connect a broker to see your margin", style = TlType.small, color = Tl.dim)
    Spacer(Modifier.height(16.dp)); Divider(); Spacer(Modifier.height(16.dp))
    Eyebrow("TradeLock wallet")
    Spacer(Modifier.height(8.dp))
    SheetRow("Balance", paise(wallet?.total), bold = true)
    SheetRow("Added funds", paise(wallet?.funds))
    SheetRow("Earnings", paise(wallet?.earnings), Tl.green)
    Spacer(Modifier.height(18.dp))
    PrimaryButton("+  Add balance") { onOpen("wallet") }
    Spacer(Modifier.height(10.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        GhostButton("Pay subscription", Modifier.weight(1f)) { onOpen("wallet") }
        GhostButton("Withdraw", Modifier.weight(1f)) { onOpen("wallet") }
    }
}

/** A yes / no question as a sheet: title, what will happen, and the two choices. */
@Composable
fun ConfirmSheet(title: String, points: List<String>, confirm: String, cancel: String, danger: Boolean, onDismiss: () -> Unit, onConfirm: () -> Unit) = TlSheet(onDismiss) {
    Text(title, style = TlType.title.copy(fontSize = 22.sp), color = Tl.text)
    Spacer(Modifier.height(14.dp))
    points.forEach { p ->
        Row(Modifier.padding(vertical = 5.dp)) {
            Box(Modifier.padding(top = 7.dp).size(6.dp).clip(CircleShape).background(if (danger) Tl.red else Tl.amber))
            Spacer(Modifier.width(12.dp))
            Text(p, style = TlType.body.copy(fontSize = 15.sp), color = Tl.muted)
        }
    }
    Spacer(Modifier.height(22.dp))
    if (danger) DangerButton(confirm) { onConfirm() } else PrimaryButton(confirm) { onConfirm() }
    Spacer(Modifier.height(10.dp))
    GhostButton(cancel, Modifier.fillMaxWidth()) { onDismiss() }
}

/** Kill switch: one hold closes everything and locks the broker account for the day. */
@Composable
fun KillSheet(dash: Dash?, onDismiss: () -> Unit, onConfirm: () -> Unit) = TlSheet(onDismiss) {
    val label = dash?.broker?.label ?: "broker"
    Text("$label kill switch", style = TlType.title.copy(fontSize = 22.sp), color = Tl.text)
    Spacer(Modifier.height(14.dp))
    listOf("Cancels every pending order", "Exits every open position at market", "Locks your $label account for the rest of the day", "Can't be undone until tomorrow").forEach { p ->
        Row(Modifier.padding(vertical = 5.dp)) {
            Box(Modifier.padding(top = 7.dp).size(6.dp).clip(CircleShape).background(Tl.red))
            Spacer(Modifier.width(12.dp))
            Text(p, style = TlType.body.copy(fontSize = 15.sp), color = Tl.muted)
        }
    }
    Spacer(Modifier.height(24.dp))
    HoldToConfirm("Hold to close all and lock", "Keep holding…", Tl.red, Modifier.fillMaxWidth()) { onConfirm() }
    Spacer(Modifier.height(10.dp))
    GhostButton("Cancel", Modifier.fillMaxWidth()) { onDismiss() }
}

@Composable
fun PrimaryButton(text: String, modifier: Modifier = Modifier.fillMaxWidth(), onClick: () -> Unit) =
    Box(modifier.height(54.dp).tactile(onClick).shadow(18.dp, RoundedCornerShape(16.dp), spotColor = Tl.mint, ambientColor = Tl.mint).clip(RoundedCornerShape(16.dp)).background(Tl.mintBrush), contentAlignment = Alignment.Center) {
        Text(text, color = Color(0xFF04261F), fontWeight = FontWeight.Bold, fontSize = 16.sp)
    }

@Composable
fun DangerButton(text: String, modifier: Modifier = Modifier.fillMaxWidth(), onClick: () -> Unit) =
    Box(modifier.height(54.dp).tactile(onClick).shadow(18.dp, RoundedCornerShape(16.dp), spotColor = Tl.red, ambientColor = Tl.red).clip(RoundedCornerShape(16.dp))
        .background(Brush.verticalGradient(listOf(Color(0xFFFF7690), Color(0xFFF0446A)))), contentAlignment = Alignment.Center) {
        Text(text, color = Color(0xFF1C0309), fontWeight = FontWeight.Bold, fontSize = 16.sp)
    }

@Composable
fun GhostButton(text: String, modifier: Modifier = Modifier, onClick: () -> Unit) =
    Box(
        modifier.height(50.dp).tactile(onClick).clip(RoundedCornerShape(16.dp)).background(Tl.surfaceHi)
            .then(Modifier.background(Color.Transparent)),
        contentAlignment = Alignment.Center,
    ) { Text(text, style = TlType.label, color = Tl.mint) }
