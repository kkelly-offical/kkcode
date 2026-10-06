package cn.kkcode.remote

import androidx.compose.foundation.Image
import androidx.compose.animation.core.*
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay

@Composable internal fun PixelBuddy(size: Dp = 40.dp, palette: String = "mint", mood: String = "idle", motion: Boolean = false) {
    val art = when(palette) { "amber" -> R.drawable.pixel_buddy_amber; "iris" -> R.drawable.pixel_buddy_iris; else -> R.drawable.pixel_buddy_mint }
    val moving = motion && mood !in listOf("stopping", "stopped", "readonly", "error")
    val phase = if(moving) {
        val animation = rememberInfiniteTransition(label = "kiki-$mood")
        val frame by animation.animateFloat(0f, 1f, infiniteRepeatable(tween(if(mood in listOf("working", "complete", "writing")) 480 else 1300, easing = FastOutSlowInEasing), RepeatMode.Reverse), label = "kiki-frame")
        frame
    } else .5f
    val tone = MaterialTheme.colorScheme.primary
    Box(Modifier.width(size * 1.25f).height(size * 1.25f).testTag("buddy-$mood"), contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val unit = this.size.width / 16f
            drawRect(tone.copy(alpha = .13f), Offset(unit * 4, unit * 14), Size(unit * (8 - phase), unit))
            if(mood in listOf("thinking", "complete")) {
                val dx = if(phase > .5f) 12f else 1f
                drawRect(tone.copy(alpha = .9f), Offset(unit * dx, unit * (2 + phase * 2)), Size(unit * 2, unit))
                drawRect(tone.copy(alpha = .9f), Offset(unit * (dx + .5f), unit * (1.5f + phase * 2)), Size(unit, unit * 2))
            }
        }
        Image(painterResource(art), null, Modifier.width(size).height(size * 1.1f).graphicsLayer {
            translationY = when(mood) { "working", "writing" -> -phase * 3.dp.toPx(); "complete" -> -phase * 7.dp.toPx(); "idle", "offline" -> -phase * 2.dp.toPx(); else -> 0f }
            rotationZ = when(mood) { "thinking", "waiting" -> (phase - .5f) * 10f; "approval" -> (phase - .5f) * 6f; "error" -> -7f; else -> 0f }
            scaleY = if(mood == "working") .96f + phase * .04f else 1f
            alpha = if(mood == "offline") .55f else 1f
        })
        val symbol = when(mood) { "approval" -> "!"; "offline", "stopped" -> "z"; "waiting" -> "···"; "working", "writing" -> if(phase > .5f) "▰" else "▪"; "error" -> "?"; else -> "" }
        if(symbol.isNotBlank()) Text(symbol, color = tone, fontFamily = FontFamily.Monospace, fontSize = 9.sp, modifier = Modifier.align(Alignment.TopEnd))
    }
}

@Composable internal fun PixelWorkshop() {
    Image(painterResource(R.drawable.pixel_studio), null, Modifier.widthIn(max = 280.dp).fillMaxWidth().aspectRatio(256f / 120f))
    Text("A LITTLE SPACE FOR BIG IDEAS", fontFamily = FontFamily.Monospace, fontSize = 8.sp, letterSpacing = 1.sp, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 12.dp, bottom = 24.dp))
}

/** Status is derived from the session; the companion never submits prompts or accepts work. */
@Composable internal fun StudioTools(state: RemoteState, modifier: Modifier = Modifier, shortcuts: Boolean = true) {
    val context = LocalContext.current
    val preferences = remember { context.getSharedPreferences("kkcode.studio", android.content.Context.MODE_PRIVATE) }
    var palette by remember { mutableStateOf(preferences.getString("palette", "mint") ?: "mint") }
    var compact by remember { mutableStateOf(preferences.getBoolean("compact", false)) }
    var motion by remember { mutableStateOf(preferences.getBoolean("motion", true)) }
    DisposableEffect(preferences) {
        val listener = android.content.SharedPreferences.OnSharedPreferenceChangeListener { prefs, _ ->
            palette = prefs.getString("palette", "mint") ?: "mint"
            compact = prefs.getBoolean("compact", false)
            motion = prefs.getBoolean("motion", true)
        }
        preferences.registerOnSharedPreferenceChangeListener(listener)
        onDispose { preferences.unregisterOnSharedPreferenceChangeListener(listener) }
    }
    var show by remember { mutableStateOf(false) }
    var wasBusy by remember(state.selected) { mutableStateOf(false) }
    var celebrate by remember(state.selected) { mutableStateOf(false) }
    LaunchedEffect(state.selected, state.busy, state.lastTurnOutcome) {
        if(state.busy) { wasBusy = true; celebrate = false }
        else if(wasBusy) { wasBusy = false; celebrate = state.lastTurnOutcome == "completed"; if(celebrate) { delay(2600); celebrate = false } }
    }
    val mood = companionMood(state.connected, state.stopping, state.approvals.isNotEmpty(), state.busy, state.turnPhase, state.messages.lastOrNull { !it.done }?.kind.orEmpty(), !state.canControl || state.sessionArchived, state.lastTurnOutcome, celebrate)
    val label = companionLabel(mood)
    val systemMotion = android.provider.Settings.Global.getFloat(context.contentResolver, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f) > 0f
    Row(modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        Row(Modifier.weight(1f).clickable(onClickLabel = "像素伙伴") { show = true }.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            if(!compact) { PixelBuddy(32.dp, palette, mood, motion && systemMotion); Spacer(Modifier.width(8.dp)) }
            Column(Modifier.weight(1f)) {
                if(shortcuts) Text("KIKI / CODE COMPANION", fontFamily = FontFamily.Monospace, fontSize = 7.sp, letterSpacing = .5.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                Text(label, fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Icon(Icons.Outlined.ExpandMore, "像素伙伴", Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if(shortcuts) {
            IconButton(onClick = { state.sheet = "subagents" }, enabled = state.connected, modifier = Modifier.size(42.dp)) { Icon(Icons.Outlined.Groups, "打开子代理", Modifier.size(18.dp), tint = MaterialTheme.colorScheme.primary) }
            IconButton(onClick = { state.sheet = "artifacts" }, enabled = state.connected, modifier = Modifier.size(42.dp)) { Icon(Icons.Outlined.FolderOpen, "打开产物", Modifier.size(18.dp), tint = MaterialTheme.colorScheme.primary) }
        }
    }
    if(show) AlertDialog(onDismissRequest = { show = false }, shape = PixelShape(8.dp), containerColor = MaterialTheme.colorScheme.surface, title = {
        Row(verticalAlignment = Alignment.CenterVertically) { PixelBuddy(48.dp, palette, mood, motion && systemMotion); Spacer(Modifier.width(12.dp)); Column { Text("你好，我是 KIKI。", fontSize = 17.sp, fontWeight = FontWeight.Medium); Text(label, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant) } }
    }, text = {
        Column {
            listOf("了解项目" to "梳理项目结构，说明主要模块与入口。", "审查改动" to "审查当前改动，优先指出缺陷和验证缺口。", "规划下一步" to "根据当前目标，制定可执行的开发计划。").forEach { (title, prompt) ->
                TextButton(onClick = { state.draft = if(state.draft.isBlank()) prompt else "${state.draft}\n\n$prompt"; show = false }, enabled = state.connected && state.canControl && !state.sessionArchived, modifier = Modifier.fillMaxWidth()) { Text(title); Spacer(Modifier.weight(1f)); Icon(Icons.Outlined.ChevronRight, null, Modifier.size(16.dp)) }
            }
            Text("提示填入输入框，由你确认后发送。", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                listOf("mint" to "薄荷", "amber" to "琥珀", "iris" to "鸢尾").forEach { (id, title) ->
                    FilterChip(selected = palette == id, onClick = { palette = id; preferences.edit().putString("palette", id).apply() }, label = { Text(title, fontSize = 12.sp) })
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(compact, { compact = it; preferences.edit().putBoolean("compact", it).apply() }); Text("收起玩偶，保留状态", fontSize = 12.sp) }
            Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(motion, { motion = it; preferences.edit().putBoolean("motion", it).apply() }); Text("状态动作（遵循系统动画设置）", fontSize = 12.sp) }
        }
    }, confirmButton = { TextButton(onClick = { show = false }) { Text("继续创作") } })
}
