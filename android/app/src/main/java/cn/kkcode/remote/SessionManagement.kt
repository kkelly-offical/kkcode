package cn.kkcode.remote

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import org.json.JSONObject

internal data class ModeChoice(val id: String, val label: String, val description: String)
internal val MODE_CHOICES = listOf(
    ModeChoice("agent", "Agent", "常规执行，敏感操作由你确认"),
    ModeChoice("plan", "Plan", "只读分析与规划"),
    ModeChoice("auto", "Auto", "自动编辑，敏感操作由当前对话模型审查"),
    ModeChoice("ultra", "Ultra", "持续推进长任务，沿用 Auto 审查"),
    ModeChoice("yolo", "Yolo", "授权范围内自主执行，跳过常规确认")
)
internal fun modeLabel(value: String) = MODE_CHOICES.firstOrNull { it.id == if(value == "agent-auto") "auto" else value }?.label ?: value

@Composable internal fun SessionManagementDialogs(state: RemoteState) {
    state.managedSession?.let { original ->
        val session = state.sessions.find { it.optString("id") == original.optString("id") } ?: original
        var title by remember(session.optString("id")) { mutableStateOf(session.optString("title")) }
        val running = if(session.optString("id") == state.selected) state.busy else session.optString("status").startsWith("running")
        AlertDialog(onDismissRequest = { if(!state.savingSession) state.managedSession = null }, title = { Text("管理对话") }, text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(title, { if(it.codePointCount(0, it.length) <= 120) title = it }, label = { Text("对话名称") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                TextButton(enabled = !state.savingSession && !running, onClick = { state.updateSession(session, JSONObject().put("archived", !session.optBoolean("archived"))) }) { Text(if(session.optBoolean("archived")) "恢复到对话列表" else "归档对话") }
                if(session.optString("id") == state.selected && !session.optBoolean("archived")) TextButton(enabled = !state.savingSession && !running, onClick = { state.managedSession = null; state.rewindTarget = ChatItem("", "user", "") }) { Text("回退上一轮对话") }
                Text(if(running) "任务进行中，停止后可回退或归档。" else "归档保留完整历史，可随时恢复。", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }, confirmButton = { TextButton(enabled = !state.savingSession && title.isNotBlank(), onClick = { state.updateSession(session, JSONObject().put("title", title.trim()).put("expectedTitleRevision", session.optInt("titleRevision"))) }) { Text("保存名称") } }, dismissButton = { TextButton(enabled = !state.savingSession, onClick = { state.managedSession = null }) { Text("取消") } })
    }
    state.rewindTarget?.let { target ->
        AlertDialog(onDismissRequest = { if(!state.savingSession) state.rewindTarget = null }, title = { Text("回退对话？") }, text = { Column {
            Text("撤回${if(target.messageId.isBlank()) "上一轮" else "这条提问及其后的全部"}对话，恢复提问草稿。设备保留回退前备份，并同步到其他客户端。不会撤销任何文件或 Git 修改。")
            if(target.text.isNotBlank()) Text(target.text.take(300), modifier = Modifier.padding(top = 12.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
        } }, confirmButton = { TextButton(enabled = !state.savingSession && !state.busy, onClick = { state.rewindConversation() }) { Text("确认回退对话") } }, dismissButton = { TextButton(enabled = !state.savingSession, onClick = { state.rewindTarget = null }) { Text("取消") } })
    }
}
