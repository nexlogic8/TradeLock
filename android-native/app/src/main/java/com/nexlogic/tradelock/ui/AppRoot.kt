package com.nexlogic.tradelock.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ShowChart
import androidx.compose.material.icons.rounded.AutoAwesome
import androidx.compose.material.icons.rounded.GridView
import androidx.compose.material.icons.rounded.Menu
import androidx.compose.material.icons.rounded.Tune
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.nexlogic.tradelock.data.AppViewModel
import com.nexlogic.tradelock.data.Session
import com.nexlogic.tradelock.data.Toast
import com.nexlogic.tradelock.ui.components.tactile
import com.nexlogic.tradelock.ui.screens.HomeScreen
import com.nexlogic.tradelock.ui.screens.LoginScreen
import com.nexlogic.tradelock.ui.screens.MenuScreen
import com.nexlogic.tradelock.ui.screens.WebPage
import com.nexlogic.tradelock.ui.theme.Tl
import com.nexlogic.tradelock.ui.theme.TlType
import kotlinx.coroutines.delay

private enum class Tab(val label: String, val icon: ImageVector, val web: String?) {
    Home("Home", Icons.Rounded.GridView, null),
    Algo("Algo", Icons.Rounded.AutoAwesome, "algo"),
    Scalper("Scalper", Icons.AutoMirrored.Rounded.ShowChart, "scalper"),
    Rules("Rules", Icons.Rounded.Tune, "rules"),
    Menu("Menu", Icons.Rounded.Menu, null),
}

@Composable
fun AppRoot(vm: AppViewModel) {
    val session by vm.session.collectAsState()
    Box(Modifier.fillMaxSize().background(Tl.bg)) {
        AnimatedContent(session::class, transitionSpec = { fadeIn(tween(300)) togetherWith fadeOut(tween(200)) }, label = "session") { kind ->
            when (kind) {
                Session.Loading::class -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = Tl.mint) }
                Session.SignedOut::class -> LoginScreen(vm)
                else -> Signed(vm, (session as? Session.SignedIn))
            }
        }
        ToastHost(vm)
    }
}

@Composable
private fun Signed(vm: AppViewModel, s: Session.SignedIn?) {
    var tab by remember { mutableStateOf(Tab.Home) }
    // Pages opened from Home / Menu (not native yet) stack above the tabs; Back closes them.
    val pages = remember { mutableStateListOf<String>() }
    // room for the bottom bar plus the phone's own navigation bar under it
    val navInset = androidx.compose.foundation.layout.WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    val bottom = PaddingValues(bottom = 92.dp + navInset)
    BackHandler(enabled = pages.isEmpty() && tab != Tab.Home) { tab = Tab.Home }
    val open: (String) -> Unit = { p ->
        // A tab destination closes any pages open above the tabs.
        when (p) { "algo" -> { pages.clear(); tab = Tab.Algo }; "scalper" -> { pages.clear(); tab = Tab.Scalper }; "rules" -> { pages.clear(); tab = Tab.Rules }; "overview" -> { pages.clear(); tab = Tab.Home }; else -> pages.add(p) }
    }

    Box(Modifier.fillMaxSize()) {
        when {
            pages.lastOrNull() == "alarm" -> com.nexlogic.tradelock.ui.screens.AlarmScreen(vm) { pages.removeAt(pages.lastIndex) }
            pages.lastOrNull() == "wallet" || pages.lastOrNull() == "billing" -> com.nexlogic.tradelock.ui.screens.WalletScreen(vm, { pages.removeAt(pages.lastIndex) }, open)
            pages.lastOrNull() == "calendar" -> com.nexlogic.tradelock.ui.screens.CalendarScreen(vm) { pages.removeAt(pages.lastIndex) }
            pages.lastOrNull() == "settings" -> com.nexlogic.tradelock.ui.screens.SettingsScreen(vm, { pages.removeAt(pages.lastIndex) }, open)
            pages.lastOrNull() == "journal" -> com.nexlogic.tradelock.ui.screens.JournalScreen(vm) { pages.removeAt(pages.lastIndex) }
            pages.lastOrNull() == "analytics" -> com.nexlogic.tradelock.ui.screens.AnalyticsScreen(vm) { pages.removeAt(pages.lastIndex) }
            pages.lastOrNull() == "affiliate" -> com.nexlogic.tradelock.ui.screens.AffiliateScreen(vm) { pages.removeAt(pages.lastIndex) }
            pages.lastOrNull() == "profile" -> com.nexlogic.tradelock.ui.screens.ProfileScreen(vm, { pages.removeAt(pages.lastIndex) }, open)
            pages.lastOrNull() == "strategy" -> com.nexlogic.tradelock.ui.screens.StrategyScreen(vm, { pages.removeAt(pages.lastIndex) }, open)
            pages.lastOrNull() == "backtest" -> com.nexlogic.tradelock.ui.screens.BacktestScreen(vm, { pages.removeAt(pages.lastIndex) }, open)
            pages.lastOrNull() == "qrlogin" -> com.nexlogic.tradelock.ui.screens.QrLoginScreen(vm) { pages.removeAt(pages.lastIndex) }
            pages.lastOrNull() == "alerts" -> com.nexlogic.tradelock.ui.screens.NotificationsScreen(vm) { pages.removeAt(pages.lastIndex) }
            pages.lastOrNull() == "brokers" -> com.nexlogic.tradelock.ui.screens.BrokerScreen(vm, { pages.removeAt(pages.lastIndex) }, open)
            pages.isNotEmpty() -> WebPage(pages.last(), PaddingValues(0.dp)) { pages.removeAt(pages.lastIndex) }
            tab == Tab.Home -> HomeScreen(vm, bottom, open)
            tab == Tab.Menu -> MenuScreen(s?.user, bottom, open) { vm.logout() }
            tab == Tab.Rules -> com.nexlogic.tradelock.ui.screens.RulesScreen(vm, bottom)
            tab == Tab.Algo -> com.nexlogic.tradelock.ui.screens.AlgoScreen(vm, bottom, open)
            tab == Tab.Scalper -> com.nexlogic.tradelock.ui.screens.ScalperScreen(vm, bottom)
            else -> WebPage(tab.web!!, bottom) { tab = Tab.Home }
        }
        if (pages.isEmpty()) BottomBar(tab, Modifier.align(Alignment.BottomCenter)) { tab = it }
    }
}

@Composable
private fun BottomBar(current: Tab, modifier: Modifier, onSelect: (Tab) -> Unit) {
    Box(modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth()
                .background(Brush.verticalGradient(0f to Color(0x0006080C), 0.22f to Tl.bg, 1f to Tl.bg))
                .navigationBarsPadding()
                .padding(start = 12.dp, end = 12.dp, top = 18.dp, bottom = 8.dp),
            horizontalArrangement = Arrangement.SpaceAround,
            verticalAlignment = Alignment.Bottom,
        ) {
            Tab.entries.forEach { t ->
                if (t == Tab.Scalper) {
                    // The raised centre key.
                    Column(Modifier.weight(1f).tactile({ onSelect(t) }), horizontalAlignment = Alignment.CenterHorizontally) {
                        Box(
                            Modifier.offset(y = (-6).dp).size(60.dp).shadow(22.dp, CircleShape, spotColor = Tl.mint)
                                .clip(CircleShape).background(Tl.mintBrush).border(4.dp, Tl.bg, CircleShape),
                            contentAlignment = Alignment.Center,
                        ) { Icon(t.icon, null, tint = Color(0xFF04261F), modifier = Modifier.size(28.dp)) }
                        Text(t.label, style = TlType.small.copy(fontWeight = FontWeight.Bold, fontSize = 12.sp), color = if (current == t) Tl.mint else Tl.text)
                    }
                } else {
                    val on = current == t
                    Column(
                        Modifier.weight(1f).tactile({ onSelect(t) }).clip(RoundedCornerShape(16.dp))
                            .background(if (on) Tl.mint.copy(alpha = 0.10f) else Color.Transparent).padding(vertical = 8.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Icon(t.icon, null, tint = if (on) Tl.mint else Tl.muted, modifier = Modifier.size(24.dp))
                        Spacer(Modifier.height(4.dp))
                        Text(t.label, style = TlType.small.copy(fontWeight = FontWeight.SemiBold, fontSize = 12.sp), color = if (on) Tl.mint else Tl.muted)
                    }
                }
            }
        }
    }
}

/** Toasts slide down from the top and leave after a few seconds. */
@Composable
private fun ToastHost(vm: AppViewModel) {
    var current by remember { mutableStateOf<Toast?>(null) }
    LaunchedEffect(Unit) {
        vm.toasts.collect { t -> current = t; delay(3200); if (current == t) current = null }
    }
    Box(Modifier.fillMaxWidth().statusBarsPadding().padding(12.dp), contentAlignment = Alignment.TopCenter) {
        AnimatedVisibility(current != null, enter = slideInVertically { -it } + fadeIn(), exit = slideOutVertically { -it } + fadeOut()) {
            val t = current ?: return@AnimatedVisibility
            val c = when (t.tone) { Toast.Tone.Ok -> Tl.mint; Toast.Tone.Warn -> Tl.amber; Toast.Tone.Error -> Tl.red }
            Row(
                Modifier.fillMaxWidth().shadow(20.dp, RoundedCornerShape(16.dp)).clip(RoundedCornerShape(16.dp)).background(Tl.raised)
                    .border(1.dp, c.copy(alpha = 0.5f), RoundedCornerShape(16.dp)).padding(horizontal = 16.dp, vertical = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.size(8.dp).clip(CircleShape).background(c))
                Spacer(Modifier.width(12.dp))
                Text(t.text, style = TlType.body, color = Tl.text)
            }
        }
    }
}
