package com.nexlogic.tradelock.ui

import androidx.compose.ui.unit.IntOffset
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
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

    // Close only the page that asked (the outgoing page can still take a tap while it animates away).
    val closeTop: (String?) -> Unit = { p -> if (p != null && pages.lastOrNull() == p) pages.removeAt(pages.lastIndex) }
    val dest = pages.lastOrNull() ?: "tab:${tab.name}"
    Box(Modifier.fillMaxSize()) {
        AnimatedContent(
            targetState = dest to pages.size,
            transitionSpec = {
                val (from, to) = initialState.second to targetState.second
                val ease = FastOutSlowInEasing
                when {
                    // A page opens: it glides in from the right over a gently receding screen.
                    to > from -> (slideInHorizontally(tween(340, easing = ease)) { it / 4 } + fadeIn(tween(260))) togetherWith
                        (scaleOut(tween(300), targetScale = 0.96f) + fadeOut(tween(220)))
                    // Back: the page slides away to the right, the screen under it settles forward.
                    to < from -> (scaleIn(tween(300), initialScale = 0.96f) + fadeIn(tween(240))) togetherWith
                        (slideOutHorizontally(tween(280, easing = ease)) { it / 4 } + fadeOut(tween(220)))
                    // Tabs: a soft cross-fade with a slight lift.
                    else -> (fadeIn(tween(260)) + scaleIn(tween(260), initialScale = 0.985f)) togetherWith fadeOut(tween(160))
                }
            },
            label = "nav",
        ) { (d, _) ->
        val page = d.takeUnless { it.startsWith("tab:") }
        val t = if (page == null) Tab.valueOf(d.removePrefix("tab:")) else tab
        when {
            page == "alarm" -> com.nexlogic.tradelock.ui.screens.AlarmScreen(vm) { closeTop(page) }
            page == "wallet" -> com.nexlogic.tradelock.ui.screens.WalletScreen(vm, { closeTop(page) }, open)
            page == "billing" -> com.nexlogic.tradelock.ui.screens.SubscriptionScreen(vm, { closeTop(page) }, open)
            page == "calendar" -> com.nexlogic.tradelock.ui.screens.CalendarScreen(vm) { closeTop(page) }
            page == "settings" -> com.nexlogic.tradelock.ui.screens.SettingsScreen(vm, { closeTop(page) }, open)
            page == "journal" -> com.nexlogic.tradelock.ui.screens.JournalScreen(vm) { closeTop(page) }
            page == "analytics" -> com.nexlogic.tradelock.ui.screens.AnalyticsScreen(vm) { closeTop(page) }
            page == "affiliate" -> com.nexlogic.tradelock.ui.screens.AffiliateScreen(vm) { closeTop(page) }
            page == "profile" -> com.nexlogic.tradelock.ui.screens.ProfileScreen(vm, { closeTop(page) }, open)
            page == "strategy" -> com.nexlogic.tradelock.ui.screens.StrategyScreen(vm, { closeTop(page) }, open)
            page == "backtest" -> com.nexlogic.tradelock.ui.screens.BacktestScreen(vm, { closeTop(page) }, open)
            page == "qrlogin" -> com.nexlogic.tradelock.ui.screens.QrLoginScreen(vm) { closeTop(page) }
            page == "alerts" -> com.nexlogic.tradelock.ui.screens.NotificationsScreen(vm) { closeTop(page) }
            page == "brokers" -> com.nexlogic.tradelock.ui.screens.BrokerScreen(vm, { closeTop(page) }, open)
            page != null -> WebPage(page, PaddingValues(0.dp)) { closeTop(page) }
            t == Tab.Home -> HomeScreen(vm, bottom, open)
            t == Tab.Menu -> MenuScreen(s?.user, bottom, open) { vm.logout() }
            t == Tab.Rules -> com.nexlogic.tradelock.ui.screens.RulesScreen(vm, bottom)
            t == Tab.Algo -> com.nexlogic.tradelock.ui.screens.AlgoScreen(vm, bottom, open)
            // Full screen: no tab bar (its ✕ returns Home), the phone's bars hidden while it is open.
            t == Tab.Scalper -> com.nexlogic.tradelock.ui.screens.ScalperScreen(vm, PaddingValues(0.dp)) { tab = Tab.Home }
            else -> WebPage(t.web!!, bottom) { tab = Tab.Home }
        }
        }
        if (pages.isEmpty() && tab != Tab.Scalper) BottomBar(tab, Modifier.align(Alignment.BottomCenter)) { tab = it }
    }
}

@Composable
private fun BottomBar(current: Tab, modifier: Modifier, onSelect: (Tab) -> Unit) {
    // A floating glass dock over a fade, so content scrolls away under it.
    Box(
        modifier.fillMaxWidth()
            .background(Brush.verticalGradient(0f to Color(0x0006080C), 0.35f to Tl.bg.copy(alpha = 0.92f), 1f to Tl.bg))
            .navigationBarsPadding()
            .padding(start = 12.dp, end = 12.dp, top = 14.dp, bottom = 8.dp),
    ) {
        val dock = RoundedCornerShape(26.dp)
        // The capsule is its own layer, so the raised centre key is not clipped by it.
        Box(Modifier.matchParentSize().padding(top = 6.dp).shadow(24.dp, dock).clip(dock).background(Tl.glass).border(1.dp, Tl.edgeOff, dock))
        Row(Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 6.dp), horizontalArrangement = Arrangement.SpaceAround, verticalAlignment = Alignment.Bottom) {
            Tab.entries.forEach { t ->
                val on = current == t
                if (t == Tab.Scalper) {
                    // The raised centre key, with a glow that breathes.
                    val glow by rememberInfiniteTransition(label = "key").animateFloat(14f, 26f, infiniteRepeatable(tween(1600), RepeatMode.Reverse), label = "glow")
                    Column(Modifier.weight(1f).tactile({ onSelect(t) }), horizontalAlignment = Alignment.CenterHorizontally) {
                        Box(
                            Modifier.offset(y = (-10).dp).size(58.dp).shadow(glow.dp, CircleShape, spotColor = Tl.mint, ambientColor = Tl.mint)
                                .clip(CircleShape).background(Tl.mintBrush).border(3.dp, Tl.bg, CircleShape),
                            contentAlignment = Alignment.Center,
                        ) { Icon(t.icon, null, tint = Color(0xFF04261F), modifier = Modifier.size(27.dp)) }
                        Text(t.label, style = TlType.small.copy(fontWeight = FontWeight.Bold, fontSize = 11.5.sp), color = if (on) Tl.mint else Tl.text, modifier = Modifier.offset(y = (-4).dp))
                    }
                } else {
                    val bg by animateColorAsState(if (on) Tl.mint.copy(alpha = 0.12f) else Color.Transparent, tween(220), label = "tabbg")
                    val tint by animateColorAsState(if (on) Tl.mint else Tl.muted, tween(220), label = "tabtint")
                    val lift by animateDpAsState(if (on) (-2).dp else 0.dp, spring(dampingRatio = 0.6f), label = "lift")
                    Column(
                        Modifier.weight(1f).tactile({ onSelect(t) }).clip(RoundedCornerShape(18.dp)).background(bg).padding(vertical = 8.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Icon(t.icon, null, tint = tint, modifier = Modifier.offset { IntOffset(0, lift.roundToPx()) }.size(23.dp))
                        Spacer(Modifier.height(3.dp))
                        Text(t.label, style = TlType.small.copy(fontWeight = FontWeight.SemiBold, fontSize = 11.5.sp), color = tint)
                        // A short glowing bar under the active tab.
                        Box(Modifier.padding(top = 3.dp).size(width = if (on) 16.dp else 0.dp, height = 2.dp).clip(CircleShape).background(Tl.mint))
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
                Modifier.fillMaxWidth().shadow(20.dp, RoundedCornerShape(16.dp)).clip(RoundedCornerShape(16.dp)).background(Tl.glass)
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
