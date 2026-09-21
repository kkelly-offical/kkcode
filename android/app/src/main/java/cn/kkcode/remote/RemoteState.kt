package cn.kkcode.remote

import android.app.Application
import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.*
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject

data class ChatItem(val id: String, val kind: String, val text: String, val detail: String = "", val tool: JSONObject? = null, val startedAt: Long = 0, val durationMs: Long? = null, val done: Boolean = true, val turnId: String = "", val step: Int? = null, val streamed: Boolean = false)
class RemoteState @JvmOverloads constructor(application: Application, restoreConnections: Boolean = true) : AndroidViewModel(application) {
    val vault = CredentialVault(application)
    private val prefs = application.getSharedPreferences("kkcode.ui", 0)
    private val ssh = SshConnection()
    var api by mutableStateOf<DeviceApi?>(null)
    var devices by mutableStateOf(emptyList<JSONObject>())
    var sessions by mutableStateOf(emptyList<JSONObject>())
    var messages by mutableStateOf(emptyList<ChatItem>())
    var approvals by mutableStateOf(emptyList<JSONObject>())
    var folders by mutableStateOf(emptyList<JSONObject>())
    var commands by mutableStateOf(emptyList<JSONObject>())
    var settings by mutableStateOf(JSONObject())
    var extensions by mutableStateOf(JSONObject())
    var selected by mutableStateOf("")
    var cwd by mutableStateOf("")
    var deviceName by mutableStateOf("未连接设备")
    var profile by mutableStateOf(JSONObject())
    var connected by mutableStateOf(false)
    var busy by mutableStateOf(false)
    var loading by mutableStateOf(false)
    var mode by mutableStateOf("agent")
    var model by mutableStateOf("")
    var provider by mutableStateOf("")
    var modelOptions by mutableStateOf(emptyList<JSONObject>())
    var catalogProvider by mutableStateOf("")
    var draft by mutableStateOf("")
    var attachments by mutableStateOf(emptyList<JSONObject>())
    var uploading by mutableStateOf(false)
    var branchSnapshot by mutableStateOf(JSONObject())
    var commandItems by mutableStateOf(emptyList<JSONObject>())
    var commandPanels by mutableStateOf(emptyList<JSONObject>())
    var profilePreferences by mutableStateOf(JSONObject())
    var editingProvider by mutableStateOf("")
    var attachmentPickerRequest by mutableIntStateOf(0)
    var appearance by mutableStateOf(prefs.getString("appearance", "dark") ?: "dark")
    var historyHasMore by mutableStateOf(false)
    var historyBefore by mutableStateOf("")
    var loadingHistory by mutableStateOf(false)
    var commandItemKind by mutableStateOf("")
    var controlElsewhere by mutableStateOf(false)
    var sharedDevice by mutableStateOf(false)
    private var sharedPermissions by mutableStateOf(JSONObject())
    val canControl: Boolean get() = !sharedDevice || sharedPermissions.optString(selected) == "control"
    var notice by mutableStateOf("")
    var loginCode by mutableStateOf("")
    var fingerprint by mutableStateOf("")
    var gateway by mutableStateOf(vault.get("gateway") ?: "")
    private var currentSheet by mutableStateOf("")
    private val sheetHistory = mutableListOf<String>()
    var sheet: String
        get() = currentSheet
        set(value) {
            if (value == currentSheet) return
            if (value.isBlank()) sheetHistory.clear()
            else if (currentSheet.isNotBlank()) sheetHistory.add(currentSheet)
            currentSheet = value
        }
    val canGoBack: Boolean get() = sheetHistory.isNotEmpty()
    fun backSheet() { currentSheet = sheetHistory.removeLastOrNull() ?: "" }
    var autoConnect by mutableStateOf(prefs.getBoolean("autoConnect", true))
    var showContext by mutableStateOf(prefs.getBoolean("showContext", true))
    private var polling: Job? = null
    private var devicePolling: Job? = null
    private var manualDisconnect = false
    private var persistedSteps = emptySet<String>()
    private var persistedUserTurns = emptySet<String>()
    private var credentials: JSONObject? = null
    private var refreshAt = 0L
    private val refreshMutex = Mutex()
    init { if (restoreConnections && autoConnect) restore() }
    fun action(block: suspend () -> Unit) = viewModelScope.launch { try { notice = ""; block() } catch (e: CancellationException) { throw e } catch (e: Exception) { notice = e.message ?: "连接暂不可用" } }
    fun preference(name: String, value: Boolean) { prefs.edit().putBoolean(name, value).apply(); if (name == "autoConnect") autoConnect = value else showContext = value }
    fun restore() = action {
        val saved = vault.get("credentials") ?: return@action
        credentials = JSONObject(saved)
        val client = DeviceApi(gateway, credentials!!.getString("access_token"))
        api = client; refreshAt = credentials!!.optLong("expiresAt", 0)
        refreshToken()
        profile = credentials!!.optJSONObject("profile") ?: JSONObject()
        loadDevices()
    }
    suspend fun refreshToken() = refreshMutex.withLock {
        val client = api ?: return
        val old = credentials ?: return
        if (!client.relay || System.currentTimeMillis() < refreshAt - 60000) return
        val next = client.call("/auth/refresh", JSONObject().put("refresh_token", old.getString("refresh_token")))
        refreshAt = System.currentTimeMillis() + next.getLong("expires_in") * 1000
        next.put("expiresAt", refreshAt); credentials = next; client.token = next.getString("access_token")
        vault.put("credentials", next.toString())
    }
    suspend fun rpc(method: String, params: JSONObject = JSONObject()): Any? { refreshToken(); return (api ?: error("先添加一个设备连接")).rpc(method, params) }
    suspend fun loadDevices() {
        manualDisconnect = false
        devices = api!!.call("/api/v1/devices").optJSONArray("items").objects()
        val previous = vault.get("selectedDevice")
        val first = devices.find { it.optString("id") == previous && it.optBoolean("online") } ?: devices.firstOrNull { it.optBoolean("online") }
        if (first != null) chooseDevice(first) else connected = false
        startDevicePolling()
    }
    private fun startDevicePolling() {
        devicePolling?.cancel()
        val client = api ?: return
        if(!client.relay) return
        devicePolling = viewModelScope.launch {
            while(isActive && api === client) {
                delay(10000)
                try {
                    refreshToken()
                    val updated = client.call("/api/v1/devices").optJSONArray("items").objects()
                    if(api !== client) return@launch
                    devices = updated
                    val active = updated.find { it.optString("id") == client.device }
                    if(client.device.isNotBlank() && active == null) {
                        disconnect(); notice = "设备访问已撤销，请选择其他连接"
                    } else if(active != null) {
                        sharedPermissions = active.optJSONObject("permissions") ?: JSONObject()
                        if(sharedDevice && selected.isNotBlank() && !sharedPermissions.has(selected)) {
                            leaveChat(); refreshSessions(); notice = "该会话的分享已撤销"
                        }
                        if(!active.optBoolean("online")) connected = false
                        else if(!connected && selected.isBlank()) chooseDevice(active)
                    } else if(!manualDisconnect) {
                        updated.firstOrNull { it.optBoolean("online") }?.let { chooseDevice(it) }
                    }
                } catch(error: CancellationException) { throw error }
                catch(_: Exception) { /* The session poll owns transient connection notices. */ }
            }
        }
    }
    suspend fun chooseDevice(device: JSONObject) {
        manualDisconnect = false
        api!!.device = device.getString("id"); deviceName = device.optString("name", "电脑")
        vault.put("selectedDevice", api!!.device)
        val status = rpc("status") as JSONObject
        cwd = status.getJSONArray("roots").optString(0, ""); connected = true; sharedDevice = status.optBoolean("shared")
        sharedPermissions = device.optJSONObject("permissions") ?: JSONObject()
        selected = ""; messages = emptyList(); attachments = emptyList(); draft = ""; polling?.cancel()
        refreshSessions(); commands = (rpc("commands.list") as? JSONArray).objects(); sheet = ""
    }
    suspend fun refreshSessions() { sessions = (rpc("sessions.list") as? JSONArray).objects() }
    fun login(openBrowser: (String) -> Unit = { url -> getApplication<Application>().startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }) = action {
        require(validGatewayUrl(gateway, BuildConfig.DEBUG)) { "请使用 HTTPS 网关地址，不支持 URL 用户名或密码" }
        loading = true
        try {
            val client = DeviceApi(gateway)
            val canonical = client.call("/api/v1/discovery").getString("gateway")
            require(validGatewayUrl(canonical, BuildConfig.DEBUG)) { "网关返回了不安全的登录地址" }
            gateway = canonical; client.base = gateway
            val flow = client.call("/auth/device", JSONObject().put("name", "KK Code Android").put("kind", "client"))
            loginCode = flow.getString("user_code")
            openBrowser(flow.getString("verification_uri_complete"))
            var token: JSONObject? = null
            val deadline = System.currentTimeMillis() + flow.getLong("expires_in") * 1000
            while (token == null && System.currentTimeMillis() < deadline) {
                delay(5000)
                try { token = client.call("/auth/token", JSONObject().put("device_code", flow.getString("device_code"))) }
                catch (e: Exception) { if (e.message != "authorization_pending" && e.message != "slow_down") throw e }
            }
            requireNotNull(token) { "登录已超时，请重试" }
            refreshAt = System.currentTimeMillis() + token.getLong("expires_in") * 1000
            token.put("expiresAt", refreshAt); credentials = token; client.token = token.getString("access_token"); api = client
            vault.put("gateway", gateway); vault.put("credentials", token.toString()); profile = token.getJSONObject("profile")
            loginCode = ""; awaitDevices()
        } finally { loading = false }
    }
    private suspend fun awaitDevices() { loadDevices(); sheet = if (devices.isEmpty()) "connections" else "" }
    fun connectSsh(host: String, port: String, user: String, password: String, key: String = "") = action {
        loading = true
        try {
            devicePolling?.cancel()
            api = ssh.connect(host, port.toInt(), user, password, vault.get("ssh:$host:$port"), privateKey = key)
            connected = true; deviceName = host; profile = JSONObject().put("name", user).put("organization", "SSH")
            val status = rpc("status") as JSONObject; cwd = status.getJSONArray("roots").getString(0)
            sharedDevice = false; sharedPermissions = JSONObject()
            commands = (rpc("commands.list") as? JSONArray).objects()
            refreshSessions(); sheet = ""; fingerprint = ""
        } catch (e: HostKeyRequired) { fingerprint = e.fingerprint; notice = "请核对电脑的 SSH 主机指纹" }
        finally { loading = false }
    }
    fun openSession(item: JSONObject) = action {
        polling?.cancel(); selected = item.getString("id"); cwd = item.optString("cwd", cwd)
        val snapshot = rpc("sessions.get", JSONObject().put("sessionId", selected)) as JSONObject
        applySnapshot(snapshot)
        attachments = emptyList(); draft = ""
        startPolling(snapshot.optLong("eventCursor")); sheet = ""
    }
    private fun applySnapshot(snapshot: JSONObject) {
        messages = snapshotMessages(snapshot)
        val canonical = snapshot.optJSONArray("messages").objects()
        persistedSteps = canonical.filter { it.optString("role") == "assistant" && !it.optBoolean("truncated") }.mapNotNull { streamStepKey(it.optString("turnId"), it.stepOrNull()) }.toSet()
        persistedUserTurns = canonical.filter { it.optString("role") == "user" }.map { it.optString("turnId") }.filter { it.isNotBlank() }.toSet()
        // Prefix events belong to this exact eventCursor; consume them once before
        // polling newer deltas, not through an independent historical replay.
        snapshot.optJSONArray("liveEvents").objects().forEach { applyConversationEvent(it) }
        applySelection(snapshot)
        busy = snapshot.optBoolean("running")
        approvals = snapshot.optJSONArray("approvals").objects()
        historyHasMore = snapshot.optBoolean("historyHasMore")
        historyBefore = snapshot.optString("nextBefore")
        if(snapshot.optBoolean("liveTruncated")) notice = "部分实时内容已超出预览缓存，完整回复会在完成后同步"
    }
    private fun snapshotMessages(snapshot: JSONObject): List<ChatItem> {
        val history = snapshot.optJSONArray("messages").objects().filter { it.optString("role") in listOf("user", "assistant") }.flatMap {
            val content = it.opt("content")
            val text = if (content is JSONArray) content.objects().filter { b -> b.optString("type") == "text" }.joinToString("\n") { b -> b.optString("text") } else content?.toString() ?: ""
            val reasoning = (content as? JSONArray).objects().filter { b -> b.optString("type") == "reasoning" }.mapIndexed { index, b -> ChatItem("${it.optString("id")}-thinking-$index", "thinking", b.optString("text"), startedAt = it.optLong("createdAt"), turnId = it.optString("turnId"), step = it.stepOrNull()) }
            reasoning + ChatItem(it.optString("id"), if(text.contains("<compaction-summary")) "compacted" else it.optString("role"), text, startedAt = it.optLong("createdAt"), turnId = it.optString("turnId"), step = it.stepOrNull())
        }.filter { it.text.isNotBlank() }
        val tools = linkedMapOf<String, ChatItem>()
        for(part in snapshot.optJSONArray("parts").objects().filter { it.optString("type") == "tool-call" }) {
            val id = part.optString("runPartId").ifBlank { part.getString("id") }
            tools[id] = ChatItem(id, "tool", part.optString("tool"), part.optString("output"), tool = part, startedAt = tools[id]?.startedAt ?: part.optLong("createdAt"), turnId = part.optString("turnId"), step = part.stepOrNull())
        }
        return (history + tools.values).sortedBy { it.startedAt }
    }
    fun loadEarlier() = action {
        if(!historyHasMore || historyBefore.isBlank() || loadingHistory) return@action
        val session = selected
        loadingHistory = true
        try {
            val snapshot = rpc("sessions.get", JSONObject().put("sessionId", session).put("before", historyBefore).put("limit", 100)) as JSONObject
            if(selected == session) {
                // Keep the current stream and its cursor intact while prepending a bounded page.
                val current = messages.map { it.id }.toSet()
                messages = snapshotMessages(snapshot).filterNot { it.id in current } + messages
                historyHasMore = snapshot.optBoolean("historyHasMore"); historyBefore = snapshot.optString("nextBefore")
            }
        } finally { loadingHistory = false }
    }
    fun newChat() = action {
        if (!connected) { sheet = "connections"; return@action }
        require(!sharedDevice) { "共享会话不能创建新的电脑会话" }
        val created = rpc("sessions.create", JSONObject().put("cwd", cwd)) as JSONObject
        val id = created.getString("id")
        rpc("control.acquire", JSONObject().put("sessionId", id))
        try { applySelection(rpc("sessions.configure", JSONObject().put("sessionId", id).put("mode", mode).also { if(model.isNotBlank()) it.put("model", model); if(provider.isNotBlank()) it.put("provider", provider) }) as JSONObject) }
        finally { rpc("control.release", JSONObject().put("sessionId", id)) }
        selected = created.getString("id"); messages = emptyList(); persistedSteps = emptySet(); persistedUserTurns = emptySet(); attachments = emptyList(); draft = ""; historyHasMore = false; historyBefore = ""; startPolling(0); refreshSessions(); sheet = ""
    }
    private fun startPolling(initial: Long) {
        polling?.cancel(); val sessionId = selected
        polling = viewModelScope.launch {
            var cursor = initial
            while (isActive) {
                try {
                    val batch = rpc("events.list", JSONObject().put("sessionId", sessionId).put("after", cursor)) as JSONObject
                    if(batch.optBoolean("gap")) {
                        val snapshot = rpc("sessions.get", JSONObject().put("sessionId", sessionId)) as JSONObject
                        if(selected != sessionId) return@launch
                        applySnapshot(snapshot); cursor = snapshot.optLong("eventCursor")
                        if(!snapshot.optBoolean("liveTruncated")) notice = "历史事件已归档，已重新同步完整会话"
                        continue
                    }
                    for (event in batch.optJSONArray("events").objects()) {
                        cursor = event.getLong("seq"); val type = event.getString("type"); val payload = event.optJSONObject("payload") ?: JSONObject()
                        if(applyConversationEvent(event)) { if(type == "turn.result") refreshSessions(); continue }
                        when(type) {
                            "tool.start", "tool.finish", "tool.error" -> {
                                finishThinking(event.optLong("timestamp"))
                                val id = payload.optString("invocationId").ifBlank { event.getString("id") }
                                if(!payload.has("status")) payload.put("status", if(type == "tool.start") "running" else if(type == "tool.error") "error" else "completed")
                                val item = ChatItem(id, "tool", payload.optString("tool", "Tool"), payload.optString("output"), tool = payload, turnId = event.optString("turnId"), step = payload.stepOrNull())
                                messages = if(messages.any { it.id == id }) messages.map { if(it.id == id) item else it } else messages + item
                            }
                            "session.compacted", "stream.provider_compaction" -> messages = messages + ChatItem(event.getString("id"), "compacted", "已精简上下文")
                            "session.configured" -> applySelection(payload)
                            "branch.changed", "session.branch.changed" -> { branchSnapshot = JSONObject(); if(sheet == "branches") loadBranches() }
                        }
                    }
                    approvals = batch.optJSONArray("approvals").objects(); connected = true
                    busy = batch.optBoolean("running")
                    controlElsewhere = batch.optJSONObject("control")?.optBoolean("yours") == false
                } catch (e: CancellationException) { throw e } catch (e: Exception) { connected = false; notice = e.message ?: "连接断开，正在重试" }
                delay(1000)
            }
        }
    }
    private fun applyConversationEvent(event: JSONObject): Boolean {
        val type = event.optString("type")
        val payload = event.optJSONObject("payload") ?: JSONObject()
        val turn = event.optString("turnId").ifBlank { payload.optString("turnId") }
        val step = payload.stepOrNull()
        val timestamp = event.optLong("timestamp")
        when(type) {
            "stream.text.delta", "stream.thinking.delta" -> {
                if(type == "stream.text.delta") finishThinking(timestamp)
                messages = appendStreamDelta(messages, StreamDelta(event.optString("id"), if(type == "stream.text.delta") "assistant" else "thinking", payload.optString("text"), turn, step, timestamp), persistedSteps)
            }
            "stream.end" -> messages = finishStreamStep(messages, turn, step, timestamp)
            "turn.start" -> {
                busy = true
                if(turn !in persistedUserTurns && payload.optString("prompt").isNotBlank() && messages.none { it.kind == "user" && turn.isNotBlank() && it.turnId == turn }) messages = messages + ChatItem("${event.optString("id")}-user", "user", payload.getString("prompt"), startedAt = timestamp, turnId = turn)
            }
            "turn.finish", "turn.result" -> { busy = false; messages = finishStreamReply(messages, event.optString("id"), turn, step, payload.optString("reply"), timestamp) }
            "turn.failed" -> { messages = finishStreamStep(messages, turn, null, timestamp); busy = false; notice = payload.optString("error") }
            else -> return false
        }
        return true
    }
    private fun finishThinking(timestamp: Long) {
        messages = messages.map { if(it.kind == "thinking" && !it.done) it.copy(done = true, durationMs = (timestamp - it.startedAt).coerceAtLeast(0)) else it }
    }
    fun send(text: String) = action {
        if (selected.isBlank()) return@action
        require(canControl) { "这个会话是只读分享" }
        require(!uploading) { "请等待附件上传完成" }
        require(!text.startsWith('/') || attachments.isEmpty()) { "附件只能随消息发送，不能附在命令上" }
        rpc("control.acquire", JSONObject().put("sessionId", selected))
        if (text.startsWith('/')) {
            val origin = selected
            var accepted = false
            var released = false
            try {
                val result = rpc("commands.run", JSONObject().put("sessionId", origin).put("command", text))
                if(result is JSONObject) {
                    accepted = result.optBoolean("accepted")
                    if(!accepted) { rpc("control.release", JSONObject().put("sessionId", origin)); released = true }
                    handleCommandResult(text, result)
                }
                else messages = messages + ChatItem(java.util.UUID.randomUUID().toString(), "tool", text, result.toString())
                if(draft == text) draft = ""
            } finally { if(!accepted && !released) rpc("control.release", JSONObject().put("sessionId", origin)) }
        } else {
            try {
                rpc("turns.start", JSONObject().put("sessionId", selected).put("prompt", text.ifBlank { "请分析附件。" }).put("attachmentIds", JSONArray(attachments.map { it.getString("id") })))
                busy = true; attachments = emptyList(); if(draft == text) draft = ""
            } catch(error: Exception) { rpc("control.release", JSONObject().put("sessionId", selected)); throw error }
        }
    }
    fun stop() = action { rpc("control.acquire", JSONObject().put("sessionId", selected)); rpc("turns.cancel", JSONObject().put("sessionId", selected)) }
    fun answer(id: String, value: Any) = action { rpc("approvals.resolve", JSONObject().put("sessionId", selected).put("id", id).put("answer", value)) }
    fun takeControl() = action { rpc("control.acquire", JSONObject().put("sessionId", selected).put("takeover", true)); controlElsewhere = false }
    private fun applySelection(value: JSONObject) { if(value.has("model")) model = value.optString("model"); if(value.has("providerType")) provider = value.optString("providerType"); if(value.has("modeId")) mode = value.optString("modeId") }
    fun selectModel(name: String, id: String) = action {
        require(!sharedDevice) { "只有电脑所有者可以切换模型" }
        if(selected.isBlank()) { provider = name; model = id }
        else {
            rpc("control.acquire", JSONObject().put("sessionId", selected))
            try { applySelection(rpc("sessions.configure", JSONObject().put("sessionId", selected).put("provider", name).put("model", id)) as JSONObject) }
            finally { rpc("control.release", JSONObject().put("sessionId", selected)) }
        }
        sheet = ""; notice = "模型已切换"
    }
    fun selectMode(value: String) = action {
        require(!sharedDevice) { "只有电脑所有者可以切换执行模式" }
        if(selected.isBlank()) mode = value
        else {
            rpc("control.acquire", JSONObject().put("sessionId", selected))
            try { applySelection(rpc("sessions.configure", JSONObject().put("sessionId", selected).put("mode", value)) as JSONObject) }
            finally { rpc("control.release", JSONObject().put("sessionId", selected)) }
        }
        sheet = ""; notice = "执行模式已同步"
    }
    fun discoverModels(name: String) = action { modelOptions = (rpc("models.discover", JSONObject().put("provider", name)) as JSONObject).optJSONArray("models").objects(); catalogProvider = name }
    internal suspend fun handleCommandResult(command: String, result: JSONObject) {
        applySelection(result.optJSONObject("state") ?: result)
        commandItems = result.optJSONArray("items").objects()
        commandItemKind = result.optString("clientAction")
        commandPanels = result.optJSONArray("panels").objects()
        val output = result.optJSONArray("output").objects().joinToString("\n") { it.optString("text") }
        if(output.isNotBlank()) messages = messages + ChatItem(java.util.UUID.randomUUID().toString(), "tool", command, output)
        val args = result.optString("args")
        when(result.optString("clientAction")) {
            "exit" -> disconnect()
            "home" -> leaveChat()
            "clear" -> messages = emptyList()
            "keys" -> sheet = "keys"
            "theme" -> if(args in listOf("dark", "light", "auto")) updateAppearance(args) else sheet = "theme"
            "paste" -> { draft = args; attachmentPickerRequest++ }
            "profile", "like" -> { profilePreferences = result.optJSONObject("preferences") ?: rpc("profile.get") as JSONObject; sheet = "preferences" }
            "sessions" -> { refreshSessions(); sheet = "sessions" }
            "session" -> { refreshSessions(); val id = result.optString("sessionId"); if(id.isNotBlank()) openSession(JSONObject().put("id", id).put("cwd", result.optString("cwd", cwd))).join(); if(result.has("draft")) draft = result.getString("draft") }
            "models" -> { settings = rpc("settings.get") as JSONObject; sheet = "models" }
            "provider" -> {
                settings = rpc("settings.get") as JSONObject
                editingProvider = if(args.startsWith("edit ")) args.removePrefix("edit ").trim() else ""
                sheet = if(args == "add" || editingProvider.isNotBlank()) "provider" else "models"
            }
            "mode" -> sheet = "mode"
            "permission" -> sheet = "permission"
            "" -> if(commandPanels.isNotEmpty()) sheet = "command-result"
            else -> { notice = "此命令返回了暂不支持的操作：${result.optString("clientAction")}"; if(commandPanels.isNotEmpty()) sheet = "command-result" }
        }
    }
    fun updateAppearance(value: String) { require(value in listOf("dark", "light", "auto")); appearance = value; prefs.edit().putString("appearance", value).apply(); sheet = "" }
    fun savePreferences(value: JSONObject) = action { profilePreferences = rpc("profile.update", JSONObject().put("profile", value)) as JSONObject; notice = "偏好已保存到电脑"; sheet = "" }
    fun attach(uri: Uri) = action {
        require(!sharedDevice && selected.isNotBlank()) { "请先打开自己的会话" }
        require(attachments.size < 8) { "一次最多发送 8 个附件" }
        uploading = true
        val session = selected
        try {
            val input = withContext(Dispatchers.IO) { readAttachment(getApplication<Application>().contentResolver, uri) }
            val result = rpc("attachments.upload", input.put("sessionId", session)) as JSONObject
            if(selected == session) attachments = attachments + result else rpc("attachments.remove", JSONObject().put("sessionId", session).put("id", result.getString("id")))
        } finally { uploading = false }
    }
    fun removeAttachment(id: String) = action { rpc("attachments.remove", JSONObject().put("sessionId", selected).put("id", id)); attachments = attachments.filterNot { it.optString("id") == id } }
    fun loadBranches() = action {
        require(!sharedDevice) { "只有电脑所有者可以修改分支" }
        branchSnapshot = rpc("branches.list", if(selected.isBlank()) JSONObject().put("cwd", cwd) else JSONObject().put("sessionId", selected)) as JSONObject
        sheet = "branches"
    }
    fun changeBranch(name: String, create: Boolean, token: String) = action {
        require(!sharedDevice && selected.isNotBlank()) { "请先打开自己的会话" }
        rpc("control.acquire", JSONObject().put("sessionId", selected))
        try { branchSnapshot = rpc(if(create) "branches.create" else "branches.switch", JSONObject().put("sessionId", selected).put("name", name).put("confirmed", true).put("stateToken", token)) as JSONObject; notice = "已${if(create) "创建并切换" else "切换"}到分支 $name" }
        finally { rpc("control.release", JSONObject().put("sessionId", selected)) }
    }
    fun browse(target: String = cwd) = action { val listing = rpc("folders.list", JSONObject().put("path", target)) as JSONObject; cwd = listing.getString("path"); folders = listing.optJSONArray("entries").objects(); sheet = "folders" }
    fun openSettings() = action { if(connected && !sharedDevice) settings = rpc("settings.get") as JSONObject; sheet = "settings" }
    fun saveProvider(name: String, type: String, base: String, key: String, modelId: String) = action {
        require(name.matches(Regex("[A-Za-z0-9_-]+"))) { "渠道名称只能包含字母、数字、连字符与下划线" }
        val result = rpc("settings.update", JSONObject().put("config", JSONObject().put("provider", JSONObject().put("default", name).put(name, JSONObject().put("type", type).put("base_url", base).put("api_key", key).put("default_model", modelId))))) as JSONObject
        settings = result.optJSONObject("config") ?: rpc("settings.get") as JSONObject
        if(selected.isNotBlank()) {
            rpc("control.acquire", JSONObject().put("sessionId", selected))
            try { applySelection(rpc("sessions.configure", JSONObject().put("sessionId", selected).put("provider", name).put("model", modelId)) as JSONObject) }
            finally { rpc("control.release", JSONObject().put("sessionId", selected)) }
        } else { provider = name; model = modelId }
        notice = "渠道已保存并立即生效"; backSheet()
    }
    fun loadExtensions() = action { extensions = rpc("extensions.list") as JSONObject; sheet = "extensions" }
    fun leaveChat() { polling?.cancel(); selected = ""; messages = emptyList(); persistedSteps = emptySet(); persistedUserTurns = emptySet(); approvals = emptyList(); attachments = emptyList(); draft = ""; historyHasMore = false; historyBefore = ""; busy = false }
    fun disconnect() { manualDisconnect = true; leaveChat(); ssh.close(); if(api?.relay == false) api = null; else api?.device = ""; connected = false; deviceName = "未连接设备"; sessions = emptyList() }
    fun logout() = action {
        devicePolling?.cancel()
        try { if(api?.relay == true) api!!.call("/auth/logout", JSONObject()) }
        finally { vault.clear("credentials"); credentials = null; profile = JSONObject(); disconnect(); api = null; devices = emptyList(); sheet = "" }
    }
    override fun onCleared() { polling?.cancel(); devicePolling?.cancel(); ssh.close(); super.onCleared() }
}
internal fun JSONArray?.objects(): List<JSONObject> = if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it) }
internal fun JSONObject.stepOrNull(): Int? = if(has("step") && !isNull("step")) (opt("step") as? Number)?.toInt() else null
