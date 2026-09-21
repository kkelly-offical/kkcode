package cn.kkcode.remote

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import org.json.JSONObject

private val activityMuted = Color(0xFF99999F)
private val addition = Color(0xFF75B68D)
private val removal = Color(0xFFD47E89)

internal fun toolMutations(payload: JSONObject?): List<JSONObject> {
    val metadata = payload?.optJSONObject("metadata") ?: return emptyList()
    return metadata.optJSONArray("mutations").objects().ifEmpty { metadata.optJSONObject("mutation")?.let { listOf(it) } ?: emptyList() }
}

@Composable fun ActivityRow(item: ChatItem) {
    var expanded by remember(item.id) { mutableStateOf(false) }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(item.done) { while(!item.done) { now = System.currentTimeMillis(); delay(1000) } }
    val payload = item.tool ?: JSONObject()
    val args = payload.optJSONObject("args") ?: JSONObject()
    val tool = payload.optString("tool", item.text)
    val changes = toolMutations(item.tool)
    val editing = tool in listOf("edit", "write", "patch", "multiedit", "notebookedit", "git_apply_patch")
    val browsing = tool in listOf("read", "ls", "glob", "grep")
    val file = changes.firstOrNull()?.optString("filePath")?.takeIf { it.isNotBlank() } ?: args.optString("file_path", args.optString("path"))
    val basename = file.split('/', '\\').lastOrNull().orEmpty()
    val status = payload.optString("status", "completed")
    val action = when(status) { "running" -> "正在"; "error", "blocked", "cancelled" -> "未完成"; else -> "已" }
    val elapsed = item.durationMs ?: if(!item.done && item.startedAt > 0) (now - item.startedAt).coerceAtLeast(0) else null
    val title = when {
        item.kind == "thinking" -> "Thinking" + (elapsed?.let { " · ${it / 1000} 秒" } ?: "")
        editing -> "$action${if(tool == "write") "写入" else "编辑"} ${basename.ifBlank { "文件" }}"
        tool == "bash" -> "${action}运行 ${args.optString("command", "命令") }"
        browsing -> "${action}浏览 ${basename.ifBlank { args.optString("pattern", tool) }}"
        else -> tool
    }
    Column(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().clickable { expanded = !expanded }.padding(vertical = 7.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            if((item.kind == "thinking" && !item.done) || status == "running") CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 1.5.dp, color = activityMuted)
            else Icon(if(item.kind == "thinking") Icons.Outlined.Psychology else if(editing) Icons.Outlined.Edit else if(browsing) Icons.Outlined.FolderOpen else Icons.Outlined.Terminal, null, Modifier.size(16.dp), tint = activityMuted)
            Text(title, Modifier.weight(1f, fill = false), fontSize = 12.sp, color = activityMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val added = changes.sumOf { it.optInt("addedLines") }; val removed = changes.sumOf { it.optInt("removedLines") }
            if(added + removed > 0) { Text("+$added", color = addition, fontSize = 10.sp); Text("−$removed", color = removal, fontSize = 10.sp) }
            Icon(if(expanded) Icons.Outlined.ExpandMore else Icons.Outlined.ChevronRight, if(expanded) "收起详情" else "展开详情", Modifier.size(14.dp), tint = activityMuted)
        }
        if(expanded) Column(Modifier.fillMaxWidth().padding(start = 22.dp, bottom = 10.dp)) {
            changes.forEach { change ->
                Text(change.optString("filePath"), color = activityMuted, fontSize = 11.sp, modifier = Modifier.padding(vertical = 8.dp))
                SelectionContainer {
                    Column(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
                        change.optJSONArray("structuredPatch").objects().forEach { hunk ->
                            Text("@@ −${hunk.optInt("oldStart")},${hunk.optInt("oldLineCount")} +${hunk.optInt("newStart")},${hunk.optInt("newLineCount")} @@", fontSize = 10.sp, fontFamily = FontFamily.Monospace, color = activityMuted)
                            hunk.optJSONArray("lines").objects().forEach { line ->
                                val type = line.optString("type"); val color = if(type == "add") addition else if(type == "remove") removal else activityMuted
                                Text((if(type == "add") "+ " else if(type == "remove") "− " else "  ") + line.optString("text"), color = color, fontSize = 11.sp, lineHeight = 18.sp, fontFamily = FontFamily.Monospace, modifier = Modifier.fillMaxWidth().background(if(type == "add" || type == "remove") color.copy(alpha = .09f) else Color.Transparent).padding(horizontal = 5.dp))
                            }
                        }
                    }
                }
            }
            val detail = if(item.kind == "thinking") item.text else item.detail.ifBlank { payload.optString("output", "") }
            if(detail.isNotBlank()) SelectionContainer { Text(detail.take(20000), fontSize = 12.sp, color = activityMuted, lineHeight = 19.sp) }
            if(args.length() > 0) { var showArgs by remember { mutableStateOf(false) }; TextButton(onClick = { showArgs = !showArgs }, contentPadding = PaddingValues(0.dp)) { Text("调用参数", fontSize = 11.sp, color = activityMuted) }; if(showArgs) SelectionContainer { Text(args.toString(2), fontSize = 11.sp, color = activityMuted, fontFamily = FontFamily.Monospace) } }
        }
    }
}

@Composable fun ChangeSummary(messages: List<ChatItem>) {
    val changes = messages.filter { it.kind == "tool" && it.tool?.optString("status") == "completed" }.flatMap { toolMutations(it.tool) }
    val files = changes.map { it.optString("filePath") }.filter { it.isNotBlank() }.distinct()
    if(files.isNotEmpty()) Row(Modifier.padding(horizontal = 20.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Outlined.Edit, null, Modifier.size(14.dp), tint = activityMuted)
        Text("${files.size} 个文件", color = activityMuted, fontSize = 11.sp)
        Text("+${changes.sumOf { it.optInt("addedLines") }}", color = addition, fontSize = 11.sp)
        Text("−${changes.sumOf { it.optInt("removedLines") }}", color = removal, fontSize = 11.sp)
    }
}
