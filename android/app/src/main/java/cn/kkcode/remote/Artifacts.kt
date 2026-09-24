package cn.kkcode.remote

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
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

@Composable internal fun ArtifactsSheet(state: RemoteState) {
    val client = state.api; val device = client?.device; val session = state.selected
    val account = state.profile.optString("id"); val organization = state.profile.optString("organization")
    val gateway = state.gateway
    key(client, device, session, account, organization, gateway, state.connected) {
        if(!state.connected || session.isBlank()) {
            Text("请先连接设备并打开一个会话，再查看该会话的产物。", Modifier.padding(16.dp))
        } else ArtifactPanel(session, state.sharedDevice, request = { method, params ->
            fun checkSelection() {
                if(state.api !== client || client?.device != device || state.selected != session || !state.connected ||
                    state.gateway != gateway || state.profile.optString("id") != account || state.profile.optString("organization") != organization)
                    throw CancellationException("连接或会话已改变")
            }
            checkSelection()
            val result = state.rpc(method, params) as? JSONObject ?: error("产物响应格式无效。")
            checkSelection(); result
        })
    }
}

/** Plain-text only. No WebView, intent-to-open, URI from a server, or automatic
 * execution. Tests inject RPC and save callbacks, not an alternate auth path. */
@Composable internal fun ArtifactPanel(
    sessionId: String,
    shared: Boolean,
    request: suspend (String, JSONObject) -> JSONObject,
    onVerifiedDownload: ((File, ArtifactItem) -> Unit)? = null
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var supported by remember { mutableStateOf<Boolean?>(null) }
    var items by remember { mutableStateOf(emptyList<ArtifactItem>()) }
    var nextList by remember { mutableStateOf<String?>(null) }
    var selected by remember { mutableStateOf<ArtifactItem?>(null) }
    var preview by remember { mutableStateOf("") }
    var nextRead by remember { mutableStateOf<String?>(null) }
    var readOffset by remember { mutableLongStateOf(0L) }
    var previewOffset by remember { mutableLongStateOf(0L) }
    var query by remember { mutableStateOf("") }
    var searchResult by remember { mutableStateOf("") }
    var nextSearch by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var downloaded by remember { mutableLongStateOf(0L) }
    var downloadTotal by remember { mutableLongStateOf(0L) }
    var downloadActive by remember { mutableStateOf(false) }
    var confirmPrune by remember { mutableStateOf(false) }
    var job by remember { mutableStateOf<Job?>(null) }
    var pendingFile by remember { mutableStateOf<File?>(null) }
    var alive by remember { mutableStateOf(true) }

    fun action(operation: suspend () -> Unit) {
        if(busy) return
        job = scope.launch {
            busy = true; notice = ""
            try { operation() }
            catch(error: CancellationException) { if(alive) notice = "已取消，临时下载已清理。"; throw error }
            catch(error: Exception) {
                if(error is DeviceApiError && error.code in listOf("unknown_method", "not_supported")) supported = false
                else notice = remoteErrorMessage(error)
            } finally { if(alive) { busy = false; downloadActive = false } }
        }
    }
    suspend fun load(cursor: String? = null) {
        val params = JSONObject().put("sessionId", sessionId).put("limit", 50)
        if(cursor != null) params.put("cursor", cursor)
        val result = request("artifacts.list", params)
        val incoming = result.optJSONArray("items").objects().map(ArtifactItem::parse)
        items = if(cursor == null) incoming else (items + incoming).distinctBy { it.id }
        nextList = if(result.isNull("nextCursor")) null else result.optString("nextCursor").takeIf { it.isNotBlank() }
    }
    val saveLauncher = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri ->
        val file = pendingFile; pendingFile = null
        if(file == null || uri == null || !alive) file?.delete()
        else action {
            try {
                withContext(Dispatchers.IO) {
                    currentCoroutineContext().ensureActive()
                    context.contentResolver.openOutputStream(uri, "wt")?.use { output ->
                        file.inputStream().use { input ->
                            val buffer = ByteArray(64 * 1024)
                            while(true) {
                                currentCoroutineContext().ensureActive()
                                val count = input.read(buffer); if(count < 0) break
                                output.write(buffer, 0, count)
                            }
                            output.flush()
                        }
                    } ?: error("无法写入所选保存位置。")
                }
                notice = "已保存通过 SHA-256 校验的产物。文件未自动打开或执行。"
            } finally { withContext(NonCancellable + Dispatchers.IO) { file.delete() } }
        }
    }
    DisposableEffect(Unit) { onDispose { alive = false; job?.cancel(); pendingFile?.delete(); pendingFile = null } }
    LaunchedEffect(Unit) {
        action {
            val status = request("status", JSONObject())
            val features = status.optJSONArray("features")
            supported = features != null && (0 until features.length()).any { features.optString(it) == "artifacts.v1" }
            if(supported == true) load()
        }
    }

    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("本机产物", style = MaterialTheme.typography.titleMedium)
        Text("完整工具文本保存在被控电脑。这里只显示当前会话有权访问的产物；下载不会自动打开或执行文件。", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if(shared) Text("共享会话：仅可查看和下载，不能固定或清理。", fontSize = 12.sp)
        when(supported) {
            null -> Text("正在检查设备能力…")
            false -> Text("当前设备版本不支持产物访问，请先升级被控电脑和网关。")
            true -> {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { action { load() } }, enabled = !busy) { Text("刷新产物") }
                    if(!shared) OutlinedButton(onClick = { confirmPrune = true }, enabled = !busy) { Text("清理到期产物") }
                }
                if(items.isEmpty() && !busy) Text("此会话暂时没有已归档产物。")
                items.forEach { item ->
                    OutlinedCard(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(item.id, fontSize = 11.sp)
                            Text("${item.size} 字节 · ${item.mime}" + if(item.pinned) " · 已固定" else if(item.referenced) " · 对话仍在引用" else "", fontSize = 11.sp)
                            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                TextButton(onClick = {
                                    selected = item; preview = ""; nextRead = null; readOffset = 0; query = ""; searchResult = ""; nextSearch = null
                                    action {
                                        val page = request("artifacts.read", JSONObject().put("sessionId", sessionId).put("id", item.id).put("limit", 16384))
                                        val chunk = decodeArtifactChunk(page, item, 0, 16384)
                                        preview = chunk.bytes.toString(Charsets.UTF_8); previewOffset = 0; readOffset = chunk.bytes.size.toLong(); nextRead = chunk.nextCursor
                                    }
                                }, enabled = !busy) { Text("预览") }
                                TextButton(onClick = { action {
                                    downloadActive = true; downloaded = 0; downloadTotal = item.size
                                    val file = downloadArtifactToCache(item, sessionId, File(context.cacheDir, "artifact-downloads"), request) { count, total ->
                                        withContext(Dispatchers.Main) { downloaded = count; downloadTotal = total }
                                    }
                                    try {
                                        currentCoroutineContext().ensureActive()
                                        pendingFile?.delete(); pendingFile = file
                                        notice = "校验通过，请选择保存位置。"
                                        busy = false
                                        if(onVerifiedDownload != null) onVerifiedDownload(file, item) else saveLauncher.launch("${item.id}.txt")
                                    } catch(error: Throwable) { file.delete(); throw error }
                                } }, enabled = !busy) { Text("下载") }
                                if(!shared) TextButton(onClick = { action {
                                    request("artifacts.pin", JSONObject().put("sessionId", sessionId).put("id", item.id).put("pinned", !item.pinned)); load()
                                } }, enabled = !busy) { Text(if(item.pinned) "取消固定" else "固定") }
                            }
                        }
                    }
                }
                nextList?.let { cursor -> TextButton(onClick = { action { load(cursor) } }, enabled = !busy) { Text("更多产物") } }
                selected?.let { item ->
                    HorizontalDivider()
                    Text("纯文本预览 · 字节 $previewOffset", fontSize = 12.sp)
                    SelectionContainer { Text(preview, Modifier.fillMaxWidth().heightIn(max = 260.dp).verticalScroll(rememberScrollState()).testTag("artifact-preview"), fontSize = 12.sp) }
                    nextRead?.let { cursor -> TextButton(onClick = { action {
                        val page = request("artifacts.read", JSONObject().put("sessionId", sessionId).put("id", item.id).put("cursor", cursor).put("limit", 16384))
                        val chunk = decodeArtifactChunk(page, item, readOffset, 16384)
                        previewOffset = readOffset; preview = chunk.bytes.toString(Charsets.UTF_8); readOffset += chunk.bytes.size; nextRead = chunk.nextCursor
                    } }, enabled = !busy) { Text("下一页文本") } }
                    OutlinedTextField(query, { query = it; nextSearch = null; searchResult = "" }, label = { Text("搜索完整文本") }, modifier = Modifier.fillMaxWidth(), singleLine = true, enabled = !busy)
                    fun search(cursor: String? = null) { action {
                        val params = JSONObject().put("sessionId", sessionId).put("id", item.id).put("query", query).put("maxMatches", 50)
                        if(cursor != null) params.put("cursor", cursor)
                        val result = request("artifacts.search", params)
                        require(result.optString("id") == item.id && result.optString("sha256") == item.sha256) { "产物快照已改变，请刷新。" }
                        val offsets = result.optJSONArray("matches").objects().map { it.optLong("offset", -1) }
                        require(offsets.size <= 100 && offsets.all { it in 0..item.size }) { "搜索结果无效。" }
                        searchResult = if(offsets.isEmpty()) "本次扫描未找到匹配。" else "匹配字节位置：${offsets.joinToString("、")}"
                        nextSearch = if(result.isNull("nextCursor")) null else result.optString("nextCursor").takeIf { it.isNotBlank() }
                    } }
                    Row {
                        TextButton(onClick = { search() }, enabled = !busy && query.isNotBlank()) { Text("搜索") }
                        nextSearch?.let { cursor -> TextButton(onClick = { search(cursor) }, enabled = !busy) { Text("继续扫描") } }
                    }
                    if(searchResult.isNotBlank()) Text(searchResult, fontSize = 12.sp)
                }
            }
        }
        if(downloadActive) { LinearProgressIndicator(progress = { if(downloadTotal > 0) downloaded.toFloat() / downloadTotal else 0f }, modifier = Modifier.fillMaxWidth()); Text("下载并校验：$downloaded / $downloadTotal 字节", fontSize = 12.sp) }
        if(busy) TextButton(onClick = { job?.cancel() }) { Text("取消当前操作") }
        if(notice.isNotBlank()) Text(notice, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 12.sp)
    }
    if(confirmPrune) AlertDialog(onDismissRequest = { confirmPrune = false }, title = { Text("清理到期产物？") },
        text = { Text("只清理已到期、无引用、任务已停止且结果已确认的产物。固定、对话仍引用及结果未决的证据会保留。") },
        confirmButton = { TextButton(onClick = { confirmPrune = false; action { val result = request("artifacts.prune", JSONObject().put("sessionId", sessionId).put("confirmed", true)); load(); notice = "已清理 ${result.optJSONArray("removed")?.length() ?: 0} 个到期产物。" } }) { Text("确认清理") } },
        dismissButton = { TextButton(onClick = { confirmPrune = false }) { Text("取消") } })
}
