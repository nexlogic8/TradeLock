package com.nexlogic.tradelock.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.rounded.Logout
import androidx.compose.material.icons.automirrored.rounded.MenuBook
import androidx.compose.material.icons.rounded.AccountBalanceWallet
import androidx.compose.material.icons.rounded.AlarmOn
import androidx.compose.material.icons.rounded.QrCodeScanner
import androidx.compose.material.icons.rounded.Analytics
import androidx.compose.material.icons.rounded.CalendarMonth
import androidx.compose.material.icons.rounded.CardMembership
import androidx.compose.material.icons.rounded.Hub
import androidx.compose.material.icons.rounded.Link
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.QueryStats
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.Tune
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.nexlogic.tradelock.data.User
import com.nexlogic.tradelock.ui.components.Eyebrow
import com.nexlogic.tradelock.ui.components.TlCard
import com.nexlogic.tradelock.ui.components.tactile
import com.nexlogic.tradelock.ui.theme.Tl
import com.nexlogic.tradelock.ui.theme.TlType

private val TRADING = listOf(
    Triple("Scan to sign in on web", "qrlogin", Icons.Rounded.QrCodeScanner),
    Triple("Trade alarm", "alarm", Icons.Rounded.AlarmOn),
    Triple("Strategy", "strategy", Icons.Rounded.Tune),
    Triple("Backtest", "backtest", Icons.Rounded.QueryStats),
    Triple("P&L calendar", "calendar", Icons.Rounded.CalendarMonth),
    Triple("Journal", "journal", Icons.AutoMirrored.Rounded.MenuBook),
    Triple("Analytics", "analytics", Icons.Rounded.Analytics),
)
private val ACCOUNT = listOf(
    Triple("Broker accounts", "brokers", Icons.Rounded.Link),
    Triple("Wallet", "wallet", Icons.Rounded.AccountBalanceWallet),
    Triple("Subscription", "billing", Icons.Rounded.CardMembership),
    Triple("Profile", "profile", Icons.Rounded.Person),
    Triple("Affiliate hub", "affiliate", Icons.Rounded.Hub),
    Triple("Settings", "settings", Icons.Rounded.Settings),
)

@Composable
fun MenuScreen(user: User?, bottomPad: PaddingValues, onOpen: (String) -> Unit, onSignOut: () -> Unit) {
    LazyColumn(
        Modifier.fillMaxSize().background(Tl.bg).statusBarsPadding(),
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 12.dp, bottom = bottomPad.calculateBottomPadding() + 24.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        item {
            TlCard(Modifier.fillMaxWidth()) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(56.dp).clip(CircleShape).background(Tl.mintBrush), contentAlignment = Alignment.Center) {
                        Text(user?.initials ?: "", color = Color(0xFF04261F), fontWeight = FontWeight.Black, fontSize = 20.sp)
                        if (!user?.avatar.isNullOrBlank()) AsyncImage(user!!.avatar, null, Modifier.size(56.dp).clip(CircleShape))
                    }
                    Spacer(Modifier.width(14.dp))
                    Column(Modifier.weight(1f)) {
                        Text(user?.name ?: "", style = TlType.title, color = Tl.text)
                        Text(user?.email ?: "", style = TlType.small.copy(fontSize = 13.sp), color = Tl.muted)
                    }
                }
            }
        }
        item { Group("Trading", TRADING, onOpen) }
        item { Group("Account", ACCOUNT, onOpen) }
        item {
            TlCard(Modifier.fillMaxWidth().tactile(onSignOut), padding = 16.dp) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.AutoMirrored.Rounded.Logout, null, tint = Tl.red, modifier = Modifier.size(22.dp))
                    Spacer(Modifier.width(14.dp))
                    Text("Sign out", style = TlType.label.copy(fontSize = 16.sp), color = Tl.red)
                }
            }
        }
        item { Text("TradeLock native · preview", style = TlType.small, color = Tl.dim, modifier = Modifier.fillMaxWidth().padding(top = 4.dp)) }
    }
}

@Composable
private fun Group(title: String, rows: List<Triple<String, String, ImageVector>>, onOpen: (String) -> Unit) {
    Column {
        Eyebrow(title, Modifier.padding(start = 4.dp, bottom = 10.dp))
        TlCard(Modifier.fillMaxWidth(), padding = 6.dp) {
            rows.forEachIndexed { i, (label, path, icon) ->
                Row(
                    Modifier.fillMaxWidth().tactile({ onOpen(path) }).clip(RoundedCornerShape(14.dp)).padding(horizontal = 12.dp, vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.size(36.dp).clip(RoundedCornerShape(11.dp)).background(Tl.surfaceHi), contentAlignment = Alignment.Center) {
                        Icon(icon, null, tint = Tl.mint, modifier = Modifier.size(19.dp))
                    }
                    Spacer(Modifier.width(14.dp))
                    Text(label, style = TlType.label.copy(fontSize = 16.sp), color = Tl.text, modifier = Modifier.weight(1f))
                    Icon(Icons.AutoMirrored.Rounded.KeyboardArrowRight, null, tint = Tl.dim)
                }
                if (i < rows.lastIndex) Box(Modifier.fillMaxWidth().padding(start = 62.dp).height(1.dp).background(Tl.line))
            }
        }
    }
}
