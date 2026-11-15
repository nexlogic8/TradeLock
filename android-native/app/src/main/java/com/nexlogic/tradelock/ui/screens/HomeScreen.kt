package com.nexlogic.tradelock.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.slideInVertically
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
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ShowChart
import androidx.compose.material.icons.rounded.AutoAwesome
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.NotificationsNone
import androidx.compose.material.icons.rounded.PowerSettingsNew
import androidx.compose.material.icons.rounded.QrCodeScanner
import androidx.compose.material.icons.rounded.Visibility
import androidx.compose.material.icons.rounded.VisibilityOff
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.nexlogic.tradelock.data.AppViewModel
import com.nexlogic.tradelock.data.Dash
import com.nexlogic.tradelock.data.Position
import com.nexlogic.tradelock.ui.ago
import com.nexlogic.tradelock.ui.components.ChipTile
import com.nexlogic.tradelock.ui.components.Dot
import com.nexlogic.tradelock.ui.components.Eyebrow
import com.nexlogic.tradelock.ui.components.PillSwitch
import com.nexlogic.tradelock.ui.components.PnlChart
import com.nexlogic.tradelock.ui.components.RollingText
import com.nexlogic.tradelock.ui.components.SwitchTile
import com.nexlogic.tradelock.ui.components.TlCard
import com.nexlogic.tradelock.ui.components.tactile
import com.nexlogic.tradelock.ui.inr
import com.nexlogic.tradelock.ui.theme.Tl
import com.nexlogic.tradelock.ui.theme.TlType
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private enum class Ask { None, Pnl, ProtectionOff, ProtectionLocked, AlgoOn, AlgoLocked, Kill }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(vm: AppViewModel, bottomPad: PaddingValues, onOpen: (String) -> Unit) {
    val dash by vm.dash.collectAsState()
    val points by vm.points.collectAsState()
    val wallet by vm.wallet.collectAsState()
    val unread by vm.unread.collectAsState()
    val live by vm.live.collectAsState()
    var ask by remember { mutableStateOf(Ask.None) }
    var refreshing by remember { mutableStateOf(false) }
    var hideFunds by rememberSaveable { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val d = dash
    val b = d?.broker

    PullToRefreshBox(
        isRefreshing = refreshing,
        onRefresh = { refreshing = true; vm.refresh(); scope.launch { delay(1200); refreshing = false } },
        modifier = Modifier.fillMaxSize(),
    ) {
        LazyColumn(
            Modifier.fillMaxSize().statusBarsPadding(),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = bottomPad.calculateBottomPadding() + 24.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            item { TopBar(unread, onQr = { onOpen("qrlogin") }) { onOpen("alerts") } }
            item {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        SwitchTile("Protection", Icons.Rounded.Lock, b?.agentOn != false, Tl.mint, Tl.mintDeep, Modifier.weight(1f)) {
                            if (b == null) return@SwitchTile
                            if (b.agentOn) ask = if (d.algoLocked || d.agentLock != null) Ask.ProtectionLocked else Ask.ProtectionOff
                            else vm.setProtection(true)
                        }
                        SwitchTile("Algo", Icons.Rounded.AutoAwesome, b?.algoOn == true, Tl.amber, Tl.amberDeep, Modifier.weight(1f)) {
                            if (b == null) return@SwitchTile
                            if (b.algoOn) { if (d.algoLocked) ask = Ask.AlgoLocked else vm.setAlgo(false) } else ask = Ask.AlgoOn
                        }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        ChipTile(Modifier.weight(1f), onClick = { onOpen("brokers") }) {
                            Dot(if (live && b?.status != "error") Tl.mint else Tl.amber)
                            Spacer(Modifier.width(10.dp))
                            Text(b?.label ?: "Connect broker", style = TlType.label, color = Tl.text, maxLines = 1)
                        }
                        ChipTile(Modifier.weight(1f), onClick = { ask = Ask.Pnl }) {
                            Icon(Icons.AutoMirrored.Rounded.ShowChart, null, tint = Tl.mint, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.width(8.dp))
                            val net = d?.netPnl ?: 0.0
                            RollingText(if (b == null) "₹–" else inr(net, sign = true), TlType.num.copy(fontSize = 16.sp), Tl.money(net))
                        }
                    }
                }
            }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    FundCard("Available margin", d?.fundsAvailable, "Free to trade" + (b?.lastSyncAt?.let { " · ${ago(it)}" } ?: ""), Tl.mint, hideFunds, Modifier.weight(1f)) { hideFunds = !hideFunds }
                    FundCard("Opening balance", d?.fundsOpening, "Start of day", Color(0xFF5AA9FF), hideFunds, Modifier.weight(1f)) { hideFunds = !hideFunds }
                }
            }
            item { AlarmBanner(vm) { onOpen("alarm") } }
            item { KillCard(d) { ask = Ask.Kill } }
            item {
                TlCard {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("Intraday P&L", style = TlType.title, color = Tl.text, modifier = Modifier.weight(1f))
                        LivePill(live && d?.marketOpen == true)
                    }
                    Spacer(Modifier.height(6.dp))
                    Text("After charges" + (d?.maxLoss?.let { " · stop −${inr(it)}" } ?: if (d?.maxLossOn == false) " · no stop-loss" else "") + (d?.profitLock?.let { " · target ${inr(it)}" } ?: ""),
                        style = TlType.small, color = Tl.muted)
                    Spacer(Modifier.height(12.dp))
                    PnlChart(points, d?.maxLoss, d?.profitLock)
                }
            }
            if (!d?.positions.isNullOrEmpty()) {
                item { Eyebrow("Open positions · ${d!!.positions.size}", Modifier.padding(start = 4.dp, top = 4.dp)) }
                items(d!!.positions, key = { it.securityId }) { p -> PositionRow(p) }
            }
        }
    }

    when (ask) {
        Ask.None -> Unit
        Ask.Pnl -> PnlSheet(d, wallet, { ask = Ask.None }) { ask = Ask.None; onOpen(it) }
        Ask.ProtectionOff -> ConfirmSheet("Stop Protection?",
            listOf("Your ${b?.label ?: "broker"} account is not watched any more.", "Limits are not enforced and nothing is exited automatically.", "Algo Trading stops too."),
            "Stop Protection", "Keep it on", danger = true, onDismiss = { ask = Ask.None }) { ask = Ask.None; vm.setProtection(false) }
        Ask.ProtectionLocked -> ConfirmSheet("Protection stays on",
            listOf(if (d?.algoLocked == true) "Algo Trading is on and stays on during market hours (09:15–15:30 IST), so Protection, which it needs, stays on too." else "Today ${d?.agentLock}, so Protection can't be stopped until the next trading day."),
            "Got it", "Close", danger = false, onDismiss = { ask = Ask.None }) { ask = Ask.None }
        Ask.AlgoOn -> ConfirmSheet("Start Algo Trading?",
            listOf("TradeLock places live orders on your ${b?.label ?: "broker"} account automatically.", "Once on, it stays on until 15:30 during market hours.", "Your risk rules apply to every automatic trade."),
            "Start Algo Trading", "Not now", danger = false, onDismiss = { ask = Ask.None }) { ask = Ask.None; vm.setAlgo(true) }
        Ask.AlgoLocked -> ConfirmSheet("Algo Trading stays on until 15:30",
            listOf("It can't be switched off during market hours (09:15–15:30 IST).", "Exits are always allowed: you can close an Algo trade yourself at any time."),
            "Got it", "Close", danger = false, onDismiss = { ask = Ask.None }) { ask = Ask.None }
        Ask.Kill -> KillSheet(d, { ask = Ask.None }) {
            ask = Ask.None
            scope.launch { vm.killSwitch()?.let { vm.toast(it, com.nexlogic.tradelock.data.Toast.Tone.Error) } }
        }
    }
}

@Composable
private fun TopBar(unread: Int, onQr: () -> Unit, onBell: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(top = 6.dp, bottom = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(40.dp).shadow(16.dp, RoundedCornerShape(12.dp), spotColor = Tl.mint).clip(RoundedCornerShape(12.dp)).background(Tl.mintBrush), contentAlignment = Alignment.Center) {
            Icon(Icons.Rounded.Lock, null, tint = Color(0xFF04261F), modifier = Modifier.size(20.dp))
        }
        Spacer(Modifier.width(12.dp))
        Text(buildAnnotatedString {
            withStyle(SpanStyle(color = Tl.text)) { append("TRADE") }
            withStyle(SpanStyle(color = Tl.mint)) { append("LOCK") }
        }, fontSize = 26.sp, fontWeight = FontWeight.Black, letterSpacing = (-0.5).sp, modifier = Modifier.weight(1f))
        // Scan the QR on the web login page to sign in there.
        Box(Modifier.size(46.dp).tactile(onQr).clip(RoundedCornerShape(14.dp)).background(Tl.surface).border(1.dp, Tl.lineHi, RoundedCornerShape(14.dp)), contentAlignment = Alignment.Center) {
            Icon(Icons.Rounded.QrCodeScanner, "Scan to sign in on the web", tint = Tl.mint, modifier = Modifier.size(22.dp))
        }
        Spacer(Modifier.width(10.dp))
        Box(Modifier.size(46.dp).tactile(onBell).clip(RoundedCornerShape(14.dp)).background(Tl.surface).border(1.dp, Tl.lineHi, RoundedCornerShape(14.dp)), contentAlignment = Alignment.Center) {
            Icon(Icons.Rounded.NotificationsNone, null, tint = Tl.mint, modifier = Modifier.size(22.dp))
            if (unread > 0) Box(Modifier.align(Alignment.TopEnd).offset((-6).dp, 6.dp).size(9.dp).clip(CircleShape).background(Tl.red))
        }
    }
}

@Composable
private fun FundCard(label: String, value: Double?, foot: String, accent: Color, hidden: Boolean, modifier: Modifier, onEye: () -> Unit) {
    TlCard(modifier, accent = accent, padding = 16.dp) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(label, style = TlType.small.copy(fontSize = 13.sp), color = Tl.muted, modifier = Modifier.weight(1f), maxLines = 1)
            Icon(if (hidden) Icons.Rounded.VisibilityOff else Icons.Rounded.Visibility, null, tint = Tl.dim, modifier = Modifier.size(18.dp).tactile(onEye))
        }
        Spacer(Modifier.height(10.dp))
        Text(if (hidden) "₹ ••••••" else inr(value, dp = 2), style = TlType.num.copy(fontSize = 19.sp, fontWeight = FontWeight.Bold), color = Tl.text, maxLines = 1)
        Spacer(Modifier.height(6.dp))
        Text(foot, style = TlType.small, color = Tl.dim, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun KillCard(d: Dash?, onClick: () -> Unit) {
    val on = d?.killArmed == true
    TlCard(Modifier.fillMaxWidth().tactile(onClick, enabled = d?.broker != null && !on), padding = 16.dp) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(44.dp).clip(RoundedCornerShape(13.dp)).background(Tl.red.copy(alpha = 0.14f)), contentAlignment = Alignment.Center) {
                Icon(Icons.Rounded.PowerSettingsNew, null, tint = Tl.red, modifier = Modifier.size(22.dp))
            }
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("${d?.broker?.label ?: "Broker"} kill switch", style = TlType.label.copy(fontSize = 16.sp), color = Tl.text)
                    Spacer(Modifier.width(8.dp))
                    Text(if (on) "ON" else "OFF", style = TlType.eyebrow, color = if (on) Tl.red else Tl.dim)
                }
                Text(if (on) "Account locked for today" else "Close all & block all orders", style = TlType.small.copy(fontSize = 13.sp), color = Tl.muted)
            }
            PillSwitch(on, Tl.red)
        }
    }
}

@Composable
private fun LivePill(on: Boolean) {
    Row(
        Modifier.clip(CircleShape).background(if (on) Tl.mint.copy(alpha = 0.12f) else Tl.surfaceHi).padding(horizontal = 10.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Dot(if (on) Tl.mint else Tl.dim, 6.dp)
        Spacer(Modifier.width(6.dp))
        Text(if (on) "LIVE" else "CLOSED", style = TlType.eyebrow.copy(fontSize = 10.sp), color = if (on) Tl.mint else Tl.dim)
    }
}

@Composable
private fun PositionRow(p: Position) {
    TlCard(Modifier.fillMaxWidth(), padding = 14.dp, shape = RoundedCornerShape(18.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(p.symbol, style = TlType.label, color = Tl.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.height(3.dp))
                Text("${if (p.qty > 0) "BUY" else "SELL"} ${kotlin.math.abs(p.qty).toLong()} · avg ${inr(p.avg, dp = 2).removePrefix("₹")} → ${p.ltp?.let { inr(it, dp = 2).removePrefix("₹") } ?: "–"}",
                    style = TlType.numSm, color = Tl.muted, maxLines = 1)
            }
            RollingText(inr(p.unrealized, sign = true), TlType.num, Tl.money(p.unrealized))
        }
    }
}
