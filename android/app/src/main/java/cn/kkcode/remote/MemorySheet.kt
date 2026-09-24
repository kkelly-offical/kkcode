package cn.kkcode.remote

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.*
import org.json.JSONObject

private data class MemoryItem(val id: String, val text: String, val version: Long, val status: String, val automatic: Boolean, val evidence: List<String>) {
    companion object {
        fun parse(value: JSONObject): MemoryItem {
            val id = value.optString("id"); val text = value.optString("text"); val version = value.optLong("version")
            val status = value.optString("status")
            require(Regex("^mem_[0-9a-f-]{36}$").matches(id) && version > 0 && text.length <= 2000 && status in listOf("candidate", "active", "disabled", "stale")) { "记忆条目格式无效，请刷新或在本机检查。" }
            val evidence = value.optJSONArray("evidence").objects().take(20).map { row ->
                when(row.optString("kind")) {
                    "project_file" -> "已核对项目文件 ${row.optString("path").take(120)}"
                    "host_confirmation" -> "设备所有者已确认"
                    "correction" -> "用户修订，等待重新确认"
                    "legacy_import" -> "旧文件导入：${row.optString("source").take(80)}"
                    else -> "提议参考，尚需核验"
                }
            }
            return MemoryItem(id, text, version, status, value.optBoolean("automatic"), evidence)
        }
    }
}
private data class MemoryDecision(val kind: String, val item: MemoryItem? = null, val source: String? = null)
private fun memoryStatus(status: String) = when(status) { "candidate" -> "待确认"; "active" -> "已启用"; "disabled" -> "已禁用"; else -> "来源已变化" }

@Composable internal fun MemorySheet(state: RemoteState) {
    val client = state.api; val device = client?.device; val session = state.selected
    val account = state.profile.optString("id"); val organization = state.profile.optString("organization"); val gateway = state.gateway
    key(client, device, session, account, organization, gateway, state.connected, state.sharedDevice) {
        if(!state.connected) Text("请先连接设备，再管理当前账号的记忆。", Modifier.padding(16.dp))
        else MemoryPanel(session, state.sharedDevice) { method, params ->
            fun checkSelection() {
                if(state.api !== client || client?.device != device || state.selected != session || !state.connected || state.sharedDevice ||
                    state.gateway != gateway || state.profile.optString("id") != account || state.profile.optString("organization") != organization)
                    throw CancellationException("设备、会话或账号已改变")
            }
            checkSelection(); val result = state.rpc(method, params) as? JSONObject ?: error("记忆响应格式无效。"); checkSelection(); result
        }
    }
}

@Composable internal fun MemoryPanel(sessionId: String, shared: Boolean, request: suspend (String, JSONObject) -> JSONObject) {
    if(shared) { Text("记忆属于设备所有者，共享访客不能读取或修改。", Modifier.padding(16.dp)); return }
    var memoryScope by remember { mutableStateOf(if(sessionId.isBlank()) "personal" else "project") }
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("记忆管理", style = MaterialTheme.typography.titleMedium)
        Text("记忆是可核验的参考，不授予工具、网络、发布或账号访问权限。个人偏好跨项目使用前必须由你确认。", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            FilterChip(selected = memoryScope == "project", onClick = { memoryScope = "project" }, label = { Text("项目记忆") })
            FilterChip(selected = memoryScope == "personal", onClick = { memoryScope = "personal" }, label = { Text("个人偏好") })
        }
        key(memoryScope, sessionId) {
            if(memoryScope == "project" && sessionId.isBlank()) Text("请先打开一个会话，以确定项目工作目录。")
            else MemoryScopePanel(memoryScope, sessionId, request)
        }
    }
}

@Composable private fun MemoryScopePanel(memoryScope: String, sessionId: String, request: suspend (String, JSONObject) -> JSONObject) {
    val scope = rememberCoroutineScope()
    var entries by remember { mutableStateOf(emptyList<MemoryItem>()) }
    var supported by remember { mutableStateOf<Boolean?>(null) }
    var busy by remember { mutableStateOf(false) }
    var notice by remember { mutableStateOf("") }
    var proposal by remember { mutableStateOf("") }
    var decision by remember { mutableStateOf<MemoryDecision?>(null) }
    var editText by remember { mutableStateOf("") }
    var legacy by remember { mutableStateOf(emptyList<JSONObject>()) }
    var legacyLoaded by remember { mutableStateOf(false) }
    var visibleCount by remember { mutableIntStateOf(50) }
    var job by remember { mutableStateOf<Job?>(null) }
    var alive by remember { mutableStateOf(true) }
    fun params() = JSONObject().put("scope", memoryScope).apply { if(sessionId.isNotBlank()) put("sessionId", sessionId) }
    suspend fun load() {
        val result = request("memory.list", params().put("includeCandidates", true).put("includeDisabled", true))
        require(result.optString("scope") == memoryScope) { "记忆响应范围不一致，已停止显示。" }
        val values = result.optJSONArray("entries").objects()
        require(values.size <= 500) { "记忆列表超出支持容量。" }
        entries = values.map(MemoryItem::parse)
    }
    fun action(operation: suspend () -> Unit) {
        if(busy) return
        job = scope.launch {
            busy = true; notice = ""
            try { operation() }
            catch(error: CancellationException) { throw error }
            catch(error: Exception) {
                if(error is DeviceApiError && error.code in listOf("unknown_method", "not_supported")) supported = false
                else notice = remoteErrorMessage(error)
            } finally { if(alive) busy = false }
        }
    }
    DisposableEffect(Unit) { onDispose { alive = false; job?.cancel() } }
    LaunchedEffect(Unit) { action {
        val status = request("status", JSONObject()); val features = status.optJSONArray("features")
        supported = features != null && (0 until features.length()).any { features.optString(it) == "memory.v1" }
        if(supported == true) load()
    } }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        when(supported) {
            null -> Text("正在读取记忆能力…")
            false -> Text("当前设备不支持安全记忆管理，请升级被控电脑和网关后重试。")
            true -> {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { action { load() } }, enabled = !busy) { Text("刷新记忆") }
                    if(memoryScope == "project") OutlinedButton(onClick = { action {
                        val result = request("memory.observe", params()); load(); notice = "已核对 ${result.optInt("observed")} 项项目事实；不代表测试或构建已通过。"
                    } }, enabled = !busy) { Text("核对项目事实") }
                }
                OutlinedTextField(proposal, { proposal = it.take(4000) }, label = { Text(if(memoryScope == "personal") "提议个人偏好" else "提议项目约定") },
                    supportingText = { Text("${proposal.length}/2000 字符，不要填写密码或密钥") }, modifier = Modifier.fillMaxWidth(), minLines = 2, maxLines = 4, enabled = !busy)
                TextButton(onClick = { action {
                    val result = request("memory.propose", params().put("text", proposal).put("category", if(memoryScope == "personal") "preference" else "workflow"))
                    proposal = ""; load(); notice = if(result.optBoolean("suppressed")) "这条内容已被遗忘抑制，没有重新启用。" else "已保存为待确认候选，尚未自动启用。"
                } }, enabled = !busy && proposal.isNotBlank() && proposal.length <= 2000) { Text("保存为候选") }
                if(entries.isEmpty() && !busy) Text("当前范围暂无记忆。")
                entries.take(visibleCount).forEach { item ->
                    OutlinedCard(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text("${memoryStatus(item.status)} · v${item.version}" + if(item.automatic) " · 自动核验事实" else "", fontSize = 12.sp)
                            Text(item.text, fontSize = 14.sp)
                            var expanded by remember(item.id) { mutableStateOf(false) }
                            TextButton(onClick = { expanded = !expanded }) { Text(if(expanded) "收起来源" else "查看来源") }
                            if(expanded) Text(item.evidence.joinToString("\n").ifBlank { "暂无可用来源证据。" }, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                if(item.status != "active") TextButton(onClick = { decision = MemoryDecision("confirm", item) }, enabled = !busy) { Text(if(item.status == "disabled") "重新启用" else "确认启用") }
                                else TextButton(onClick = { action {
                                    request("memory.enable", params().put("id", item.id).put("expectedVersion", item.version).put("enabled", false)); load(); notice = "已禁用，内容不再作为有效记忆注入。"
                                } }, enabled = !busy) { Text("禁用") }
                                TextButton(onClick = { editText = item.text; decision = MemoryDecision("correct", item) }, enabled = !busy) { Text("修正") }
                                TextButton(onClick = { decision = MemoryDecision("forget", item) }, enabled = !busy) { Text("遗忘") }
                            }
                        }
                    }
                }
                if(entries.size > visibleCount) TextButton(onClick = { visibleCount += 50 }) { Text("显示更多记忆") }
                if(memoryScope == "project") {
                    HorizontalDivider()
                    TextButton(onClick = { action {
                        val result = request("memory.legacy", params()); legacy = result.optJSONArray("sources").objects(); legacyLoaded = true
                    } }, enabled = !busy) { Text("检查旧记忆文件") }
                    if(legacyLoaded && legacy.isEmpty()) Text("未发现可导入的旧记忆文件。", fontSize = 12.sp)
                    legacy.filter { it.optString("source") in listOf("auto-memory", "instincts", "project-memory") }.forEach { source ->
                        TextButton(onClick = { decision = MemoryDecision("import", source = source.getString("source")) }, enabled = !busy) { Text("导入 ${source.getString("source")}（${source.optLong("bytes")} 字节）") }
                    }
                    if(legacy.isNotEmpty()) Text("旧文件不会自动迁移或删除。导入只建立候选，每条内容仍需核验后确认。", fontSize = 12.sp)
                }
            }
        }
        if(busy) TextButton(onClick = { job?.cancel() }) { Text("取消当前操作") }
        if(notice.isNotBlank()) Text(notice, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 12.sp)
    }
    decision?.let { selected ->
        val item = selected.item
        val title = when(selected.kind) { "correct" -> "修正记忆"; "forget" -> "遗忘这条记忆？"; "import" -> "确认导入旧文件？"; else -> if(memoryScope == "personal") "确认跨项目个人偏好？" else "确认项目参考？" }
        AlertDialog(onDismissRequest = { decision = null }, title = { Text(title) }, text = {
            Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(if(memoryScope == "personal") "范围：当前账号的跨项目个人偏好" else "范围：当前会话项目", fontSize = 12.sp)
                if(selected.kind == "correct") OutlinedTextField(editText, { editText = it.take(4000) }, modifier = Modifier.fillMaxWidth(), label = { Text("修正后的内容") }, minLines = 3, maxLines = 8)
                else if(item != null) Text(item.text)
                Text(when(selected.kind) {
                    "correct" -> "修正后会重新成为候选，旧确认不会自动应用到新内容。"
                    "forget" -> "有效记录和索引中的内容会移除，并抑制该内容自动重新出现；不是删除工作区文件。"
                    "import" -> "旧文件 ${selected.source} 未按账号分区。请确认你有权导入当前账号；导入后不会立即启用。"
                    else -> "只作为附加参考提供给模型，不授予操作、网络、发布或账号权限。"
                }, fontSize = 12.sp)
            }
        }, confirmButton = { TextButton(onClick = {
            decision = null
            action {
                val payload = params()
                if(item != null) payload.put("id", item.id).put("expectedVersion", item.version)
                when(selected.kind) {
                    "correct" -> request("memory.correct", payload.put("text", editText))
                    "forget" -> request("memory.forget", payload.put("confirmed", true))
                    "import" -> request("memory.import", payload.put("source", selected.source).put("confirmed", true))
                    else -> request("memory.confirm", payload.put("confirmed", true))
                }
                load(); notice = when(selected.kind) { "correct" -> "修订已保存为候选，等待重新确认。"; "forget" -> "已遗忘这条记忆。"; "import" -> "旧文件已导入为候选，尚未启用。"; else -> "已确认并启用此参考。" }
            }
        }, enabled = !busy && (selected.kind != "correct" || editText.isNotBlank() && editText.length <= 2000)) { Text(if(selected.kind == "forget") "确认遗忘" else "确认") } },
            dismissButton = { TextButton(onClick = { decision = null }) { Text("取消") } })
    }
}
