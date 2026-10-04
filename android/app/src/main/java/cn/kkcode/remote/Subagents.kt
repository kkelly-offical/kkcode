package cn.kkcode.remote

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import org.json.JSONObject

@Composable internal fun SubagentSync(state: RemoteState) {
    val active = state.subagents.any { it.optString("status") in listOf("running", "pending") }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(state.api, state.selected, state.connected, state.busy, active, state.sheet == "subagents") {
        if(state.api == null || !state.connected || state.selected.isBlank()) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
        do {
            state.refreshSubagents()
            if(!state.busy && !active && state.sheet != "subagents") break
            delay(2000)
        } while(isActive)
        }
    }
}

internal fun subagentActivity(item: JSONObject): String {
    if(item.optString("status") !in listOf("running", "pending")) return subagentStatusLabel(item.optString("status"))
    val activity = item.optJSONObject("activity")
    return when(activity?.optString("phase")) {
        "thinking" -> "正在思考"
        "approval" -> "等待你的确认"
        "stopping" -> "正在停止"
        "writing" -> "正在输出"
        "waiting_children" -> "等待协作结果"
        "finishing" -> "正在保存结果"
        "tool" -> when(activity.optString("tool")) { "read" -> "阅读文件"; "grep", "glob", "list" -> "检索项目"; "write", "edit", "patch" -> "修改文件"; "bash" -> "执行命令"; else -> "使用工具 · ${activity.optString("tool")}" }
        else -> if(item.optString("status") == "pending") "排队等待执行" else "正在执行"
    }
}

private fun tokenLabel(value: Long): String = when { value >= 1000000 -> "%.2fM".format(value / 1000000.0); value >= 1000 -> "%.1fk".format(value / 1000.0); else -> value.toString() }

@Composable internal fun SubagentsSheet(state: RemoteState) {
    val now = System.currentTimeMillis()
    Column(Modifier.fillMaxWidth().padding(bottom = 20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(subagentProgressSummary(state.subagents) ?: "协作工作台", modifier = Modifier.testTag("subagent-panel-summary"), fontSize = 16.sp, fontWeight = FontWeight.Medium)
        Text("子代理完成后会自动汇报给主代理。这里显示当前会话的执行状态与实际模型设置。", fontSize = 12.sp, color = kkcodeColors.activityMuted)
        if(state.subagentSyncNotice.isNotBlank()) Text(state.subagentSyncNotice, fontSize = 12.sp, color = kkcodeColors.warning)
        if(state.subagents.isEmpty()) Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant, PixelShape()).padding(18.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.Groups, null, tint = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.width(12.dp)); Text("当前会话还没有派发子代理。", fontSize = 13.sp)
        }
        state.subagents.forEach { item -> key(item.optString("session_id")) {
            val running = item.optString("status") in listOf("running", "pending")
            val runtime = item.optJSONObject("runtime"); val context = item.optJSONObject("context")
            val limit = context?.optLong("limit")?.takeIf { it > 0 } ?: runtime?.optLong("context_limit") ?: 0
            val elapsed = (((item.optLong("settled_at").takeIf { it > 0 } ?: now) - item.optLong("started_at", now)) / 1000).coerceAtLeast(0)
            Column(Modifier.fillMaxWidth().testTag("subagent-card").background(MaterialTheme.colorScheme.surfaceVariant, PixelShape()).border(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = .4f), PixelShape()).padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Icon(if(running) Icons.Outlined.Terminal else if(item.optString("status") == "completed") Icons.Outlined.CheckCircleOutline else Icons.Outlined.Info, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.primary)
                    Text(item.optString("description").ifBlank { item.optString("subagent", "子代理") }, Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.Medium, fontSize = 14.sp)
                    Text(subagentStatusLabel(item.optString("status")), fontSize = 11.sp, color = kkcodeColors.activityMuted)
                }
                Text("${item.optString("subagent")} · ${subagentActivity(item)} · ${elapsed}s", fontSize = 11.sp, color = kkcodeColors.activityMuted)
                Text(listOf(item.optString("provider"), item.optString("model")).filter { it.isNotBlank() }.joinToString(" / ").ifBlank { "模型信息尚未同步" }, fontSize = 13.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                if(runtime?.optString("thinking")?.isNotBlank() == true) Text("思考 · ${runtime.optString("thinking")}", fontSize = 12.sp, color = kkcodeColors.activityMuted)
                if(limit > 0) {
                    Text("上下文 ${context?.optLong("tokens")?.let(::tokenLabel) ?: "—"} / ${tokenLabel(limit)}" + if((runtime?.optLong("output_reserved") ?: 0) > 0) " · 输出预留 ${tokenLabel(runtime!!.optLong("output_reserved"))}" else "", fontSize = 11.sp, color = kkcodeColors.activityMuted)
                    if(context != null) LinearProgressIndicator(progress = { (context.optDouble("percent") / 100).toFloat().coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth().height(3.dp))
                }
                if(running && !state.sharedDevice) TextButton(onClick = { state.interruptSubagent(item.optString("session_id")) }, enabled = state.connected && state.canControl && !state.controlElsewhere, contentPadding = PaddingValues(0.dp)) { Icon(Icons.Outlined.Stop, null, Modifier.size(15.dp)); Spacer(Modifier.width(6.dp)); Text("停止此子代理", fontSize = 12.sp) }
            }
        } }
        HorizontalDivider()
        TextButton(onClick = { state.sheet = "tasks" }) { Icon(Icons.Outlined.Assignment, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text("持久任务与交付记录") }
    }
}
