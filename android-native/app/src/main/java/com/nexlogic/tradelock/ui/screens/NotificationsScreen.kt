package com.nexlogic.tradelock.ui.screens

import com.nexlogic.tradelock.ui.components.ambient
import androidx.activity.compose.BackHandler
import androidx.compose.animation.animateContentSize
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
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.DeleteOutline
import androidx.compose.material.icons.rounded.NotificationsNone
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.nexlogic.tradelock.data.Api
import com.nexlogic.tradelock.data.ApiError
import com.nexlogic.tradelock.data.AppViewModel
import com.nexlogic.tradelock.data.arr
import com.nexlogic.tradelock.data.bool
import com.nexlogic.tradelock.data.long
import com.nexlogic.tradelock.data.str
import com.nexlogic.tradelock.ui.ago
import com.nexlogic.tradelock.ui.components.tactile
import com.nexlogic.tradelock.ui.theme.Tl
import com.nexlogic.tradelock.ui.theme.TlType
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private data class Note(val id: Long, val kind: String, val level: String, val title: String, val body: String, val read: Boolean, val at: Long)
private val FILTERS = listOf(null to "All", "risk" to "Risk", "broker" to "Broker", "billing" to "Billing")

private fun toneOf(level: String) = when (level) { "critical" -> Tl.red; "warn" -> Tl.amber; "ok" -> Tl.mint; else -> Color(0xFF5AA9FF) }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NotificationsScreen(vm: AppViewModel, onBack: () -> Unit) {
    BackHandler { onBack() }
    val items = remember { mutableStateListOf<Note>() }
    var kind by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(kind) {
        loading = true
        try {
            val r = Api.get("/notifications" + (kind?.let { "?kind=$it" } ?: ""))
            items.clear()
            items.addAll(r.arr("items").mapNotNull { it as? JsonObject }.map {
                Note(it.long("id") ?: 0, it.str("kind") ?: "", it.str("level") ?: "info", it.str("title") ?: "", it.str("body") ?: "", it.bool("read") == true, it.long("createdAt") ?: 0)
            })
            error = null
        } catch (e: ApiError) { error = e.message }
        loading = false
    }
    fun markRead(ids: List<Long>?) = scope.launch {
        runCatching {
            Api.post("/notifications/read", buildJsonObject { if (ids == null) put("ids", "all") else put("ids", buildJsonArray { ids.forEach { add(JsonPrimitive(it)) } }) })
        }.onSuccess { r -> vm.setUnread(r["unread"]?.toString()?.toIntOrNull() ?: 0) }
        items.replaceAll { if (ids == null || it.id in ids) it.copy(read = true) else it }
    }

    Column(Modifier.fillMaxSize().ambient().statusBarsPadding()) {
        Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(44.dp).tactile(onBack).clip(RoundedCornerShape(14.dp)).background(Tl.glass).border(1.dp, Tl.edgeOff, RoundedCornerShape(14.dp)), contentAlignment = Alignment.Center) {
                Icon(Icons.AutoMirrored.Rounded.ArrowBack, null, tint = Tl.text)
            }
            Spacer(Modifier.width(12.dp))
            Text("Notifications", style = TlType.page, modifier = Modifier.weight(1f))
            if (items.any { !it.read }) Text("Read all", style = TlType.label, color = Tl.mint, modifier = Modifier.tactile({ markRead(null) }).padding(8.dp))
        }
        Row(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FILTERS.forEach { (k, label) ->
                val on = k == kind
                Box(Modifier.tactile({ kind = k }).clip(CircleShape).background(if (on) Tl.mint.copy(alpha = 0.14f) else Tl.surface)
                    .border(1.dp, if (on) Tl.mint.copy(alpha = 0.6f) else Tl.lineHi, CircleShape).padding(horizontal = 14.dp, vertical = 7.dp)) {
                    Text(label, style = TlType.small.copy(fontWeight = FontWeight.SemiBold, fontSize = 13.sp), color = if (on) Tl.mint else Tl.muted)
                }
            }
        }
        when {
            loading && items.isEmpty() -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = Tl.mint) }
            error != null -> Text(error!!, style = TlType.body, color = Tl.red, modifier = Modifier.padding(16.dp))
            items.isEmpty() -> Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                Icon(Icons.Rounded.NotificationsNone, null, tint = Tl.dim, modifier = Modifier.size(48.dp))
                Spacer(Modifier.size(10.dp))
                Text("You're all caught up", style = TlType.label, color = Tl.muted)
            }
            else -> LazyColumn(
                Modifier.fillMaxSize().navigationBarsPadding(),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(items, key = { it.id }) { n ->
                    // Swipe left to delete.
                    val state = rememberSwipeToDismissBoxState(confirmValueChange = { v ->
                        if (v == SwipeToDismissBoxValue.EndToStart) {
                            scope.launch {
                                runCatching { Api.post("/notifications/delete", buildJsonObject { put("id", n.id) }) }
                                    .onSuccess { r -> vm.setUnread(r["unread"]?.toString()?.toIntOrNull() ?: 0) }
                                items.remove(n)
                            }
                            true
                        } else false
                    })
                    SwipeToDismissBox(
                        state = state, enableDismissFromStartToEnd = false,
                        backgroundContent = {
                            Box(Modifier.fillMaxSize().clip(RoundedCornerShape(18.dp)).background(Tl.red.copy(alpha = 0.2f)).padding(end = 20.dp), contentAlignment = Alignment.CenterEnd) {
                                Icon(Icons.Rounded.DeleteOutline, null, tint = Tl.red)
                            }
                        },
                    ) {
                        val tone = toneOf(n.level)
                        Row(
                            Modifier.fillMaxWidth().animateContentSize().clip(RoundedCornerShape(18.dp)).background(if (n.read) Tl.surface else Tl.surfaceHi)
                                .border(1.dp, if (n.read) Tl.line else tone.copy(alpha = 0.35f), RoundedCornerShape(18.dp))
                                .tactile({ if (!n.read) markRead(listOf(n.id)) }, haptic = false).padding(14.dp),
                        ) {
                            Box(Modifier.padding(top = 6.dp).size(8.dp).clip(CircleShape).background(if (n.read) Tl.dim else tone))
                            Spacer(Modifier.width(12.dp))
                            Column(Modifier.weight(1f)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(n.title, style = TlType.label, color = Tl.text, modifier = Modifier.weight(1f))
                                    Text(ago(n.at), style = TlType.small.copy(fontSize = 11.sp), color = Tl.dim)
                                }
                                if (n.body.isNotBlank()) { Spacer(Modifier.size(3.dp)); Text(n.body, style = TlType.small.copy(fontSize = 13.sp), color = Tl.muted) }
                                Spacer(Modifier.size(6.dp))
                                Text(n.kind.uppercase(), style = TlType.eyebrow.copy(fontSize = 9.sp), color = tone.copy(alpha = 0.8f))
                            }
                        }
                    }
                }
            }
        }
    }
}
