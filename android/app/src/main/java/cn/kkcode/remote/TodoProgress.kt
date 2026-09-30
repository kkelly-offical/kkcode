package cn.kkcode.remote

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.json.JSONObject

internal fun todoStatusLabel(status: String): String = when(status) {
    "pending" -> "待办"; "in_progress" -> "进行中"; "completed" -> "已完成"; "blocked" -> "受阻"; "cancelled" -> "已取消"; else -> "未知"
}

internal fun acceptTodoSnapshot(current: JSONObject?, incoming: JSONObject?, sessionId: String): JSONObject? {
    if(incoming == null || incoming.optString("sessionId") != sessionId || !incoming.has("revision")) return current
    val revision = incoming.optDouble("revision", -1.0)
    if(!revision.isFinite() || revision < 0 || revision % 1.0 != 0.0 || revision > 9007199254740991.0) return current
    if(current?.optString("sessionId") == sessionId && revision <= current.optDouble("revision")) return current
    val array = incoming.optJSONArray("items") ?: return current
    val items = array.objects()
    if(items.size != array.length() || items.any { it.optString("id").isBlank() || it.opt("content") !is String || todoStatusLabel(it.optString("status")) == "未知" } || items.map { it.optString("id") }.distinct().size != items.size) return current
    return incoming
}

internal fun todoProgressSummary(snapshot: JSONObject?): String? {
    val items = snapshot?.optJSONArray("items").objects()
    if(items.isEmpty()) return null
    fun count(status: String) = items.count { it.optString("status") == status }
    val cancelled = count("cancelled")
    return "待办 ${count("completed")}/${items.size} · 进行中 ${count("in_progress")} · 受阻 ${count("blocked")}" + if(cancelled > 0) " · 已取消 $cancelled" else ""
}

internal fun subagentStatusLabel(status: String): String = when(status) {
    "running" -> "进行中"; "pending" -> "等待中"; "completed" -> "已完成"; "blocked" -> "受阻"; "error" -> "失败"; "cancelled" -> "已取消"; "interrupted" -> "已中断"; "incomplete" -> "未完成"; else -> "待核查"
}

internal fun scopedSubagents(items: List<JSONObject>, sessionId: String): List<JSONObject> = items.filter { it.optString("parent_session_id") == sessionId && it.optString("session_id").isNotBlank() }.map {
    JSONObject().put("session_id", it.optString("session_id")).put("parent_session_id", sessionId).put("subagent", it.optString("subagent", "子代理")).put("status", it.optString("status", "unknown"))
}

internal fun mergeSubagentEvent(items: List<JSONObject>, event: JSONObject, sessionId: String): List<JSONObject> {
    val type = event.optString("type"); val payload = event.optJSONObject("payload") ?: return items
    if(event.optString("sessionId") != sessionId || type !in listOf("subagent.delegated", "subagent.settled") || payload.optString("subSessionId").isBlank()) return items
    val child = JSONObject().put("session_id", payload.optString("subSessionId")).put("parent_session_id", sessionId).put("subagent", payload.optString("subagent", "子代理")).put("status", if(type == "subagent.delegated") "running" else payload.optString("status", "unknown"))
    return items.filterNot { it.optString("session_id") == child.optString("session_id") } + child
}

internal fun subagentProgressSummary(items: List<JSONObject>): String? {
    if(items.isEmpty()) return null
    val completed = items.count { it.optString("status") == "completed" }
    val active = items.count { it.optString("status") in listOf("running", "pending") }
    val attention = items.count { it.optString("status") !in listOf("running", "pending", "completed", "cancelled") }
    return "子代理 $completed/${items.size} · 进行中 $active · 需关注 $attention"
}

@Composable internal fun TodoProgressView(snapshot: JSONObject?, identity: String, subagents: List<JSONObject> = emptyList()) {
    val summary = listOfNotNull(todoProgressSummary(snapshot), subagentProgressSummary(subagents)).joinToString(" · ").ifBlank { return }
    var expanded by remember(identity) { mutableStateOf(false) }
    val muted = kkcodeColors.activityMuted
    Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp)) {
        Row(Modifier.fillMaxWidth().semantics { stateDescription = if(expanded) "已展开" else "已收起" }.clickable(role = Role.Button, onClickLabel = if(expanded) "收起待办详情" else "展开待办详情") { expanded = !expanded }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(summary, Modifier.weight(1f), color = muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Icon(if(expanded) Icons.Outlined.ExpandMore else Icons.Outlined.ChevronRight, null, Modifier.size(14.dp), tint = muted)
        }
        if(expanded) Column(Modifier.fillMaxWidth().heightIn(max = 200.dp).verticalScroll(rememberScrollState()).padding(bottom = 8.dp)) {
            Text("任务状态由代理更新；已完成不等于已验证。", color = muted, fontSize = 11.sp)
            snapshot?.optJSONArray("items").objects().forEach { item -> key(item.optString("id")) {
                val owner = item.optJSONObject("owner")
                val ownerLabel = owner?.optString("agentId")?.takeIf { it.isNotBlank() } ?: owner?.optString("sessionId")?.takeIf { it.isNotBlank() && it != snapshot?.optString("sessionId") } ?: "主代理"
                val dependencies = item.optJSONArray("dependencies")
                val labels = if(dependencies == null) emptyList() else (0 until dependencies.length()).map { dependencies.optString(it) }
                Column(Modifier.padding(top = 7.dp)) {
                    Text("${todoStatusLabel(item.optString("status"))} · ${if(item.optString("status") == "in_progress") item.optString("activeForm").ifBlank { item.optString("content") } else item.optString("content")}", color = muted, fontSize = 12.sp)
                    Text("负责人：$ownerLabel" + if(labels.isNotEmpty()) " · 依赖：${labels.joinToString("、")}" else "", color = muted, fontSize = 10.sp)
                }
            } }
            subagents.forEach { item -> key(item.optString("session_id")) {
                Column(Modifier.padding(top = 7.dp)) {
                    Text("${item.optString("subagent")} · ${subagentStatusLabel(item.optString("status"))}", color = muted, fontSize = 12.sp)
                    Text(item.optString("session_id"), color = muted, fontSize = 10.sp)
                }
            } }
        }
    }
}
