package cn.kkcode.remote

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.json.JSONObject
import java.util.Locale

internal fun projectPathKey(value: String): String {
    val windows = Regex("^[a-zA-Z]:[\\\\/]").containsMatchIn(value) || value.startsWith("\\\\")
    return if(windows) value.replace('\\', '/').trimEnd('/').lowercase(Locale.ROOT) else if(value == "/") value else value.trimEnd('/')
}
internal fun projectName(value: String): String = value.trimEnd('/', '\\').split('/', '\\').lastOrNull().orEmpty().ifBlank { value.ifBlank { "全部项目" } }
internal fun projectSessions(items: List<JSONObject>, path: String): List<JSONObject> = if(path.isBlank()) items else items.filter { projectPathKey(it.optString("cwd")) == projectPathKey(path) }
internal data class ReadingPosition(val key: String?, val index: Int, val offset: Int, val following: Boolean)

@Composable internal fun ProjectsSheet(state: RemoteState) {
    var query by remember { mutableStateOf("") }
    val paths = (listOf(state.cwd) + state.sessions.map { it.optString("cwd") }).filter { it.isNotBlank() }.distinctBy(::projectPathKey)
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        OutlinedTextField(query, { query = it }, label = { Text("搜索项目名或完整路径") }, leadingIcon = { Icon(Icons.Outlined.Search, null) }, singleLine = true, modifier = Modifier.fillMaxWidth())
        Text("${state.deviceName} · 当前设备", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        TextButton(onClick = { state.projectFilter = ""; state.sheet = "" }) { Text("显示全部项目的对话") }
        paths.filter { it.contains(query, ignoreCase = true) }.forEach { path ->
            val selected = projectPathKey(path) == projectPathKey(state.projectFilter)
            Row(Modifier.fillMaxWidth().background(if(selected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surface, RoundedCornerShape(12.dp)).clickable(enabled = !state.uploading) { state.chooseProject(path) }.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.FolderOpen, null, tint = if(selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) { Text(projectName(path), fontSize = 15.sp, fontWeight = FontWeight.Medium); Text(path, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp)); Text("${projectSessions(state.sessions, path).count { !it.optBoolean("archived") }} 个对话", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                if(selected) Icon(Icons.Outlined.Check, null, tint = MaterialTheme.colorScheme.primary)
            }
        }
        if(!state.sharedDevice) OutlinedButton(onClick = { state.browse() }, enabled = state.connected && !state.uploading, modifier = Modifier.fillMaxWidth()) { Text("选择其他文件夹") }
    }
}

/** Expand only the presentation group that contains the requested message. */
internal fun revealHistoryPath(items: List<ChatItem>, target: String): List<ChatItem> {
    if(target.isBlank()) return items
    fun contains(item: ChatItem): Boolean = item.id == target || item.children.any(::contains)
    return items.flatMap { if(it.kind in listOf("run-summary", "compacted-history") && it.children.any(::contains)) revealHistoryPath(it.children, target) else listOf(it) }
}

@Composable internal fun HistorySheet(state: RemoteState) {
    var query by remember(state.selected) { mutableStateOf("") }
    val messages = state.messages.filter { it.kind in listOf("user", "assistant") && it.text.contains(query, ignoreCase = true) }.takeLast(100).reversed()
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        OutlinedTextField(query, { query = it }, label = { Text("查找对话记录") }, leadingIcon = { Icon(Icons.Outlined.Search, null) }, singleLine = true, modifier = Modifier.fillMaxWidth())
        Text("当前对话 · 已加载记录", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        messages.forEach { item ->
            Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(12.dp)).clickable { state.historyTarget = item.id; state.sheet = "" }.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(if(item.kind == "user") "你" else "智能体", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                val start = if(query.isBlank()) 0 else (item.text.indexOf(query, ignoreCase = true) - 30).coerceAtLeast(0)
                Text(item.text.drop(start).take(180), fontSize = 14.sp, maxLines = 4, overflow = TextOverflow.Ellipsis)
            }
        }
        if(messages.isEmpty()) Text("没有匹配的已加载消息。", color = MaterialTheme.colorScheme.onSurfaceVariant)
        if(state.historyHasMore) OutlinedButton(onClick = { state.loadEarlier() }, enabled = !state.loadingHistory) { Text(if(state.loadingHistory) "正在加载…" else "加载更早记录后继续查找") }
    }
}

@Composable internal fun ExperienceSettings(state: RemoteState) {
    Group("本客户端") {
        SettingsRow(Icons.Outlined.Palette, "外观与阅读", "主题与文字大小") { state.sheet = "theme" }
        SettingsRow(Icons.Outlined.SmartToy, "KIKI 伙伴", "外观、动作与陪伴方式") { state.sheet = "companion" }
    }
    Group("工作设备") { SettingsRow(Icons.Outlined.Devices, "设备与连接", "企业网关与 SSH 直连") { state.sheet = "connections" } }
    if(state.connected && !state.sharedDevice) Group("AI · ${state.deviceName}") {
        SettingsRow(Icons.Outlined.CloudQueue, "模型与渠道", "管理渠道与默认模型") { state.openModels() }
        SettingsRow(Icons.Outlined.Extension, "扩展", "MCP、Skills 与插件") { state.loadExtensions() }
        SettingsRow(Icons.Outlined.Psychology, "记忆管理", "项目经验与已确认的记忆") { state.sheet = "memory" }
        SettingsRow(Icons.Outlined.PersonOutline, "工作偏好", "保存在被控电脑") { state.action { state.profilePreferences = state.rpc("profile.get") as JSONObject; state.sheet = "preferences" } }
    }
    Group("账户与版本") {
        SettingsRow(Icons.Outlined.AccountCircle, "个人资料", state.profile.optString("name")) { state.sheet = "profile" }
        SettingsRow(Icons.Outlined.SystemUpdate, "关于 KK Code", "${BuildConfig.VERSION_NAME} · 检查更新") { state.sheet = "updates" }
    }
}

@Composable internal fun ActivityTabs(state: RemoteState) {
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        listOf("activity" to "待办", "changes" to "变更", "subagents" to "子代理", "artifacts" to "产物").forEach { (id, label) -> FilterChip(selected = state.sheet == id, onClick = { state.sheet = id }, label = { Text(label, fontSize = 13.sp) }) }
    }
}

@Composable internal fun TaskCards(state: RemoteState) {
    val items = state.todos?.optJSONArray("items").objects()
    if(items.isEmpty()) Text("当前会话还没有待办。日常对话无需创建任务清单。", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 13.sp, modifier = Modifier.padding(vertical = 20.dp))
    else {
        Text("${items.count { it.optString("status") == "completed" }} / ${items.size}", fontSize = 28.sp, fontWeight = FontWeight.Medium, modifier = Modifier.padding(vertical = 16.dp))
        TaskProgressStrip(items, Modifier.padding(bottom = 16.dp))
        items.forEach { item ->
            val status = item.optString("status"); val active = status == "in_progress"
            Row(Modifier.fillMaxWidth().padding(bottom = 12.dp).background(if(active) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(12.dp)).border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(12.dp)).padding(14.dp), verticalAlignment = Alignment.Top) {
                Icon(if(status == "completed") Icons.Outlined.CheckCircleOutline else if(active) Icons.Outlined.RadioButtonChecked else Icons.Outlined.RadioButtonUnchecked, todoStatusLabel(status), Modifier.size(20.dp), tint = if(status == "completed") kkcodeColors.success else if(active) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.width(10.dp)); Column(Modifier.weight(1f)) {
                    Text(if(active) item.optString("activeForm").ifBlank { item.optString("content") } else item.optString("content"), fontSize = 14.sp)
                    val ownership = item.optJSONObject("owner")
                    val owner = ownership?.optString("agentId").orEmpty().ifBlank { ownership?.optString("sessionId")?.takeIf { it.isNotBlank() && it != state.selected } ?: "主代理" }
                    Text("负责人：$owner", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp))
                    item.optJSONArray("dependencies")?.takeIf { it.length() > 0 }?.let { deps -> Text("依赖：" + (0 until deps.length()).joinToString("、") { deps.optString(it) }, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    if(item.optString("reason").isNotBlank()) Text(item.optString("reason"), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        Text("状态由代理更新；已完成不等于已验证。", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    TextButton(onClick = { state.sheet = "tasks" }) { Text("持久任务与交付记录 →") }
}

@Composable internal fun ConversationRunStatus(state: RemoteState) {
    if(!state.busy) return
    val current = state.todos?.optJSONArray("items").objects().firstOrNull { it.optString("status") == "in_progress" }
    val tasks = state.todos?.optJSONArray("items").objects()
    val children = state.subagents.count { it.optString("status") in listOf("running", "pending") }
    val label = when { state.turnOperation == "compact" -> if(state.stopping) "正在停止压缩…" else if(state.turnPhase == "starting") "正在提交压缩…" else "正在压缩上下文…"; state.stopping -> "正在停止"; state.approvals.isNotEmpty() -> "等待你的确认"; state.turnPhase == "finishing" -> "正在保存结果"; tasks.isNotEmpty() -> "任务 ${tasks.count { it.optString("status") == "completed" }}/${tasks.size}" + if(children > 0) " · 子代理 $children 运行中" else ""; state.turnPhase == "waiting_children" -> "等待子代理汇报"; else -> current?.optString("activeForm")?.ifBlank { null } ?: "正在工作" }
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp).background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(16.dp)).clickable { state.sheet = "activity" }.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.Terminal, null, Modifier.size(17.dp), tint = MaterialTheme.colorScheme.primary); Spacer(Modifier.width(10.dp))
            Text(label, Modifier.weight(1f), fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Icon(Icons.Outlined.ChevronRight, "查看会话活动", Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if(tasks.isNotEmpty()) TaskProgressStrip(tasks)
    }
}

@Composable internal fun CompanionPreferences() {
    val context = LocalContext.current
    val preferences = remember { context.getSharedPreferences("kkcode.studio", android.content.Context.MODE_PRIVATE) }
    var palette by remember { mutableStateOf(preferences.getString("palette", "mint") ?: "mint") }
    var compact by remember { mutableStateOf(preferences.getBoolean("compact", false)) }
    var motion by remember { mutableStateOf(preferences.getBoolean("motion", true)) }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(12.dp)).padding(24.dp), horizontalArrangement = Arrangement.Center) { PixelBuddy(64.dp, palette) }
        Text("小小的伙伴，清楚的状态。", fontSize = 17.sp, fontWeight = FontWeight.Medium)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("mint" to "薄荷", "amber" to "琥珀", "iris" to "鸢尾").forEach { (id, label) -> FilterChip(selected = palette == id, onClick = { palette = id; preferences.edit().putString("palette", id).apply() }, label = { Text(label) }) }
        }
        Row(verticalAlignment = Alignment.CenterVertically) { Text("显示伙伴", Modifier.weight(1f)); Switch(!compact, { compact = !it; preferences.edit().putBoolean("compact", compact).apply() }) }
        Row(verticalAlignment = Alignment.CenterVertically) { Text("播放状态动作", Modifier.weight(1f)); Switch(motion, { motion = it; preferences.edit().putBoolean("motion", it).apply() }) }
        Text("动作遵循系统的动画设置；关闭后仍显示静态姿态与状态文字。", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text("伙伴建议只填入草稿，由你决定是否发送。", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable internal fun TaskProgressStrip(items: List<JSONObject>, modifier: Modifier = Modifier) {
    if(items.isEmpty()) return
    val completed = items.count { it.optString("status") == "completed" }
    val colors = listOf("completed" to kkcodeColors.success, "in_progress" to MaterialTheme.colorScheme.onSurfaceVariant, "blocked" to kkcodeColors.warning, "cancelled" to MaterialTheme.colorScheme.outline, "pending" to MaterialTheme.colorScheme.outlineVariant)
    Row(modifier.fillMaxWidth().height(5.dp).semantics { progressBarRangeInfo = ProgressBarRangeInfo(completed.toFloat(), 0f..items.size.toFloat(), (items.size - 1).coerceAtLeast(0)) }, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
        colors.forEach { (status, color) -> val count = items.count { it.optString("status") == status }; if(count > 0) Box(Modifier.weight(count.toFloat()).fillMaxHeight().background(color, RoundedCornerShape(3.dp))) }
    }
}
