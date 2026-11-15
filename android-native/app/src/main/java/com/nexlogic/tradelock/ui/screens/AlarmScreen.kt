package com.nexlogic.tradelock.ui.screens

import android.app.Activity
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.AlarmOn
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleResumeEffect
import com.nexlogic.tradelock.alarm.AlarmCenter
import com.nexlogic.tradelock.data.AppViewModel
import com.nexlogic.tradelock.ui.components.Dot
import com.nexlogic.tradelock.ui.components.Eyebrow
import com.nexlogic.tradelock.ui.components.TlCard
import com.nexlogic.tradelock.ui.components.tactile
import com.nexlogic.tradelock.ui.theme.Tl
import com.nexlogic.tradelock.ui.theme.TlType

/** Re-read the phone's permissions each time the screen comes back (from a system settings page). */
@Composable
fun rememberAlarmNeeds(): List<AlarmCenter.Need> {
    val c = LocalContext.current
    var tick by remember { mutableIntStateOf(0) }
    LifecycleResumeEffect(Unit) { tick++; onPauseOrDispose { } }
    return remember(tick) { AlarmCenter.needs(c) }
}

/** The phone alarm: what it rings for, what the phone still has to allow, and a test ring. */
@Composable
fun AlarmScreen(vm: AppViewModel, onBack: () -> Unit) {
    BackHandler { onBack() }
    val c = LocalContext.current
    val needs = rememberAlarmNeeds()
    val dash by vm.dash.collectAsState()
    val missing = needs.filterNot { it.ok }
    val watching = AlarmCenter.running(c)

    Column(Modifier.fillMaxSize().background(Tl.bg).statusBarsPadding().navigationBarsPadding().verticalScroll(rememberScrollState()).padding(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(44.dp).tactile(onBack).clip(RoundedCornerShape(14.dp)).background(Tl.surface), contentAlignment = Alignment.Center) {
                Icon(Icons.AutoMirrored.Rounded.ArrowBack, null, tint = Tl.text)
            }
            Spacer(Modifier.width(12.dp))
            Text("Trade alarm", fontSize = 26.sp, fontWeight = FontWeight.ExtraBold, color = Tl.text)
        }
        Spacer(Modifier.height(16.dp))
        TlCard(Modifier.fillMaxWidth(), padding = 20.dp) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(52.dp).clip(RoundedCornerShape(16.dp)).background(Tl.amber.copy(alpha = 0.16f)), contentAlignment = Alignment.Center) {
                    Icon(Icons.Rounded.AlarmOn, null, tint = Tl.amber, modifier = Modifier.size(26.dp))
                }
                Spacer(Modifier.width(14.dp))
                Column(Modifier.weight(1f)) {
                    Text(if (missing.isEmpty()) "Ready" else "${missing.size} permission${if (missing.size > 1) "s" else ""} left", style = TlType.title, color = Tl.text)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Dot(if (watching) Tl.mint else Tl.dim, 7.dp); Spacer(Modifier.width(6.dp))
                        Text(if (watching) "WATCHING" else "OFF", style = TlType.eyebrow, color = if (watching) Tl.mint else Tl.dim)
                    }
                }
            }
            Spacer(Modifier.height(12.dp))
            Text("The phone rings like an alarm clock, full screen and through silent and Do Not Disturb, for every Algo Trading entry and when a price alert reaches its level, even with the app closed. " +
                "It watches while Algo Trading is on or a price alert is waiting${if (dash?.broker?.algoOn == true || dash?.alerts?.isNotEmpty() == true) " (now)" else ""}, during market hours.",
                style = TlType.body, color = Tl.muted)
        }
        Spacer(Modifier.height(16.dp))
        Eyebrow("The phone must allow", Modifier.padding(start = 4.dp, bottom = 10.dp))
        TlCard(Modifier.fillMaxWidth(), padding = 8.dp) {
            needs.forEachIndexed { i, n ->
                Row(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(if (n.ok) Icons.Rounded.CheckCircle else Icons.Rounded.ErrorOutline, null, tint = if (n.ok) Tl.mint else Tl.amber, modifier = Modifier.size(22.dp))
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text(n.title, style = TlType.label, color = Tl.text)
                        Text(n.detail, style = TlType.small, color = Tl.muted)
                    }
                    Text(if (n.ok) "Allowed" else "Needed", style = TlType.eyebrow.copy(fontSize = 10.sp), color = if (n.ok) Tl.mint else Tl.amber)
                }
                if (i < needs.lastIndex) Box(Modifier.fillMaxWidth().padding(start = 44.dp).height(1.dp).background(Tl.line))
            }
        }
        Spacer(Modifier.height(18.dp))
        if (missing.isNotEmpty()) {
            PrimaryButton("Allow ${missing.first().title.lowercase()}") { (c as? Activity)?.let(AlarmCenter::askNext) }
            Spacer(Modifier.height(10.dp))
        }
        GhostButton("Test alarm", Modifier.fillMaxWidth()) { AlarmCenter.test(c) }
    }
}

/** Home: a slim banner while the alarm is wanted but the phone hasn't allowed everything. */
@Composable
fun AlarmBanner(vm: AppViewModel, onOpen: () -> Unit) {
    val dash by vm.dash.collectAsState()
    val want = dash?.broker?.algoOn == true || dash?.alerts?.isNotEmpty() == true
    val missing = rememberAlarmNeeds().filterNot { it.ok }
    if (!want || missing.isEmpty()) return
    Row(
        Modifier.fillMaxWidth().tactile(onOpen).clip(RoundedCornerShape(16.dp)).background(Tl.amber.copy(alpha = 0.10f))
            .border(1.dp, Tl.amber.copy(alpha = 0.45f), RoundedCornerShape(16.dp)).padding(14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Rounded.AlarmOn, null, tint = Tl.amber, modifier = Modifier.size(22.dp))
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text("Trade alarm: ${missing.size} permission${if (missing.size > 1) "s" else ""} left", style = TlType.label, color = Tl.amber)
            Text("Allow ${missing.joinToString(", ") { it.title.lowercase() }} so it rings with the app closed.", style = TlType.small, color = Tl.muted)
        }
        Spacer(Modifier.width(8.dp))
        Text("Fix", style = TlType.label, color = Tl.amber)
    }
}
