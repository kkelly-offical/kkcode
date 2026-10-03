package cn.kkcode.remote

import androidx.compose.foundation.Image
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
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable internal fun PixelBuddy(size: Dp = 40.dp, palette: String = "mint") {
    val art = when(palette) { "amber" -> R.drawable.pixel_buddy_amber; "iris" -> R.drawable.pixel_buddy_iris; else -> R.drawable.pixel_buddy_mint }
    Image(painterResource(art), null, Modifier.width(size).height(size * 1.1f))
}

@Composable internal fun PixelWorkshop() {
    Image(painterResource(R.drawable.pixel_studio), null, Modifier.widthIn(max = 280.dp).fillMaxWidth().aspectRatio(256f / 120f))
    Text("A LITTLE SPACE FOR BIG IDEAS", fontFamily = FontFamily.Monospace, fontSize = 8.sp, letterSpacing = 1.sp, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 12.dp, bottom = 24.dp))
}

/** Status is derived from the session; the companion never submits prompts or accepts work. */
@Composable internal fun StudioTools(state: RemoteState) {
    val context = LocalContext.current
    val preferences = remember { context.getSharedPreferences("kkcode.studio", android.content.Context.MODE_PRIVATE) }
    var palette by remember { mutableStateOf(preferences.getString("palette", "mint") ?: "mint") }
    var compact by remember { mutableStateOf(preferences.getBoolean("compact", false)) }
    var show by remember { mutableStateOf(false) }
    val label = when {
        !state.connected -> "等待连接"
        state.stopping -> "正在停止"
        state.approvals.isNotEmpty() -> "等待你的确认"
        state.busy -> "正在工作"
        !state.canControl || state.sessionArchived -> "只读陪伴"
        else -> "准备好，一起开工"
    }
    Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        Row(Modifier.weight(1f).clickable(onClickLabel = "像素伙伴") { show = true }.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            if(!compact) { PixelBuddy(30.dp, palette); Spacer(Modifier.width(8.dp)) }
            Column(Modifier.weight(1f)) {
                Text("KIKI / CODE COMPANION", fontFamily = FontFamily.Monospace, fontSize = 7.sp, letterSpacing = .5.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                Text(label, fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Icon(Icons.Outlined.ExpandMore, "像素伙伴", Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        IconButton(onClick = { state.sheet = "tasks" }, enabled = state.connected, modifier = Modifier.size(42.dp)) { Icon(Icons.Outlined.Checklist, "打开任务", Modifier.size(18.dp), tint = MaterialTheme.colorScheme.primary) }
        IconButton(onClick = { state.sheet = "artifacts" }, enabled = state.connected, modifier = Modifier.size(42.dp)) { Icon(Icons.Outlined.FolderOpen, "打开产物", Modifier.size(18.dp), tint = MaterialTheme.colorScheme.primary) }
    }
    if(show) AlertDialog(onDismissRequest = { show = false }, shape = PixelShape(8.dp), containerColor = MaterialTheme.colorScheme.surface, title = {
        Row(verticalAlignment = Alignment.CenterVertically) { PixelBuddy(42.dp, palette); Spacer(Modifier.width(12.dp)); Column { Text("你好，我是 KIKI。", fontSize = 17.sp, fontWeight = FontWeight.Medium); Text("陪你专注，也帮你找到下一步。", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant) } }
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
        }
    }, confirmButton = { TextButton(onClick = { show = false }) { Text("继续创作") } })
}
