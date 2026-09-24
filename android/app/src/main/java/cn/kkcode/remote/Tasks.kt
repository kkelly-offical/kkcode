package cn.kkcode.remote

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.*
import org.json.JSONObject
import java.io.File
import java.text.DateFormat
import java.util.Date
import java.util.Locale

private val taskStates = mapOf("running" to "运行中", "waiting_input" to "等待输入", "waiting_approval" to "等待确认", "paused" to "已暂停",
    "verification_failed" to "验收未通过", "outcome_unknown" to "结果待核查", "cancelled" to "已取消", "completed" to "已完成")
private fun taskInteger(json: JSONObject, key: String): Long {
    val value = json.opt(key)
    require(value is Number && value.toDouble().isFinite() && value.toDouble() == value.toLong().toDouble() && value.toLong() in 0..9007199254740991L) { "任务响应字段无效，请刷新。" }
    return value.toLong()
}
private fun taskCursor(json: JSONObject): String? = if(json.isNull("nextCursor")) null else json.optString("nextCursor").takeIf { it.isNotBlank() }?.also {
    require(it.length <= 2048 && Regex("^[A-Za-z0-9_-]+$").matches(it)) { "任务分页游标无效。" }
}
internal data class TaskLocalFree(val maxRequests: Long, val maxTokens: Long, val usedRequests: Long, val reservedTokens: Long) {
    companion object {
        fun parse(json: JSONObject): TaskLocalFree {
            val maxRequests = taskInteger(json, "maxRequests"); val maxTokens = taskInteger(json, "maxTokens")
            val usedRequests = taskInteger(json, "usedRequests"); val reservedTokens = taskInteger(json, "reservedTokens")
            require(maxRequests in 1..10000 && maxTokens in 1..10000000000L && usedRequests <= maxRequests && reservedTokens <= maxTokens) { "本地调用额度字段无效。" }
            return TaskLocalFree(maxRequests, maxTokens, usedRequests, reservedTokens)
        }
    }
}
internal data class TaskBudget(val limit: Double, val spent: Double, val reserved: Double, val unknown: Double, val deadline: Long, val hasUnknown: Boolean, val localFree: TaskLocalFree? = null) {
    companion object {
        fun parse(json: JSONObject): TaskBudget {
            fun amount(key: String): Double { val value = json.opt(key); require(value is Number && value.toDouble().isFinite() && value.toDouble() >= 0) { "任务预算字段无效。" }; return value.toDouble() }
            val localFree = if(json.isNull("localFree")) null else TaskLocalFree.parse(requireNotNull(json.optJSONObject("localFree")) { "本地调用额度字段无效。" })
            val limit = amount("budgetUsd"); require(localFree == null || limit == 0.0) { "本地调用额度与费用预算不一致。" }
            return TaskBudget(limit, amount("spentUsd"), amount("reservedUsd"), amount("unknownUsd"), taskInteger(json, "deadlineAt"), json.optBoolean("hasUnknown"), localFree)
        }
    }
}
internal data class TaskItem(val id: String, val sessionId: String, val objective: String, val state: String, val revision: Long, val ownerEpoch: Long,
    val pending: Long, val unknown: Long, val runningTurn: Boolean, val required: Long, val passed: Long, val canPause: Boolean, val canCancel: Boolean, val budget: TaskBudget?) {
    companion object {
        fun parse(json: JSONObject, expectedSession: String): TaskItem {
            val id = json.optString("id"); val state = json.optString("state")
            require(Regex("^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$").matches(id) && json.optString("sessionId") == expectedSession && taskStates.containsKey(state)) { "任务不属于当前会话或状态无效。" }
            val counts = json.getJSONObject("actionCounts"); val verification = json.getJSONObject("verification"); val controls = json.getJSONObject("controls")
            return TaskItem(id, expectedSession, json.optString("objective").take(4096), state, taskInteger(json, "revision"), taskInteger(json, "ownerEpoch"),
                taskInteger(counts, "prepared"), taskInteger(counts, "unknown"), json.optJSONObject("lastTurn")?.optString("status") == "running",
                taskInteger(verification, "required"), taskInteger(verification, "passed"), controls.optBoolean("canPause"), controls.optBoolean("canCancel"), json.optJSONObject("budget")?.let(TaskBudget::parse))
        }
    }
}

@Composable internal fun TasksSheet(state: RemoteState) {
    val client = state.api; val device = client?.device; val session = state.selected
    val account = state.profile.optString("id"); val organization = state.profile.optString("organization"); val gateway = state.gateway
    key(client, device, session, account, organization, gateway, state.connected) {
        if(!state.connected || session.isBlank()) Text("请先连接设备并打开一个会话，再查看委托任务。", Modifier.padding(16.dp))
        else TaskPanel(session, state.sharedDevice, request = { method, params ->
            fun checkSelection() {
                if(state.api !== client || client?.device != device || state.selected != session || !state.connected || state.gateway != gateway ||
                    state.profile.optString("id") != account || state.profile.optString("organization") != organization) throw CancellationException("连接或会话已改变")
            }
            checkSelection()
            val result = state.rpc(method, params) as? JSONObject ?: error("任务响应格式无效。")
            checkSelection(); result
        })
    }
}

@Composable internal fun TaskPanel(sessionId: String, shared: Boolean, request: suspend (String, JSONObject) -> JSONObject) {
    val scope = rememberCoroutineScope()
    var supported by remember { mutableStateOf<Boolean?>(null) }
    var items by remember { mutableStateOf(emptyList<TaskItem>()) }
    var nextCursor by remember { mutableStateOf<String?>(null) }
    var selected by remember { mutableStateOf<TaskItem?>(null) }
    var confirmation by remember { mutableStateOf<Pair<TaskItem, String>?>(null) }
    var events by remember { mutableStateOf(emptyList<String>()) }
    var after by remember { mutableLongStateOf(0L) }
    var moreEvents by remember { mutableStateOf(false) }
    var notice by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var evidence by remember { mutableStateOf(false) }
    suspend fun load(cursor: String? = null) {
        val params = JSONObject().put("sessionId", sessionId).put("limit", 30)
        if(cursor != null) params.put("cursor", cursor)
        val result = request("runs.list", params)
        val incoming = result.getJSONArray("items").objects().map { TaskItem.parse(it, sessionId) }
        require(incoming.size <= 30) { "任务列表超过分页上限。" }
        items = if(cursor == null) incoming else (items + incoming).distinctBy { it.id }
        nextCursor = taskCursor(result)
    }
    suspend fun refreshTask(id: String) {
        val task = TaskItem.parse(request("runs.get", JSONObject().put("sessionId", sessionId).put("runId", id)), sessionId)
        require(task.id == id) { "任务响应身份不一致。" }
        selected = task; items = items.map { if(it.id == id) task else it }
    }
    fun action(operation: suspend () -> Unit) {
        if(busy) return
        scope.launch {
            busy = true; notice = ""
            try { operation() }
            catch(error: CancellationException) { throw error }
            catch(error: Exception) {
                if(error is DeviceApiError && error.code in listOf("unknown_method", "not_supported")) supported = false
                else notice = remoteErrorMessage(error)
            } finally { busy = false }
        }
    }
    suspend fun loadEvents(task: TaskItem, reset: Boolean) {
        val start = if(reset) 0L else after
        val result = request("runs.events", JSONObject().put("sessionId", sessionId).put("runId", task.id).put("after", start).put("limit", 50))
        require(result.optString("runId") == task.id) { "事件不属于当前任务。" }
        val incoming = result.getJSONArray("events").objects()
        require(incoming.size <= 50 && incoming.all { taskInteger(it, "sequence") > start }) { "任务事件分页无效。" }
        val labels = incoming.map { item ->
            val label = when(item.optString("type")) {
                "run.created" -> "创建任务"; "run.transitioned" -> "状态变化"; "run.claimed" -> "执行宿主已接管"; "turn.started" -> "开始回合"; "turn.ended" -> "回合收束"
                "turn.interrupted" -> "回合中断，等待核查"; "action.prepared" -> "操作已记录，准备执行"; "action.settled" -> "记录操作结果"
                "verification.recorded" -> "记录验收证据"; "candidate.changed", "candidate.updated" -> "候选更新"; "control.requested" -> if(item.optString("control") == "cancel") "已请求取消" else "已请求暂停"
                "budget.configured" -> "已确认额度和期限"
                "budget.reserved" -> if(task.budget?.localFree != null) "已预留本地调用额度" else "已预留执行费用"
                "budget.settled" -> if(task.budget?.localFree != null) "调用结果已确认" else "费用已结算"
                "budget.unknown" -> if(task.budget?.localFree != null) "调用结果待核查" else "费用待核查"
                "budget.reconciled" -> if(task.budget?.localFree != null) "已核查调用证据" else "已核查费用证据"
                "graph.updated" -> "子任务图更新"; else -> "任务记录更新"
            }
            "#${taskInteger(item, "sequence")} · $label" + (taskStates[item.optString("state")]?.let { " · $it" } ?: "")
        }
        events = (if(reset) labels else events + labels).takeLast(200)
        after = taskInteger(result, "nextAfter"); require(after >= start) { "事件游标回退。" }; moreEvents = incoming.size == 50
    }
    LaunchedEffect(Unit) { action {
        val features = request("status", JSONObject()).optJSONArray("features")
        supported = features != null && (0 until features.length()).any { features.optString(it) == "runs.v1" }
        if(supported == true) load()
    } }
    LaunchedEffect(selected?.id, supported) {
        while(supported == true && selected != null) {
            delay(3000)
            if(!busy && confirmation == null && !evidence) action { selected?.let { refreshTask(it.id) } }
        }
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("委托任务", style = MaterialTheme.typography.titleMedium)
        Text("仅显示当前会话的持久任务。创建、恢复、未知结果核查与最终交付确认仍在被控电脑完成。", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if(shared) Text("共享会话：只读查看，不能暂停或取消任务。", fontSize = 12.sp)
        when(supported) {
            null -> Text("正在检查任务能力…")
            false -> Text("当前设备版本不支持委托任务，请升级被控电脑和网关。")
            true -> {
                TextButton(onClick = { action { load(); selected?.let { refreshTask(it.id) } } }, enabled = !busy) { Text("刷新任务") }
                if(items.isEmpty() && !busy) Text("此会话还没有委托任务。")
                items.forEach { item -> OutlinedCard(Modifier.fillMaxWidth()) { Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(item.objective, maxLines = 3, fontSize = 14.sp)
                    Text(taskStates.getValue(item.state), fontSize = 12.sp)
                    TextButton(onClick = { events = emptyList(); after = 0; evidence = false; action { refreshTask(item.id); loadEvents(selected!!, true) } }, enabled = !busy) { Text("查看任务") }
                } } }
                nextCursor?.let { cursor -> TextButton(onClick = { action { load(cursor) } }, enabled = !busy) { Text("更多任务") } }
                selected?.let { task ->
                    HorizontalDivider()
                    Text(task.objective, fontSize = 14.sp)
                    Text("${taskStates.getValue(task.state)} · 版本 ${task.revision}", Modifier.testTag("task-status"))
                    Text("验收：${task.passed} / ${task.required} 项通过；工具结果待核查 ${task.unknown} 项", fontSize = 12.sp)
                    task.budget?.let { budget ->
                        fun usd(value: Double) = String.format(Locale.ROOT, "$%.6f", value)
                        val free = budget.localFree
                        if(free != null) {
                            Text("本地免费 · 请求名额 ${free.usedRequests}/${free.maxRequests} · 累计预留 token ${free.reservedTokens}/${free.maxTokens}", fontSize = 12.sp)
                            Text("token 为累计授权上界，不是实际用量；已结束调用也不会退还名额。", fontSize = 12.sp)
                        } else Text("总额度 ${usd(budget.limit)} · 已结算 ${usd(budget.spent)} · 执行预留 ${usd(budget.reserved)}", fontSize = 12.sp)
                        Text("期限：${DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(budget.deadline))}", fontSize = 12.sp)
                        if(free == null && budget.limit == 0.0) Text("额度为零：不会开始模型推理，不代表免费或无限使用。", fontSize = 12.sp)
                        if(budget.hasUnknown) Text(if(free != null) "调用结果待核查：本地免费不代表结果已确认；核查前不会继续调用。"
                            else "待核查预留 ${usd(budget.unknown)}：这是保守费用上界，不是实际账单；核查前不会继续花费。", fontSize = 12.sp, color = MaterialTheme.colorScheme.error)
                    } ?: Text("尚未设置已确认的任务预算，不能据此推断可继续推理。", fontSize = 12.sp)
                    if(task.runningTurn && task.state in listOf("paused", "cancelled") || task.pending > 0) Text("停止请求已记录，仍有操作正在收尾；已有文件不会回滚。", fontSize = 12.sp)
                    if(task.unknown > 0 || task.state == "outcome_unknown") Text("存在未知副作用，请在被控电脑核查实际结果；不要直接重试。", fontSize = 12.sp, color = MaterialTheme.colorScheme.error)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if(!shared && task.canPause) TextButton(onClick = { confirmation = task to "pause" }, enabled = !busy) { Text("暂停任务") }
                        if(!shared && task.canCancel) TextButton(onClick = { confirmation = task to "cancel" }, enabled = !busy) { Text("取消任务") }
                        TextButton(onClick = { evidence = !evidence }, enabled = !busy) { Text(if(evidence) "收起证据" else "任务证据") }
                    }
                    if(evidence) key(task.id) { TaskEvidence(sessionId, task.id, request) }
                    Text("任务记录（最多显示最近读取的 200 条）", fontSize = 12.sp)
                    events.forEach { Text(it, fontSize = 11.sp) }
                    TextButton(onClick = { action { loadEvents(task, false) } }, enabled = !busy) { Text(if(moreEvents) "继续读取记录" else "检查新记录") }
                }
            }
        }
        if(busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        if(notice.isNotBlank()) Text(notice, color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
    }
    confirmation?.let { (task, operation) -> AlertDialog(onDismissRequest = { confirmation = null }, title = { Text(if(operation == "pause") "暂停此任务？" else "取消此任务？") },
        text = { Text("${task.objective}\n确认任务版本 ${task.revision}。已有文件和远端副作用不会回滚；停止后仍需核查未知结果。状态已变化时会拒绝旧确认，请刷新后重试。") },
        confirmButton = { TextButton(onClick = { confirmation = null; action {
            val result = request("runs.$operation", JSONObject().put("sessionId", sessionId).put("runId", task.id).put("expectedRevision", task.revision).put("expectedOwnerEpoch", task.ownerEpoch).put("confirmed", true))
            val updated = TaskItem.parse(result, sessionId); require(updated.id == task.id) { "任务响应身份不一致。" }
            selected = updated; items = items.map { if(it.id == updated.id) updated else it }; notice = "停止请求已记录，正在等待执行宿主安全收尾。"
        } }) { Text("确认停止") } }, dismissButton = { TextButton(onClick = { confirmation = null }) { Text("返回") } }) }
}

@Composable internal fun TaskEvidence(sessionId: String, runId: String, request: suspend (String, JSONObject) -> JSONObject,
    onVerifiedDownload: ((File) -> Unit)? = null) {
    val context = LocalContext.current; val scope = rememberCoroutineScope()
    var items by remember { mutableStateOf(emptyList<ArtifactItem>()) }; var cursor by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf("") }; var busy by remember { mutableStateOf(false) }; var pending by remember { mutableStateOf<File?>(null) }
    var alive by remember { mutableStateOf(true) }
    fun action(operation: suspend () -> Unit) { if(!busy) scope.launch { busy = true; notice = ""; try { operation() } catch(error: CancellationException) { throw error }
        catch(error: Exception) { notice = remoteErrorMessage(error) } finally { busy = false } } }
    val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri ->
        val file = pending; pending = null
        if(uri == null || !alive) file?.delete()
        else if(file != null) action { try { withContext(Dispatchers.IO) {
            context.contentResolver.openOutputStream(uri, "wt")?.use { output -> file.inputStream().use { input ->
                val buffer = ByteArray(65536); while(true) { currentCoroutineContext().ensureActive(); val n = input.read(buffer); if(n < 0) break; output.write(buffer, 0, n) }; output.flush()
            } } ?: error("无法写入保存位置。")
        }; notice = "已保存 SHA-256 校验通过的任务证据；未自动打开。" } finally { withContext(NonCancellable + Dispatchers.IO) { file.delete() } } }
    }
    suspend fun load(next: String? = null) {
        val params = JSONObject().put("sessionId", sessionId).put("runId", runId).put("limit", 30); if(next != null) params.put("cursor", next)
        val page = request("runs.artifacts.list", params); val found = page.getJSONArray("items").objects().map(ArtifactItem::parse)
        require(found.size <= 30) { "证据列表超过分页上限。" }; items = if(next == null) found else (items + found).distinctBy { it.id }; cursor = taskCursor(page)
    }
    LaunchedEffect(Unit) { action { load() } }
    DisposableEffect(Unit) { onDispose { alive = false; pending?.delete(); pending = null } }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("仅可公开的工具输出与交付文件；内部授权和验收资料不共享。", fontSize = 12.sp)
        if(items.isEmpty() && !busy) Text("暂无可公开证据。", fontSize = 12.sp)
        items.forEach { item ->
            Text("${item.mime} · ${item.size} 字节", fontSize = 12.sp)
            SelectionContainer { Text(item.id, fontSize = 10.sp) }
            TextButton(onClick = { action {
                val file = downloadArtifactToCache(item, sessionId, File(context.cacheDir, "task-downloads"), request = { _, params ->
                    request("runs.artifacts.download", JSONObject(params.toString()).put("runId", runId))
                })
                try { currentCoroutineContext().ensureActive(); pending?.delete(); pending = file
                    if(onVerifiedDownload != null) onVerifiedDownload(file) else save.launch("${item.id}.bin")
                } catch(error: Throwable) { file.delete(); throw error }
            } }, enabled = !busy) { Text("下载证据") }
        }
        cursor?.let { next -> TextButton(onClick = { action { load(next) } }, enabled = !busy) { Text("更多证据") } }
        if(busy) Text("正在读取并校验证据…", fontSize = 12.sp)
        if(notice.isNotBlank()) Text(notice, color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
    }
}
