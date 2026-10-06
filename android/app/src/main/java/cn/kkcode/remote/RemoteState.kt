package cn.kkcode.remote

import android.app.Application
import android.net.Uri
import androidx.compose.runtime.*
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject

data class ChatItem(val id: String, val kind: String, val text: String, val detail: String = "", val tool: JSONObject? = null, val startedAt: Long = 0, val durationMs: Long? = null, val done: Boolean = true, val turnId: String = "", val step: Int? = null, val streamed: Boolean = false, val messageId: String = "", val media: JSONObject? = null, val children: List<ChatItem> = emptyList())
class RemoteState @JvmOverloads constructor(application: Application, restoreConnections: Boolean = true, private val sshFactory: () -> SshConnection = { SshConnection() }) : AndroidViewModel(application) {
    internal val updater = AppUpdater(application, viewModelScope)
    val vault = CredentialVault(application)
    private val prefs = application.getSharedPreferences("kkcode.ui", 0)
    private var ssh: SshConnection? = null
    private var gatewayApi: DeviceApi? = null
    private var sshHeartbeat: Job? = null
    private var sshRecovery: Job? = null
    private var connectionGeneration = 0
    var sshProfiles by mutableStateOf(emptyList<JSONObject>())
    var selectedSsh by mutableStateOf("")
    var editingSsh by mutableStateOf<JSONObject?>(null)
    private var sshRevision = 0
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
    var projectFilter by mutableStateOf("")
    var historyTarget by mutableStateOf("")
    var readingScale by mutableStateOf(prefs.getFloat("readingScale", 1f).takeIf { it in listOf(1f, 1.1f, 1.25f) } ?: 1f)
    var deviceName by mutableStateOf("未连接设备")
    var profile by mutableStateOf(JSONObject())
    var connected by mutableStateOf(false)
    var busy by mutableStateOf(false)
    var stopping by mutableStateOf(false)
    var turnPhase by mutableStateOf("idle")
    var turnOperation by mutableStateOf("")
    private var activeExecution = ""
    private var stopRequested = ""
    private var stopJob: Job? = null
    private val settledExecutions = linkedSetOf<String>()
    private class PendingSend(val sessionId: String, val executionId: String, val generation: Int, val text: String, val attachmentIds: Set<String>) {
        var cancelled = false
        var dispatched = false
        var acknowledged = false
        var terminal = false
        val started = CompletableDeferred<JSONObject?>()
        val finished = CompletableDeferred<Unit>()
    }
    private var pendingSend: PendingSend? = null
    private var steeringInFlight = false
    var contextUsage by mutableStateOf(JSONObject())
    var todos by mutableStateOf<JSONObject?>(null)
        private set
    var subagents by mutableStateOf(emptyList<JSONObject>())
        private set
    private var sessionGeneration = 0
    var loading by mutableStateOf(false)
    var mode by mutableStateOf("agent")
    var approval by mutableStateOf("")
    var model by mutableStateOf("")
    var provider by mutableStateOf("")
    var modelOptions by mutableStateOf(emptyList<JSONObject>())
    var catalogProvider by mutableStateOf("")
    var catalogSource by mutableStateOf("")
    var catalogStale by mutableStateOf(false)
    var catalogError by mutableStateOf("")
    var catalogLoading by mutableStateOf(false)
    private var catalogRequest = 0
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
    var managedSession by mutableStateOf<JSONObject?>(null)
    var managedSessionAction by mutableStateOf("menu")
    var subagentSyncNotice by mutableStateOf("")
    var lastTurnOutcome by mutableStateOf("")
    var rewindTarget by mutableStateOf<ChatItem?>(null)
    var savingSession by mutableStateOf(false)
    var sessionArchived by mutableStateOf(false)
    private var snapshotLastMessage = ""
    private var snapshotCursor = 0L
    var controlElsewhere by mutableStateOf(false)
    var sharedDevice by mutableStateOf(false)
    private var sharedPermissions by mutableStateOf(JSONObject())
    val canControl: Boolean get() = !sharedDevice || sharedPermissions.optString(selected) == "control"
    private var currentNotice by mutableStateOf("")
    private var noticeExpiry: Job? = null
    var notice: String
        get() = currentNotice
        set(value) {
            if(value.isNotBlank() && value == lastConnectionError && connectionPhase in listOf("reconnecting", "offline")) return
            if(value == currentNotice) return
            currentNotice = value; noticeExpiry?.cancel()
            if(value.isNotBlank()) noticeExpiry = viewModelScope.launch { delay(8000); if(currentNotice == value) currentNotice = "" }
        }
    var connectionNotice by mutableStateOf("")
        private set
    var connectionPhase by mutableStateOf("")
        private set
    private var connectionNoticeExpiry: Job? = null
    private var lastConnectionError = ""
    internal fun connectionLost(message: String, retrying: Boolean = true) {
        if(currentNotice == message) notice = ""
        lastConnectionError = message
        connected = false; connectionNoticeExpiry?.cancel()
        connectionPhase = if(retrying) "reconnecting" else "offline"
        connectionNotice = (if(retrying) "正在重连 · " else "连接已断开 · ") + message
    }
    internal fun connectionRestored() {
        connected = true
        if(connectionPhase !in listOf("reconnecting", "offline")) return
        if(currentNotice == lastConnectionError) notice = ""
        connectionPhase = "recovered"; connectionNotice = "连接已恢复"
        connectionNoticeExpiry?.cancel()
        connectionNoticeExpiry = viewModelScope.launch { delay(2500); if(connectionPhase == "recovered") { connectionNotice = ""; connectionPhase = "" } }
    }
    var loginCode by mutableStateOf("")
    var fingerprint by mutableStateOf("")
    var gateway by mutableStateOf(vault.get("gateway") ?: "")
    private var currentSheet by mutableStateOf("")
    private val sheetHistory = mutableListOf<String>()
    var sheet: String
        get() = currentSheet
        set(value) {
            val target = when(value) { "permission", "approval" -> "mode"; "keys" -> "settings"; "add" -> "relay"; else -> value }
            if (target == currentSheet) return
            if (target.isBlank()) sheetHistory.clear()
            else if (currentSheet.isNotBlank()) sheetHistory.add(currentSheet)
            currentSheet = target
        }
    val canGoBack: Boolean get() = sheetHistory.isNotEmpty()
    fun backSheet() { currentSheet = sheetHistory.removeLastOrNull() ?: "" }
    var autoConnect by mutableStateOf(prefs.getBoolean("autoConnect", true))
    var showContext by mutableStateOf(prefs.getBoolean("showContext", true))
    private var polling: Job? = null
    private var devicePolling: Job? = null
    private var deviceEvents: Job? = null
    private var deviceNotice: Job? = null
    private var manualDisconnect = false
    private var persistedSteps = emptySet<String>()
    private var persistedUserTurns = emptySet<String>()
    private var credentials: JSONObject? = null
    private var refreshAt = 0L
    private val refreshMutex = Mutex()
    private val sshProfilesMutex = Mutex()
    private var loginJob: Job? = null
    private var loginNotice: Job? = null
    private var loginGeneration = 0
    private var pendingLogin: PendingGatewayLogin? = if(restoreConnections) vault.get(PENDING_LOGIN_KEY)?.let {
        runCatching { PendingGatewayLogin.read(it, BuildConfig.DEBUG) }.getOrNull()
    } else null
    init {
        if(restoreConnections) {
            if(pendingLogin != null) {
                gateway = pendingLogin!!.gateway; loginCode = pendingLogin!!.userCode
                resumeLogin()
            } else restore()
        }
    }
    fun action(block: suspend () -> Unit) = viewModelScope.launch { try { notice = ""; block() } catch (e: CancellationException) { throw e } catch (e: Exception) { notice = remoteErrorMessage(e, api?.relay == false) } }
    internal fun observeTurnState(value: JSONObject) {
        if(!value.has("running")) return
        if(!value.optBoolean("running") && pendingSend?.let { it.sessionId == selected && it.generation == connectionGeneration && it.executionId !in settledExecutions } == true) return
        val state = value.optJSONObject("turnState")
        val execution = state?.optString("executionId").orEmpty()
        if(value.optBoolean("running") && execution.isNotBlank() && execution in settledExecutions) return
        if(execution.isNotBlank()) activeExecution = execution
        busy = value.optBoolean("running")
        turnOperation = state?.optString("operation").orEmpty()
        if(!busy) { activeExecution = ""; stopRequested = ""; stopping = false; turnPhase = "idle" }
        else {
            stopping = state?.optString("phase") == "stopping" || (stopRequested.isNotBlank() && (execution.isBlank() || stopRequested == execution))
            turnPhase = if(stopping) "stopping" else state?.optString("phase")?.takeIf { it.isNotBlank() } ?: "running"
        }
    }
    private fun settleExecution(execution: String) {
        pendingSend?.takeIf { it.executionId == execution }?.let { it.terminal = true; it.finished.complete(Unit); pendingSend = null }
        if(execution.isNotBlank()) { settledExecutions += execution; if(settledExecutions.size > 64) settledExecutions.remove(settledExecutions.first()) }
        if(execution.isNotBlank() && activeExecution.isNotBlank() && activeExecution != execution) return
        busy = false; stopping = false; turnPhase = "idle"; turnOperation = ""; activeExecution = ""; stopRequested = ""; stopJob = null
    }
    private fun acknowledgeSend(token: PendingSend) {
        if(token.acknowledged || selected != token.sessionId || connectionGeneration != token.generation) return
        token.acknowledged = true
        if(draft == token.text) draft = ""
        attachments = attachments.filter { it.optString("id") !in token.attachmentIds }
    }
    fun prepareResume() { if(!busy && canControl && !sessionArchived && draft.isBlank()) draft = "请从中断处继续。先核查已有结果和已执行的操作，不要重复已完成的改动。" }
    fun preference(name: String, value: Boolean) { prefs.edit().putBoolean(name, value).apply(); if (name == "autoConnect") autoConnect = value else showContext = value }
    fun updateReadingScale(value: Float) { if(value in listOf(1f, 1.1f, 1.25f)) { readingScale = value; prefs.edit().putFloat("readingScale", value).apply() } }
    fun chooseProject(path: String) {
        if(uploading) { notice = "附件上传中，请稍后切换项目"; return }
        leaveChat(); cwd = path; projectFilter = path; historyTarget = ""; sheet = ""
    }
    fun restore() = action {
        val saved = vault.get("credentials")
        if(saved == null) {
            loadSshProfiles()
            if(autoConnect) sshProfiles.find { it.optString("id") == vault.get("active-ssh:${accountScope()}") }?.let { chooseSsh(it, automatic = true) }
            return@action
        }
        credentials = JSONObject(saved)
        val client = DeviceApi(gateway, credentials!!.getString("access_token"))
        gatewayApi = client; api = client; refreshAt = credentials!!.optLong("expiresAt", 0)
        profile = credentials!!.optJSONObject("profile") ?: JSONObject()
        try { refreshToken() } catch(error: CancellationException) { throw error } catch(error: Exception) {
            loadSshProfiles()
            val savedSsh = sshProfiles.find { it.optString("id") == vault.get("active-ssh:${accountScope()}") }
            if(autoConnect && savedSsh != null) { chooseSsh(savedSsh, automatic = true); startDevicePolling(); return@action }
            throw error
        }
        if(autoConnect) loadDevices()
        else {
            // The startup preference governs device connection, not whether a
            // completed organization login survives process recreation.
            manualDisconnect = true; startDevicePolling()
            devices = client.call("/api/v1/devices").optJSONArray("items").objects()
        }
    }
    suspend fun refreshToken() = refreshMutex.withLock {
        val client = gatewayApi ?: api?.takeIf { it.relay } ?: return
        val old = credentials ?: return
        if (!client.relay || System.currentTimeMillis() < refreshAt - 60000) return
        val next = client.call("/auth/refresh", JSONObject().put("refresh_token", old.getString("refresh_token")))
        if(gatewayApi !== client || credentials !== old) return@withLock
        if(!next.has("profile")) next.put("profile", profile)
        refreshAt = System.currentTimeMillis() + next.getLong("expires_in") * 1000
        next.put("expiresAt", refreshAt); credentials = next; client.token = next.getString("access_token")
        vault.put("credentials", next.toString())
    }
    suspend fun rpc(method: String, params: JSONObject = JSONObject()): Any? {
        val client = api ?: error("先添加一个设备连接"); val target = client.device; val generation = connectionGeneration; val originSession = selected
        if(client.relay) refreshToken()
        if(api !== client || client.device != target || generation != connectionGeneration) throw CancellationException("设备已切换")
        val result = try { client.rpc(method, params, target) } catch(error: Exception) {
            if(api !== client || client.device != target || generation != connectionGeneration) throw CancellationException("设备已切换")
            if(params.optString("sessionId").isNotBlank() && params.optString("sessionId") == originSession && selected != originSession) throw CancellationException("会话已切换")
            if(error is java.io.IOException || error is DeviceApiError && error.status in listOf(502, 503, 504)) connectionLost(remoteErrorMessage(error, !client.relay))
            if(!client.relay && (error is java.io.IOException || error is DeviceApiError && error.status in listOf(401, 502, 503, 504))) { connected = false; resumeSshConnection(force = true) }
            throw error
        }
        if(api !== client || client.device != target || generation != connectionGeneration) throw CancellationException("设备已切换")
        return result
    }
    private data class ControlLease(val sessionId: String, val leaseId: String, val generation: Int, val client: DeviceApi?, val device: String)
    private suspend fun acquireControl(sessionId: String): ControlLease {
        val client = api; val target = client?.device.orEmpty(); val generation = connectionGeneration
        val result = rpc("control.acquire", JSONObject().put("sessionId", sessionId)) as? JSONObject
        return ControlLease(sessionId, result?.optString("leaseId").orEmpty(), generation, client, target)
    }
    private suspend fun releaseControl(lease: ControlLease) {
        if(lease.generation != connectionGeneration || api !== lease.client || api?.device.orEmpty() != lease.device) return
        rpc("control.release", JSONObject().put("sessionId", lease.sessionId).apply { if(lease.leaseId.isNotBlank()) put("leaseId", lease.leaseId) })
    }
    private fun clearDeviceSelection() {
        connectionNoticeExpiry?.cancel(); connectionNotice = ""; connectionPhase = ""; notice = ""
        catalogRequest++; catalogLoading = false
        model = ""; provider = ""; mode = "agent"; approval = ""; settings = JSONObject(); extensions = JSONObject()
        modelOptions = emptyList(); catalogProvider = ""; catalogSource = ""; catalogStale = false; catalogError = ""
        branchSnapshot = JSONObject(); commandItems = emptyList(); commandPanels = emptyList(); managedSession = null; rewindTarget = null
    }
    suspend fun loadDevices() {
        manualDisconnect = false
        val client = gatewayApi ?: api?.takeIf { it.relay } ?: return
        gatewayApi = client
        devices = client.call("/api/v1/devices").optJSONArray("items").objects()
        loadSshProfiles()
        val lastSsh = vault.get("active-ssh:${accountScope()}")
        if(autoConnect && !lastSsh.isNullOrBlank()) {
            sshProfiles.find { it.optString("id") == lastSsh }?.let { chooseSsh(it, automatic = true); startDevicePolling(); return }
        }
        val previous = vault.get("selectedDevice")
        val first = devices.find { it.optString("id") == previous && it.optBoolean("online") } ?: devices.firstOrNull { it.optBoolean("online") }
        if (first != null) chooseDevice(first) else connected = false
        startDevicePolling()
    }
    private fun startDevicePolling() {
        devicePolling?.cancel()
        val client = gatewayApi ?: api?.takeIf { it.relay } ?: return
        if(!client.relay) return
        devicePolling = viewModelScope.launch {
            while(isActive && gatewayApi === client) {
                delay(10000)
                try {
                    refreshToken()
                    val updated = client.call("/api/v1/devices").optJSONArray("items").objects()
                    if(gatewayApi !== client) return@launch
                    devices = updated
                    if(api !== client || selectedSsh.isNotBlank()) continue
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
        val relay = gatewayApi ?: api?.takeIf { it.relay } ?: error("请先登录网关")
        if(api === relay && selectedSsh.isBlank() && relay.device == device.optString("id") && connected) { sheet = ""; return }
        disconnect()
        val generation = connectionGeneration
        gatewayApi = relay; api = relay
        manualDisconnect = false
        api!!.device = device.getString("id"); deviceName = device.optString("name", "电脑")
        vault.put("selectedDevice", api!!.device)
        val status = rpc("status") as JSONObject
        if(generation != connectionGeneration) return
        cwd = status.getJSONArray("roots").optString(0, ""); connected = true; sharedDevice = status.optBoolean("shared")
        sharedPermissions = device.optJSONObject("permissions") ?: JSONObject()
        selected = ""; messages = emptyList(); attachments = emptyList(); draft = ""; polling?.cancel()
        refreshSessions()
        if(generation != connectionGeneration) return
        val availableCommands = visibleCommands((rpc("commands.list") as? JSONArray).objects())
        if(generation != connectionGeneration) return
        commands = availableCommands; sheet = ""
        startDeviceEvents()
    }
    private fun startDeviceEvents() {
        deviceEvents?.cancel()
        val client = api ?: return
        val device = client.device
        deviceEvents = viewModelScope.launch {
            var attempts = 0
            while(isActive && api === client && client.device == device && attempts <= 5) {
                try {
                    if(client.relay) refreshToken()
                    client.streamEvents("", 0).collect { frame ->
                        if(api !== client || client.device != device) return@collect
                        if(frame.event == "connected") attempts = 0
                        val event = JSONObject(frame.data)
                        val message = mcpLoadNotice(event)
                        if(message.isNotBlank()) {
                            notice = message; deviceNotice?.cancel()
                            deviceNotice = viewModelScope.launch { delay(6500); if(notice == message) notice = "" }
                        }
                        if(frame.event == "session.status") { if(event.optBoolean("deleted") && event.optString("sessionId") == selected) leaveChat(); refreshSessions() }
                        if(frame.event in listOf("settings.updated", "models.updated") && !sharedDevice) settings = rpc("settings.get") as JSONObject
                    }
                } catch(error: CancellationException) { throw error }
                catch(error: Exception) {
                    if(error is DeviceApiError && (error.status in listOf(401, 403, 404, 405, 501) || error.code == "not_sse")) break
                }
                attempts++; delay((500L shl attempts.coerceAtMost(5)).coerceAtMost(10000))
            }
        }
    }
    suspend fun refreshSessions() {
        val client = api; val device = client?.device; val generation = connectionGeneration
        val items = (rpc("sessions.list") as? JSONArray).objects()
        if(generation == connectionGeneration && api === client && client?.device == device) sessions = items
    }
    private fun visibleCommands(items: List<JSONObject>) = items.filterNot { it.optString("name") in listOf("keys", "permission") }
    fun updateSession(target: JSONObject, patch: JSONObject) = action {
        require(!sharedDevice && !savingSession) { "只有设备所有者可以管理对话" }
        savingSession = true
        val generation = connectionGeneration
        try {
            val id = target.getString("id")
            val result = rpc("sessions.update", JSONObject(patch.toString()).put("sessionId", id)) as JSONObject
            if(generation != connectionGeneration) return@action
            if(selected == id) sessionArchived = result.optBoolean("archived")
            refreshSessions(); managedSession = null
            notice = if(patch.has("archived")) if(patch.optBoolean("archived")) "已归档，可从已归档对话中恢复" else "对话已恢复" else "对话已改名"
        } finally { savingSession = false }
    }
    fun rewindConversation() = action {
        val target = rewindTarget ?: return@action
        require(!sharedDevice && selected.isNotBlank() && !busy && !savingSession) { "停止当前任务后再回退" }
        val id = selected
        savingSession = true
        try {
            val lease = acquireControl(id)
            try {
                val params = JSONObject().put("sessionId", id).put("confirmed", true).put("expectedLastMessageId", snapshotLastMessage.ifBlank { null })
                if(target.messageId.isNotBlank()) params.put("messageId", target.messageId)
                val result = rpc("sessions.rewind", params) as JSONObject
                require(result.optBoolean("ok")) { "没有可回退的提问" }
                if(selected == id) {
                    applySnapshot(rpc("sessions.get", JSONObject().put("sessionId", id)) as JSONObject)
                    draft = result.optString("prompt"); rewindTarget = null
                }
                refreshSessions(); notice = "对话已回退，提问已恢复；工作区文件保持不变"
            } finally { releaseControl(lease) }
        } finally { savingSession = false }
    }
    fun deleteConversation(target: JSONObject) = action {
        require(!sharedDevice && !savingSession) { "只有设备所有者可以管理对话" }
        savingSession = true
        val generation = connectionGeneration
        try {
            val id = target.getString("id")
            rpc("sessions.delete", JSONObject().put("sessionId", id).put("confirmed", true))
            if(generation != connectionGeneration) return@action
            if(selected == id) leaveChat()
            refreshSessions(); managedSession = null
            notice = "对话已删除，工作区文件未改变；恢复副本保存在被控电脑的私密目录。"
        } finally { savingSession = false }
    }
    suspend fun imagePreview(item: ChatItem, sessionId: String): JSONObject {
        require(item.media != null) { "无可用预览" }
        return rpc("media.preview", JSONObject().put("messageId", item.media.getString("messageId")).put("index", item.media.getInt("index")).put("sessionId", sessionId)) as JSONObject
    }
    fun login(openBrowser: (String) -> Unit = { openLoginBrowser(getApplication(), it) }): Job = startLogin(openBrowser)
    private fun savePendingLogin(value: PendingGatewayLogin) {
        vault.put(PENDING_LOGIN_KEY, value.json(), durable = true)
        pendingLogin = value; loginCode = value.userCode
    }
    private fun clearPendingLogin() {
        vault.clear(PENDING_LOGIN_KEY, durable = true)
        pendingLogin = null; loginCode = ""
    }
    private fun startLogin(openBrowser: ((String) -> Unit)?): Job {
        loginJob?.takeIf { it.isActive }?.let { return it }
        val generation = ++loginGeneration
        loading = true
        return action {
            try {
                var pending = pendingLogin
                if(pending != null && pending.expiresAt <= System.currentTimeMillis()) {
                    clearPendingLogin(); pending = null
                    if(openBrowser == null) throw GatewayLoginEnded("登录已超时，请重新登录")
                }
                if(pending == null) {
                    if(openBrowser == null) return@action
                    pending = beginGatewayLogin(gateway, BuildConfig.DEBUG)
                    savePendingLogin(pending)
                }
                gateway = pending.gateway
                if(!pending.native) notice = "此网关尚不支持 App 自动回跳，授权后请手动返回 KK Code；建议更新网关"
                // Persisted secrets exist before control leaves this process.
                openBrowser?.invoke(deviceLoginUrl(pending.gateway, pending.userCode, BuildConfig.DEBUG))
                val token = pollGatewayLogin(pending, ::savePendingLogin)
                currentCoroutineContext().ensureActive()
                if(generation != loginGeneration) return@action
                val expires = token.getLong("expires_in"); require(expires in 1..86400) { "无效的登录凭据有效期" }
                val nextProfile = token.getJSONObject("profile")
                val access = token.getString("access_token"); require(access.isNotBlank())
                require(token.getString("refresh_token").isNotBlank())
                refreshAt = System.currentTimeMillis() + expires * 1000
                token.put("expiresAt", refreshAt)
                vault.completeLogin(gateway, token.toString())
                pendingLogin = null; loginCode = ""
                devicePolling?.cancel(); disconnect()
                credentials = token; gatewayApi = DeviceApi(gateway, access); api = gatewayApi; profile = nextProfile
                startDevicePolling()
                try {
                    awaitDevices(); notice = "登录成功"; loginNotice?.cancel()
                    loginNotice = viewModelScope.launch { delay(5000); if(notice == "登录成功") notice = "" }
                }
                catch(error: CancellationException) { throw error }
                catch(_: Exception) { sheet = "connections"; notice = "已登录，设备列表暂时不可用，将自动重试" }
            } catch(error: GatewayLoginEnded) {
                clearPendingLogin(); throw error
            } finally { if(generation == loginGeneration) loading = false }
        }.also { loginJob = it }
    }
    fun resumeLogin() {
        if(pendingLogin != null && loginJob?.isActive != true) startLogin(null)
    }
    fun handleLoginReturn(value: String?): Boolean {
        val pending = pendingLogin ?: return false
        if(pending.expiresAt <= System.currentTimeMillis() || !pending.acceptsReturn(value)) return false
        resumeLogin(); return true
    }
    fun reopenLoginBrowser() = action {
        val pending = pendingLogin ?: return@action
        require(pending.expiresAt > System.currentTimeMillis()) { "登录已超时，请重新登录" }
        openLoginBrowser(getApplication(), deviceLoginUrl(pending.gateway, pending.userCode, BuildConfig.DEBUG))
        resumeLogin()
    }
    fun cancelLogin() {
        val previous = pendingLogin
        loginGeneration++; loginJob?.cancel(); loginJob = null
        clearPendingLogin(); loading = false; notice = "已取消登录"
        if(previous != null) viewModelScope.launch {
            try { DeviceApi(previous.gateway).call("/auth/cancel", previous.proof()) }
            catch(error: CancellationException) { throw error }
            catch(_: Exception) { /* Local cancellation is final; remote grants expire. */ }
        }
    }
    private suspend fun awaitDevices() { loadDevices(); sheet = if (devices.isEmpty() && !connected && !loading) "connections" else "" }
    private fun accountScope(): String = java.security.MessageDigest.getInstance("SHA-256").digest((gateway + "\u0000" + profile.optString("id", profile.optString("email", "local"))).toByteArray()).joinToString("") { "%02x".format(it) }
    private fun sshCacheKey() = "ssh-profiles:${accountScope()}"
    private fun sshSecretKey(id: String) = "ssh-secret:${accountScope()}:$id"
    private fun persistSshProfiles() { vault.put(sshCacheKey(), JSONArray(sshProfiles).toString()) }
    private fun sshMetadata(value: JSONObject): JSONObject = JSONObject().apply {
        for(key in listOf("id", "name", "host", "port", "username", "remotePort", "hostKey", "folders")) if(value.has(key)) put(key, value.get(key))
    }
    suspend fun loadSshProfiles() = sshProfilesMutex.withLock {
        val scope = accountScope()
        val cached = runCatching { JSONArray(vault.get(sshCacheKey()) ?: "[]").objects() }.getOrDefault(emptyList())
        sshProfiles = cached
        val client = gatewayApi ?: return@withLock
        try {
            refreshToken()
            if(scope != accountScope() || gatewayApi !== client) return@withLock
            var response = client.call("/api/v1/connections/ssh")
            if(scope != accountScope() || gatewayApi !== client) return@withLock
            sshRevision = response.optInt("revision")
            for(pending in cached.filter { it.optBoolean("pendingSync") }) {
                response = client.call("/api/v1/connections/ssh", JSONObject().put("revision", sshRevision).put("connection", sshMetadata(pending)))
                if(scope != accountScope() || gatewayApi !== client) return@withLock
                sshRevision = response.getInt("revision")
            }
            val changedDuringSync = sshProfiles.filter { current -> current.optBoolean("pendingSync") && cached.none { old -> old.optString("id") == current.optString("id") && sshMetadata(old).toString() == sshMetadata(current).toString() } }
            val changedIds = changedDuringSync.map { it.optString("id") }.toSet()
            sshProfiles = response.optJSONArray("items").objects().filterNot { it.optString("id") in changedIds } + changedDuringSync
            persistSshProfiles()
        } catch(error: CancellationException) { throw error }
        catch(_: Exception) { /* Offline profiles stay available for direct SSH. */ }
    }
    fun editSsh(connection: JSONObject? = null) { editingSsh = connection; fingerprint = ""; sheet = "ssh" }
    fun chooseSsh(connection: JSONObject, automatic: Boolean = false): Job? {
        if(!automatic && connected && api?.relay == false && selectedSsh == connection.optString("id")) { sheet = ""; return null }
        if(!automatic) sshRecovery?.cancel()
        editingSsh = connection
        val saved = vault.get(sshSecretKey(connection.getString("id")))?.let { runCatching { JSONObject(it) }.getOrNull() }
        if(saved == null) { if(!automatic) editSsh(connection); notice = "请从 SSH 设备列表选择连接并输入此手机的凭据；网关不会保存私钥或密码"; return null }
        if(!sshCredentialMatches(saved, connection)) { if(!automatic) editSsh(connection); notice = "SSH 目标或指纹已变化，请从连接管理中重新核对并输入本机凭据；不会把旧密码发送到变更后的目标"; return null }
        return connectSsh(connection.getString("host"), connection.optInt("port", 22).toString(), connection.getString("username"), saved.optString("password"), saved.optString("privateKey"), connection.optString("name"), true, connection.optInt("remotePort", 18271), connection.optString("folders") == "all", recovering = automatic)
    }
    fun resumeSshConnection(force: Boolean = false) {
        if(!autoConnect || manualDisconnect || loading || selectedSsh.isBlank() || sshRecovery?.isActive == true) return
        val id = selectedSsh; val client = api
        sshRecovery = viewModelScope.launch {
            if(!force && client != null && !client.relay) {
                try { client.call("/api/v1/auth/heartbeat", JSONObject()); if(api === client) connectionRestored(); return@launch }
                catch(error: CancellationException) { throw error }
                catch(_: Exception) { /* The SSH transport or native pairing expired. */ }
            }
            repeat(5) { attempt ->
                if(selectedSsh != id || manualDisconnect || loading) return@launch
                val profile = sshProfiles.find { it.optString("id") == id } ?: return@launch
                connectionLost("SSH 连接中断，正在尝试 ${attempt + 1}/5")
                if(attempt > 0) delay((1000L shl attempt).coerceAtMost(15000))
                if(selectedSsh != id || manualDisconnect || loading) return@launch
                val reconnect = chooseSsh(profile, automatic = true) ?: return@launch
                reconnect.join()
                if(selectedSsh != id || manualDisconnect || fingerprint.isNotBlank()) return@launch
                if(connected) { connectionRestored(); return@launch }
            }
            polling?.cancel(); sshHeartbeat?.cancel()
            connectionLost("SSH 重连 5 次未成功，可从连接菜单重试；远端任务仍保留", retrying = false)
        }
    }
    fun forgetSsh(connection: JSONObject) = action {
        sshProfilesMutex.withLock {
        val scope = accountScope()
        val id = connection.getString("id")
        val client = gatewayApi
        if(client != null && !connection.optBoolean("pendingSync")) {
            refreshToken()
            val response = client.call("/api/v1/connections/ssh/$id/delete", JSONObject().put("revision", sshRevision))
            if(scope != accountScope() || client !== gatewayApi) return@withLock
            sshRevision = response.getInt("revision"); sshProfiles = response.optJSONArray("items").objects()
        } else sshProfiles = sshProfiles.filterNot { it.optString("id") == id }
        vault.clear(sshSecretKey(id)); persistSshProfiles()
        if(selectedSsh == id) disconnect()
        editingSsh = null; sheet = "connections"; notice = "连接资料已移除；远端正在执行的任务不会被取消"
        }
    }
    fun trustSshKey(host: String, port: String, user: String) {
        vault.put("ssh-key:${accountScope()}:$host:$port:$user", fingerprint); fingerprint = ""
    }
    fun connectSsh(host: String, port: String, user: String, password: String, key: String = "", name: String = host, rememberCredentials: Boolean = true, remotePort: Int = 18271, allFolders: Boolean = false, recovering: Boolean = false) = action {
        val sshPort = port.toIntOrNull()?.takeIf { it in 1..65535 } ?: throw IllegalArgumentException("SSH 端口必须是 1–65535 之间的整数")
        if(!recovering) sshRecovery?.cancel()
        val generation = ++connectionGeneration
        val connection = sshFactory()
        loading = true
        try {
            val existing = sshProfiles.find { it.optString("host") == host && it.optInt("port", 22) == sshPort && it.optString("username") == user }
            val accepted = vault.get("ssh-key:${accountScope()}:$host:$port:$user") ?: existing?.optString("hostKey")?.takeIf { it.isNotBlank() }
            val next = connection.connect(host, sshPort, user, password, accepted, remotePort = remotePort, privateKey = key, allFolders = allFolders)
            if(generation != connectionGeneration) { connection.close(); return@action }
            leaveChat(); clearDeviceSelection(); sessions = emptyList(); commands = emptyList(); deviceEvents?.cancel(); sshHeartbeat?.cancel(); ssh?.close(); ssh = connection; api = next
            connected = true; deviceName = name.ifBlank { host }; manualDisconnect = false
            if(recovering) { connectionPhase = "reconnecting"; connectionRestored() }
            val id = existing?.optString("id") ?: editingSsh?.optString("id")?.takeIf { it.isNotBlank() } ?: java.util.UUID.randomUUID().toString()
            selectedSsh = id
            val saved = JSONObject().put("id", id).put("type", "ssh").put("name", deviceName).put("host", host).put("port", sshPort).put("username", user).put("remotePort", remotePort).put("hostKey", accepted ?: "").put("folders", if(allFolders) "all" else "home").put("pendingSync", true)
            sshProfiles = sshProfiles.filterNot { it.optString("id") == id } + saved; persistSshProfiles()
            if(!accepted.isNullOrBlank()) vault.put("ssh-key:${accountScope()}:$host:$port:$user", accepted)
            if(rememberCredentials) vault.put(sshSecretKey(id), JSONObject().put("password", password).put("privateKey", key).put("host", host).put("port", sshPort).put("username", user).put("hostKey", accepted ?: "").toString()) else vault.clear(sshSecretKey(id))
            vault.put("active-ssh:${accountScope()}", id)
            val status = next.rpc("status", JSONObject()) as JSONObject
            if(generation != connectionGeneration) return@action
            cwd = status.getJSONArray("roots").getString(0)
            sharedDevice = false; sharedPermissions = JSONObject()
            val availableCommands = visibleCommands((next.rpc("commands.list", JSONObject()) as? JSONArray).objects())
            if(generation != connectionGeneration) return@action
            commands = availableCommands
            refreshSessions()
            if(generation != connectionGeneration) return@action
            sheet = ""; fingerprint = ""
            startDeviceEvents()
            sshHeartbeat = viewModelScope.launch { while(isActive && api === next) { try { next.call("/api/v1/auth/heartbeat", JSONObject()); if(api === next) connectionRestored() } catch(error: CancellationException) { throw error } catch(_: Exception) { if(api === next) { connectionLost("SSH 连接中断"); resumeSshConnection(force = true) } }; delay(20000) } }
            val previousSession = vault.get("ssh-session:${accountScope()}:$id")
            sessions.find { it.optString("id") == previousSession }?.let { openSession(it) }
            viewModelScope.launch { loadSshProfiles() }
        } catch (e: HostKeyRequired) { if(generation == connectionGeneration) { fingerprint = e.fingerprint; if(!recovering) sheet = "ssh"; notice = "请从 SSH 连接管理核对电脑的主机指纹；不会自动信任变更后的身份" } }
        catch(e: Exception) {
            if(generation == connectionGeneration && ssh === connection) { sshHeartbeat?.cancel(); deviceEvents?.cancel(); polling?.cancel(); connection.close(); ssh = null; connected = false }
            throw e
        }
        finally { if(api?.relay != false || ssh !== connection) connection.close(); if(generation == connectionGeneration) loading = false }
    }
    fun openSession(item: JSONObject) = action {
        polling?.cancel(); lastTurnOutcome = ""; subagentSyncNotice = ""; selected = item.getString("id"); cwd = item.optString("cwd", cwd)
        messages = emptyList(); contextUsage = JSONObject(); approvals = emptyList(); turnOperation = ""
        val selection = ++sessionGeneration
        todos = null
        subagents = emptyList()
        pendingSend = null; activeExecution = ""; stopRequested = ""; stopping = false; busy = false; turnPhase = "idle"; stopJob = null
        if(selectedSsh.isNotBlank()) vault.put("ssh-session:${accountScope()}:$selectedSsh", selected)
        val sessionId = selected; val source = api
        val snapshot = try { rpc("sessions.get", JSONObject().put("sessionId", selected)) as JSONObject }
        catch(error: Exception) { if(selected != sessionId || api !== source || sessionGeneration != selection) return@action; if(sessionGone(error, sessionId)) return@action; throw error }
        if(selected != sessionId || api !== source || sessionGeneration != selection) return@action
        applySnapshot(snapshot)
        attachments = emptyList(); draft = ""
        startEvents(snapshot.optLong("eventCursor")); sheet = ""
    }
    private fun sessionGone(error: Exception, id: String): Boolean {
        if(error !is DeviceApiError || error.code != "session_missing") return false
        sessions = sessions.filterNot { it.optString("id") == id }
        if(selected == id) { leaveChat(); notice = "这段对话已被删除，请选择其他对话" }
        return true
    }
    internal fun applySnapshot(snapshot: JSONObject) {
        todos = acceptTodoSnapshot(todos, snapshot.optJSONObject("todos"), selected)
        subagents = scopedSubagents(snapshot.optJSONArray("subagents").objects(), selected)
        contextUsage = snapshot.optJSONObject("context") ?: JSONObject()
        val refreshed = snapshotMessages(snapshot)
        val boundary = refreshed.findLast { it.kind == "compacted" }
        val retained = if(boundary != null) messages.filter { it.kind != "compacted" && it.startedAt <= boundary.startedAt } else emptyList()
        messages = if(retained.isNotEmpty() && boundary != null) retained + refreshed.filter { it.kind == "compacted" || it.startedAt > boundary.startedAt } else refreshed
        val canonical = snapshot.optJSONArray("messages").objects()
        snapshotLastMessage = canonical.lastOrNull()?.optString("id") ?: ""
        snapshotCursor = snapshot.optLong("eventCursor")
        sessionArchived = snapshot.optBoolean("archived")
        persistedSteps = canonical.filter { it.optString("role") == "assistant" && !it.optBoolean("truncated") }.mapNotNull { streamStepKey(it.optString("turnId"), it.stepOrNull()) }.toSet()
        persistedUserTurns = canonical.filter { it.optString("role") == "user" }.map { it.optString("turnId") }.filter { it.isNotBlank() }.toSet()
        // Prefix events belong to this exact eventCursor; consume them once before
        // polling newer deltas, not through an independent historical replay.
        snapshot.optJSONArray("liveEvents").objects().forEach { applyConversationEvent(it) }
        applySelection(snapshot)
        observeTurnState(snapshot)
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
            val synthetic = it.optBoolean("synthetic") || it.optBoolean("continuation") || (content as? JSONArray).objects().any { b -> b.optString("type") == "tool_result" }
            val images = (content as? JSONArray).objects().filter { b -> b.optString("type") == "image_preview" }.map { b -> ChatItem("${it.optString("id")}-image-${b.optInt("index")}", "media", "图片预览", startedAt = it.optLong("createdAt"), media = b) }
            val compact = text.contains("<compaction-summary")
            val metric = snapshot.optJSONObject("lastCompaction") ?: it.optJSONObject("compaction")
            reasoning + images + if(synthetic || text.isBlank()) emptyList() else listOf(ChatItem(it.optString("id"), if(compact) "compacted" else it.optString("role"), if(compact) compactionLabel(metric) else text, startedAt = if(compact) metric?.optLong("compactedAt") ?: it.optLong("timestamp") else it.optLong("createdAt"), turnId = it.optString("turnId"), step = it.stepOrNull(), messageId = if(it.optString("role") == "user" && !compact) it.optString("id") else ""))
        }
        val tools = linkedMapOf<String, ChatItem>()
        for(part in snapshot.optJSONArray("parts").objects().filter { it.optString("type") == "tool-call" }) {
            val id = part.optString("runPartId").ifBlank { part.getString("id") }
            tools[id] = ChatItem(id, "tool", part.optString("tool"), part.optString("output"), tool = part, startedAt = tools[id]?.startedAt ?: part.optLong("createdAt"), turnId = part.optString("turnId"), step = part.stepOrNull())
        }
        val reviews = snapshot.optJSONArray("parts").objects().filter { it.optString("type") == "permission-review" }.map { part ->
            val verdict = when(part.optString("decision")) { "allow" -> "允许"; "deny" -> "拒绝"; else -> "交给你确认" }
            ChatItem(part.getString("id"), "review", "Auto 审查 · ${part.optString("tool")} · $verdict", part.optString("reason") + "\n对话模型：" + part.optString("model"), tool = part, turnId = part.optString("turnId"), startedAt = part.optLong("createdAt"))
        }
        val cancellations = snapshot.optJSONArray("parts").objects().filter { it.optString("type") == "turn-cancelled" }.map { ChatItem(it.getString("id"), "cancelled", "已停止。已收到的内容和文件改动已保留。", turnId = it.optString("turnId"), startedAt = it.optLong("createdAt")) }
        return (history + tools.values + reviews + cancellations).sortedBy { it.startedAt }
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
        if(loading) return@action
        loading = true
        try {
        val selection = JSONObject().put("cwd", cwd).put("mode", mode).also { if(model.isNotBlank()) it.put("model", model); if(provider.isNotBlank()) it.put("provider", provider) }
        val created = rpc("sessions.create", selection) as JSONObject
        val id = created.getString("id")
        if(created.has("modeId")) applySelection(created)
        else {
        val lease = acquireControl(id)
        try { applySelection(rpc("sessions.configure", JSONObject().put("sessionId", id).put("mode", mode).also { if(model.isNotBlank()) it.put("model", model); if(provider.isNotBlank()) it.put("provider", provider) }) as JSONObject) }
        finally { runCatching { releaseControl(lease) } }
        }
        selected = created.getString("id"); messages = emptyList(); contextUsage = JSONObject(); snapshotLastMessage = ""; snapshotCursor = 0; sessionArchived = false; persistedSteps = emptySet(); persistedUserTurns = emptySet(); attachments = emptyList(); draft = ""; historyHasMore = false; historyBefore = ""; startEvents(0); refreshSessions(); sheet = ""
        if(selectedSsh.isNotBlank()) vault.put("ssh-session:${accountScope()}:$selectedSsh", selected)
        } finally { loading = false }
    }
    private fun startEvents(initial: Long) {
        polling?.cancel(); val sessionId = selected
        val selection = sessionGeneration; val generation = connectionGeneration; val source = api
        fun currentSession() = selected == sessionId && sessionGeneration == selection && connectionGeneration == generation && api === source
        polling = viewModelScope.launch {
            val cursor = SessionEventCursor(initial)
            var streamUnsupported = false
            var reconnectMs = 2000L
            while (isActive && currentSession()) {
                if (!streamUnsupported) {
                    try {
                        if(api?.relay == true) refreshToken()
                        val client = api ?: return@launch
                        client.streamEvents(sessionId, cursor.value).collect { frame ->
                            if(!currentSession()) throw CancellationException()
                            val row = try { JSONObject(frame.data) } catch(_: Exception) { return@collect }
                            if(!cursor.accept(if(row.has("seq")) row.optLong("seq") else null)) return@collect
                            when (frame.event) {
                                "connected" -> {
                                    observeTurnState(row); connectionRestored()
                                    controlElsewhere = row.optJSONObject("control")?.optBoolean("yours") == false
                                    approvals = row.optJSONArray("approvals").objects()
                                }
                                "session.state" -> {
                                    observeTurnState(row)
                                    controlElsewhere = row.optJSONObject("control")?.optBoolean("yours") == false
                                }
                                "replay.gap" -> {
                                    val snapshot = rpc("sessions.get", JSONObject().put("sessionId", sessionId)) as JSONObject
                                    if(!currentSession()) throw CancellationException()
                                    applySnapshot(snapshot); cursor.reset(snapshot.optLong("eventCursor", cursor.value))
                                    if(!snapshot.optBoolean("liveTruncated")) notice = "历史事件已归档，已重新同步完整会话"
                                }
                                "device.online" -> connectionRestored()
                                "device.offline" -> connectionLost("设备已离线，等待恢复")
                                else -> handleJournalEvent(row)
                            }
                        }
                        reconnectMs = 2000
                    } catch (e: CancellationException) { throw e }
                    catch (e: Exception) {
                        if(!currentSession()) return@launch
                        if(sessionGone(e, sessionId)) return@launch
                        if(api?.relay == false && (e is java.io.IOException || e is DeviceApiError && e.status in listOf(401, 502, 503, 504))) resumeSshConnection(force = true)
                        if(e is DeviceApiError && (e.status in listOf(404, 405, 501) || e.code == "not_sse")) { streamUnsupported = true; continue }
                        connectionLost(remoteErrorMessage(e, api?.relay == false))
                    }
                    delay(reconnectMs); reconnectMs = (reconnectMs * 2).coerceAtMost(15000)
                } else try {
                    val batch = rpc("events.list", JSONObject().put("sessionId", sessionId).put("after", cursor.value)) as JSONObject
                    if(!currentSession()) return@launch
                    if(batch.optBoolean("gap")) {
                        val snapshot = rpc("sessions.get", JSONObject().put("sessionId", sessionId)) as JSONObject
                        if(!currentSession()) return@launch
                        applySnapshot(snapshot); cursor.reset(snapshot.optLong("eventCursor"))
                        if(!snapshot.optBoolean("liveTruncated")) notice = "历史事件已归档，已重新同步完整会话"
                        continue
                    }
                    for (event in batch.optJSONArray("events").objects()) {
                        if(!cursor.accept(event.getLong("seq"))) continue
                        handleJournalEvent(event)
                    }
                    approvals = batch.optJSONArray("approvals").objects(); connectionRestored()
                    observeTurnState(batch)
                    controlElsewhere = batch.optJSONObject("control")?.optBoolean("yours") == false
                    delay(1000)
                } catch (e: CancellationException) { throw e } catch (e: Exception) { if(!currentSession()) return@launch; if(sessionGone(e, sessionId)) return@launch; connectionLost(remoteErrorMessage(e, api?.relay == false)); delay(1000) }
            }
        }
    }
    internal suspend fun handleJournalEvent(event: JSONObject) {
        val selection = sessionGeneration; val generation = connectionGeneration; val source = api
        fun currentSession() = sessionGeneration == selection && connectionGeneration == generation && api === source
        if(event.optLong("seq") in 1..snapshotCursor) return
        val type = event.getString("type"); val payload = event.optJSONObject("payload") ?: JSONObject()
        if(type == "todo.updated") {
            if(event.optString("sessionId") == selected) todos = acceptTodoSnapshot(todos, payload.optJSONObject("snapshot"), selected)
            return
        }
        if(type in listOf("subagent.delegated", "subagent.settled", "subagent.progress")) {
            subagents = mergeSubagentEvent(subagents, event, selected)
            return
        }
        if(type == "task.settled" && event.optString("sessionId") == selected && payload.optString("subSessionId").isNotBlank()) {
            val id = selected
            val snapshot = rpc("sessions.get", JSONObject().put("sessionId", id)) as JSONObject
            if(selected == id && currentSession()) applySnapshot(snapshot)
            return
        }
        if(applyConversationEvent(event)) {
            if(type in listOf("turn.result", "turn.failed", "turn.cancelled")) {
                val id = selected
                val snapshot = rpc("sessions.get", JSONObject().put("sessionId", id)) as JSONObject
                if(selected == id && currentSession()) applySnapshot(snapshot)
                refreshSessions()
            }
            return
        }
        when(type) {
            "session.context.updated", "turn.usage.update" -> { payload.optJSONObject("context")?.let { contextUsage = it } }
            "session.deleted" -> { leaveChat(); refreshSessions(); notice = "该对话已被删除" }
            "session.rewound" -> {
                val id = selected
                val snapshot = rpc("sessions.get", JSONObject().put("sessionId", id)) as JSONObject
                if(selected == id && currentSession()) applySnapshot(snapshot)
                refreshSessions()
            }
            "session.updated", "session.title.updated" -> { refreshSessions(); sessionArchived = sessions.find { it.optString("id") == selected }?.optBoolean("archived") ?: sessionArchived }
            "permission.review.started" -> messages = messages + ChatItem(event.getString("id"), "review", "Auto 审查 · ${payload.optString("tool")} · 进行中", "正在由当前对话模型审查敏感操作…", tool = payload, done = false, turnId = event.optString("turnId"))
            "permission.review.finished" -> {
                val verdict = when(payload.optString("decision")) { "allow" -> "允许"; "deny" -> "拒绝"; else -> "交给你确认" }
                val item = ChatItem(event.getString("id"), "review", "Auto 审查 · ${payload.optString("tool")} · $verdict", payload.optString("reason") + "\n对话模型：" + payload.optString("model"), tool = payload, turnId = event.optString("turnId"))
                val old = messages.indexOfFirst { it.kind == "review" && !it.done && it.turnId == item.turnId && it.tool?.optString("tool") == payload.optString("tool") }
                messages = if(old < 0) messages + item else messages.mapIndexed { at, value -> if(at == old) item.copy(id = value.id) else value }
            }
            "provider.capability.notice" -> {
                val message = payload.optString("message")
                if(message.isNotBlank()) { notice = message; deviceNotice?.cancel(); deviceNotice = viewModelScope.launch { delay(6500); if(notice == message) notice = "" } }
            }
            "tool.start", "tool.finish", "tool.error" -> {
                finishThinking(event.optLong("timestamp"))
                val id = payload.optString("invocationId").ifBlank { event.getString("id") }
                if(!payload.has("status")) payload.put("status", if(type == "tool.start") "running" else if(type == "tool.error") "error" else "completed")
                val item = ChatItem(id, "tool", payload.optString("tool", "Tool"), payload.optString("output"), tool = payload, turnId = event.optString("turnId"), step = payload.stepOrNull())
                messages = if(messages.any { it.id == id }) messages.map { if(it.id == id) item else it } else messages + item
            }
            "session.compacted", "stream.provider_compaction" -> messages = messages + ChatItem(event.getString("id"), "compacted", compactionLabel(payload), startedAt = payload.optLong("compactedAt", event.optLong("timestamp")))
            "session.configured" -> applySelection(payload)
            "branch.changed", "session.branch.changed" -> { branchSnapshot = JSONObject(); if(sheet == "branches") loadBranches() }
            "approval.requested" -> {
                val request = JSONObject(payload.toString())
                val id = request.remove("id")?.toString() ?: event.getString("id")
                val kind = request.remove("kind")?.toString() ?: "permission"
                approvals = approvals.filterNot { it.optString("id") == id } + JSONObject().put("id", id).put("kind", kind).put("request", request)
            }
            "approval.resolved" -> approvals = approvals.filterNot { it.optString("id") == payload.optString("id") }
        }
    }
    private fun applyConversationEvent(event: JSONObject): Boolean {
        val type = event.optString("type")
        val payload = event.optJSONObject("payload") ?: JSONObject()
        val turn = event.optString("turnId").ifBlank { payload.optString("turnId") }
        val step = payload.stepOrNull()
        val timestamp = event.optLong("timestamp")
        val execution = payload.optString("executionId")
        when(type) {
            "turn.preparing", "turn.stopping", "session.compacting" -> {
                if(execution.isNotBlank()) activeExecution = execution
                if(payload.has("operation")) turnOperation = payload.optString("operation")
                if(type == "session.compacting") pendingSend?.takeIf { it.executionId == execution }?.let { acknowledgeSend(it) }
                busy = true; stopping = type == "turn.stopping" || stopRequested == execution && execution.isNotBlank()
                turnPhase = if(stopping) "stopping" else if(type == "session.compacting") "compacting" else "starting"
            }
            "turn.waiting.children" -> if(!stopping) turnPhase = "waiting_children"
            "turn.step.start" -> if(!stopping) turnPhase = "running"
            "stream.thinking.start" -> messages = beginStreamThinking(messages, StreamDelta(event.optString("id"), "thinking", "", turn, step, timestamp), persistedSteps)
            "stream.text.delta", "stream.thinking.delta" -> {
                if(type == "stream.text.delta") finishThinking(timestamp)
                messages = appendStreamDelta(messages, StreamDelta(event.optString("id"), if(type == "stream.text.delta") "assistant" else "thinking", payload.optString("text"), turn, step, timestamp), persistedSteps)
            }
            "stream.end" -> messages = finishStreamStep(messages, turn, step, timestamp)
            "turn.start" -> {
                lastTurnOutcome = ""
                busy = true
                if(execution.isNotBlank()) activeExecution = execution
                pendingSend?.takeIf { it.executionId == execution }?.let { acknowledgeSend(it) }
                stopping = stopRequested == execution && execution.isNotBlank(); turnPhase = if(stopping) "stopping" else "running"
                if(turn !in persistedUserTurns && payload.optString("prompt").isNotBlank() && messages.none { it.kind == "user" && turn.isNotBlank() && it.turnId == turn }) messages = messages + ChatItem("${event.optString("id")}-user", "user", payload.getString("prompt"), startedAt = timestamp, turnId = turn)
            }
            "turn.finish", "turn.result" -> {
                lastTurnOutcome = payload.optString("status", if(payload.optString("stopReason") in listOf("", "end_turn")) "completed" else "incomplete")
                if(type == "turn.finish" && payload.optBoolean("settling")) { if(execution.isBlank() || activeExecution == execution) turnPhase = if(stopping) "stopping" else "finishing" }
                else settleExecution(execution)
                messages = finishStreamReply(messages, event.optString("id"), turn, step, payload.optString("reply"), timestamp)
            }
            "turn.cancelled" -> {
                lastTurnOutcome = "cancelled"
                if(payload.optString("operation") == "compact" && draft.isBlank()) draft = "/compact"
                settleExecution(execution); messages = finishStreamStep(messages, turn, null, timestamp).map { item ->
                    if(item.kind == "tool" && item.turnId == turn && item.tool?.optString("status") == "running") item.copy(tool = JSONObject(item.tool.toString()).put("status", "cancelled")) else item
                }
                if(messages.none { it.kind == "cancelled" && it.turnId == turn }) messages = messages + ChatItem(event.optString("id"), "cancelled", if(payload.optString("operation") == "compact") "压缩已停止，原对话已保留。" else "已停止。已收到的内容和文件改动已保留。", turnId = turn, startedAt = timestamp)
            }
            "turn.failed" -> {
                lastTurnOutcome = "error"; if(payload.optString("operation") == "compact" && draft.isBlank()) draft = "/compact"; messages = finishStreamStep(messages, turn, null, timestamp); settleExecution(execution); notice = remoteErrorMessage(Exception(payload.optString("error")), api?.relay == false); messages = messages + ChatItem(event.optString("id"), "error", notice, turnId = turn, startedAt = timestamp) }
            else -> return false
        }
        return true
    }
    private fun finishThinking(timestamp: Long) {
        messages = messages.map { if(it.kind == "thinking" && !it.done) it.copy(done = true, durationMs = (timestamp - it.startedAt).coerceAtLeast(0)) else it }
    }
    fun send(text: String) = action {
        if (selected.isBlank()) return@action
        if(pendingSend != null) return@action
        require(!sessionArchived) { "恢复归档后再继续对话" }
        require(canControl) { "这个会话是只读分享" }
        require(!uploading) { "请等待附件上传完成" }
        require(!text.startsWith('/') || attachments.isEmpty()) { "附件只能随消息发送，不能附在命令上" }
        val origin = selected
        if(busy) {
            if(steeringInFlight) return@action
            require(turnOperation != "compact") { "正在压缩上下文，请等待完成或停止后再发送。" }
            require(!stopping && turnPhase != "finishing") { "当前任务正在收尾；请保留补充要求，稍后发送。" }
            require(text.isNotBlank() && text.length <= 16000 && !text.startsWith('/') && attachments.isEmpty()) { "执行期间可发送文字补充要求；附件和命令请在本轮结束后发送。" }
            val execution = activeExecution
            val generation = connectionGeneration
            steeringInFlight = true
            try {
                acquireControl(origin)
                if(selected != origin || connectionGeneration != generation || activeExecution != execution) return@action
                rpc("turns.steer", JSONObject().put("sessionId", origin).put("executionId", execution).put("prompt", text))
                if(selected == origin && connectionGeneration == generation) {
                    if(draft == text) draft = ""
                    notice = "补充要求已保存，智能体将在安全执行节点读取。"
                }
            } finally { steeringInFlight = false }
            return@action
        }
        val token = PendingSend(origin, java.util.UUID.randomUUID().toString(), connectionGeneration, text, attachments.map { it.getString("id") }.toSet())
        val inputAttachments = attachments
        pendingSend = token
        val compact = text.trim() == "/compact"
        if(!text.startsWith('/') || compact) { activeExecution = token.executionId; busy = true; turnPhase = "starting"; turnOperation = if(compact) "compact" else "" }
        var acceptedTurn = false
        try {
        val lease = acquireControl(origin)
        if(token.cancelled || selected != origin) { releaseControl(lease); return@action }
        if (text.startsWith('/')) {
            var accepted = false
            var released = false
            try {
                token.dispatched = true
                val result = rpc("commands.run", JSONObject().put("sessionId", origin).put("command", text).put("executionId", token.executionId))
                token.started.complete(result as? JSONObject)
                if(result is JSONObject) {
                    accepted = result.optBoolean("accepted")
                    acceptedTurn = accepted
                    if(!accepted) { releaseControl(lease); released = true }
                    if(selected == origin && token.generation == connectionGeneration && !token.terminal) {
                        handleCommandResult(text, result)
                        if(accepted) { acknowledgeSend(token); if(compact) { busy = true; turnPhase = if(token.cancelled) "stopping" else "compacting" } }
                    }
                }
                else if(selected == origin && token.generation == connectionGeneration) messages = messages + ChatItem(java.util.UUID.randomUUID().toString(), "tool", text, result.toString())
                if(selected == origin && token.generation == connectionGeneration && !token.terminal && draft == text) draft = ""
            } finally { if(!accepted && !released) releaseControl(lease) }
        } else {
            try {
                token.dispatched = true
                val result = rpc("turns.start", JSONObject().put("sessionId", origin).put("prompt", text.ifBlank { "请分析附件。" }).put("executionId", token.executionId).put("attachmentIds", JSONArray(inputAttachments.map { it.getString("id") }))) as? JSONObject
                token.started.complete(result)
                acceptedTurn = result?.optBoolean("accepted", true) != false
                if(selected == origin && token.generation == connectionGeneration && acceptedTurn && !token.terminal) {
                    if(token.executionId !in settledExecutions) { busy = true; turnPhase = if(token.cancelled) "stopping" else "running" }
                    acknowledgeSend(token)
                }
            } catch(error: Exception) { if(!token.terminal) { runCatching { releaseControl(lease) }; throw error } }
        }
        } finally {
            token.started.complete(null)
            if(pendingSend === token) pendingSend = null
            if(!acceptedTurn && selected == origin && token.generation == connectionGeneration) settleExecution(token.executionId)
        }
    }
    fun stop() {
        if(!busy || !canControl || stopJob?.isActive == true) return
        val origin = selected; val generation = connectionGeneration; val pending = pendingSend
        val execution = activeExecution.ifBlank { pending?.executionId.orEmpty() }
        pending?.cancelled = true; stopRequested = execution; stopping = true; turnPhase = "stopping"
        stopJob = viewModelScope.launch {
            try {
                withTimeout(15000) {
                    val lease = acquireControl(origin)
                    val params = JSONObject().put("sessionId", origin).apply { if(execution.isNotBlank()) put("executionId", execution) }
                    var result = rpc("turns.cancel", params) as? JSONObject
                    if(result?.optBoolean("cancelled") != true && pending?.dispatched == true) {
                        val started = kotlinx.coroutines.selects.select<JSONObject?> {
                            pending.started.onAwait { it }
                            pending.finished.onAwait { JSONObject().put("settled", true) }
                        }
                        if(started?.optBoolean("settled") == true) result = JSONObject().put("running", false).put("cancelled", true)
                        else if(started != null && started.optBoolean("accepted", true) && generation == connectionGeneration) result = rpc("turns.cancel", params) as? JSONObject
                    }
                    if(result?.optBoolean("running", true) == false) runCatching { releaseControl(lease) }
                    if(selected == origin && generation == connectionGeneration && result != null && (activeExecution.isBlank() || activeExecution == execution)) observeTurnState(result)
                }
            } catch(error: TimeoutCancellationException) {
                if(selected == origin && generation == connectionGeneration && execution !in settledExecutions) { stopRequested = ""; stopping = false; turnPhase = "running"; notice = "停止请求尚未确认，任务可能仍在运行。请检查连接后再次点击停止。" }
            } catch(error: CancellationException) { throw error }
            catch(error: Exception) {
                if(selected == origin && generation == connectionGeneration && execution !in settledExecutions) { stopRequested = ""; stopping = false; turnPhase = "running"; notice = "停止尚未确认，任务可能仍在运行。${remoteErrorMessage(error, api?.relay == false)} 可再次点击停止。" }
            }
        }
    }
    fun answer(id: String, value: Any) = action { rpc("approvals.resolve", JSONObject().put("sessionId", selected).put("id", id).put("answer", value)) }
    fun takeControl() = action { rpc("control.acquire", JSONObject().put("sessionId", selected).put("takeover", true)); controlElsewhere = false }
    private fun applySelection(value: JSONObject) {
        if(!value.has("context") && (value.has("model") && value.optString("model") != model || value.has("providerType") && value.optString("providerType") != provider)) contextUsage = JSONObject()
        if(value.has("model")) model = value.optString("model")
        if(value.has("providerType")) provider = value.optString("providerType")
        if(value.has("modeId")) mode = value.optString("modeId").let { if(it == "agent-auto") "auto" else it }
        if(value.has("approval")) approval = value.optString("approval")
    }
    fun selectModel(name: String, id: String) = action {
        require(!sharedDevice) { "只有电脑所有者可以切换模型" }
        if(selected.isBlank()) { provider = name; model = id }
        else {
            val lease = acquireControl(selected)
            try { val result = rpc("sessions.configure", JSONObject().put("sessionId", lease.sessionId).put("provider", name).put("model", id)) as JSONObject; if(selected == lease.sessionId) applySelection(result) }
            finally { releaseControl(lease) }
        }
        sheet = ""; notice = "模型已切换"
    }
    fun selectThinking(name: String, id: String, value: String) = action {
        require(!sharedDevice && !busy) { "请在任务结束后由电脑所有者调整思考强度" }
        val option = JSONObject().put("thinking_effort", value)
        val patch = JSONObject().put("provider", JSONObject().put(name, JSONObject().put("model_options", JSONObject().put(id, option))))
        val result = rpc("settings.update", JSONObject().put("config", patch)) as JSONObject
        settings = result.getJSONObject("config")
        discoverModels(name)
        notice = "思考强度已更新"
    }
    fun selectMode(value: String) = action {
        require(!sharedDevice) { "只有电脑所有者可以切换执行模式" }
        if(selected.isBlank()) mode = value
        else {
            val lease = acquireControl(selected)
            try { val result = rpc("sessions.configure", JSONObject().put("sessionId", lease.sessionId).put("mode", value)) as JSONObject; if(selected == lease.sessionId) applySelection(result) }
            finally { releaseControl(lease) }
        }
        sheet = ""; notice = "执行模式已同步"
    }
    fun discoverModels(name: String) = action { loadCatalog(name) }
    private suspend fun loadCatalog(name: String) {
        val request = ++catalogRequest; val generation = connectionGeneration; val source = api; val device = source?.device
        if(catalogProvider != name) { modelOptions = emptyList(); catalogSource = ""; catalogStale = false }
        catalogProvider = name; catalogError = ""; catalogLoading = true
        fun current() = request == catalogRequest && generation == connectionGeneration && api === source && source?.device == device
        try {
            val result = rpc("models.discover", JSONObject().put("provider", name).put("refresh", true)) as JSONObject
            if(!current()) return
            modelOptions = result.optJSONArray("models").objects()
            catalogSource = result.optString("source"); catalogStale = result.optBoolean("stale")
            catalogError = result.optString("warning")
        } catch(error: CancellationException) { throw error }
        catch(error: Exception) { if(current()) { catalogStale = modelOptions.isNotEmpty(); catalogError = remoteErrorMessage(error, source?.relay == false) } }
        finally { if(current()) catalogLoading = false }
    }
    val modelLabel: String
        get() {
            if(model.isNotBlank()) return model
            val fallback = settings.optJSONObject("provider")?.optJSONObject(provider)?.optString("default_model") ?: ""
            return fallback.ifBlank { provider }.ifBlank { "模型" }
        }
    fun openModelPicker() = action {
        require(!sharedDevice) { "共享会话不能切换模型" }
        sheet = "model-picker"
        val source = api; val generation = connectionGeneration; val device = source?.device
        val fresh = if(connected) rpc("settings.get") as JSONObject else settings
        if(api !== source || generation != connectionGeneration || device != source?.device || sheet != "model-picker") return@action
        settings = fresh
        if(provider.isBlank()) provider = settings.optJSONObject("provider")?.optString("default").orEmpty()
        if(provider.isNotBlank()) loadCatalog(provider)
    }
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
            "keys" -> notice = "终端快捷键只在 CLI 中提供"
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
            "permission" -> sheet = "mode"
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
        val lease = acquireControl(selected)
        try { val result = rpc(if(create) "branches.create" else "branches.switch", JSONObject().put("sessionId", lease.sessionId).put("name", name).put("confirmed", true).put("stateToken", token)) as JSONObject; if(selected == lease.sessionId) branchSnapshot = result; notice = "已${if(create) "创建并切换" else "切换"}到分支 $name" }
        finally { releaseControl(lease) }
    }
    fun gitOperation(method: String, params: JSONObject, token: String) = action {
        require(!sharedDevice && selected.isNotBlank()) { "请先打开自己的会话" }
        require(method in listOf("branches.switch", "branches.create", "worktrees.create", "worktrees.open"))
        val origin = selected
        loading = true
        try {
            val lease = acquireControl(origin)
            try {
                val result = rpc(method, JSONObject(params.toString()).put("sessionId", origin).put("confirmed", true).put("stateToken", token)) as JSONObject
                if(method == "worktrees.open") { refreshSessions(); openSession(JSONObject().put("id", result.getString("sessionId")).put("cwd", result.getString("cwd"))).join() }
                else { branchSnapshot = result; notice = if(method == "worktrees.create") "Worktree 已创建，可点列表在其中新建对话" else "分支已更新" }
            } finally { releaseControl(lease) }
        } finally { loading = false }
    }
    fun browse(target: String = cwd) = action { val listing = rpc("folders.list", JSONObject().put("path", target)) as JSONObject; cwd = listing.getString("path"); folders = listing.optJSONArray("entries").objects(); sheet = "folders" }
    fun openSettings() = action { if(connected && !sharedDevice) settings = rpc("settings.get") as JSONObject; sheet = "settings" }
    fun openModels() = action {
        require(connected && !sharedDevice) { "请先连接自己的电脑" }
        settings = rpc("settings.get") as JSONObject
        catalogError = ""; catalogProvider = ""; modelOptions = emptyList()
        sheet = "models"
    }
    fun saveProvider(name: String, type: String, base: String, key: String, modelId: String) = action {
        require(name.matches(Regex("[A-Za-z0-9_-]+"))) { "渠道名称只能包含字母、数字、连字符与下划线" }
        val entry = JSONObject().put("type", type).put("base_url", base).put("default_model", modelId)
        if(editingProvider.isBlank() || key.isNotBlank()) entry.put("api_key", key)
        if(editingProvider.isBlank()) entry.put("api_key_env", "")
        val result = rpc("settings.update", JSONObject().put("config", JSONObject().put("provider", JSONObject().put("default", name).put(name, entry)))) as JSONObject
        settings = result.optJSONObject("config") ?: rpc("settings.get") as JSONObject
        if(selected.isNotBlank()) {
            val lease = acquireControl(selected)
            try { val configured = rpc("sessions.configure", JSONObject().put("sessionId", lease.sessionId).put("provider", name).put("model", modelId)) as JSONObject; if(selected == lease.sessionId) applySelection(configured) }
            finally { releaseControl(lease) }
        } else { provider = name; model = modelId }
        notice = if(settings.optJSONObject("_diagnostics")?.optBoolean("toolsBlocked") == true) "渠道已保存，但设备配置仍有错误；修正后才能恢复执行。" else "渠道已保存并立即生效"; backSheet()
    }
    fun loadExtensions() = action { extensions = rpc("extensions.list") as JSONObject; sheet = "extensions" }
    suspend fun refreshSubagents() {
        val session = selected; val client = api; val generation = sessionGeneration
        if(session.isBlank() || !connected) return
        try {
            val response = rpc("sessions.get", JSONObject().put("sessionId", session).put("view", "subagents")) as JSONObject
            if(selected != session || api !== client || generation != sessionGeneration) return
            subagents = mergeSubagentSnapshot(subagents, response.optJSONArray("subagents").objects(), session)
            subagentSyncNotice = if(response.has("messages")) "升级被控电脑后可使用自动汇报和完整模型详情" else ""
        } catch(error: CancellationException) { throw error }
        catch(error: Exception) { if(selected == session && api === client && generation == sessionGeneration) subagentSyncNotice = "子代理状态暂未同步，连接恢复后自动更新" }
    }
    fun interruptSubagent(id: String) = action {
        val session = selected
        require(subagents.any { it.optString("session_id") == id }) { "子代理不属于当前会话" }
        acquireControl(session)
        val response = rpc("subagents.interrupt", JSONObject().put("sessionId", session).put("childSessionId", id)) as JSONObject
        if(selected == session) subagents = mergeSubagentSnapshot(subagents, response.optJSONArray("items").objects(), session)
    }
    fun leaveChat() { historyTarget = ""; polling?.cancel(); sessionGeneration++; todos = null; subagents = emptyList(); selected = ""; messages = emptyList(); contextUsage = JSONObject(); persistedSteps = emptySet(); persistedUserTurns = emptySet(); approvals = emptyList(); attachments = emptyList(); draft = ""; historyHasMore = false; historyBefore = ""; busy = false; stopping = false; turnPhase = "idle"; activeExecution = ""; stopRequested = ""; pendingSend = null; stopJob = null }
    fun disconnect() { connectionGeneration++; sshRecovery?.cancel(); sshHeartbeat?.cancel(); deviceEvents?.cancel(); deviceNotice?.cancel(); manualDisconnect = true; leaveChat(); clearDeviceSelection(); ssh?.close(); ssh = null; selectedSsh = ""; vault.clear("active-ssh:${accountScope()}"); api = gatewayApi ?: api?.takeIf { it.relay }; api?.device = ""; connected = false; deviceName = "未连接设备"; sessions = emptyList(); commands = emptyList() }
    fun logout() = action {
        cancelLogin()
        devicePolling?.cancel()
        try { (gatewayApi ?: api?.takeIf { it.relay })?.call("/auth/logout", JSONObject()) }
        finally { disconnect(); vault.clear("credentials"); credentials = null; profile = JSONObject(); gatewayApi = null; api = null; devices = emptyList(); sshProfiles = emptyList(); sheet = "" }
    }
    override fun onCleared() { connectionGeneration++; sshRecovery?.cancel(); sshHeartbeat?.cancel(); loginJob?.cancel(); loginNotice?.cancel(); polling?.cancel(); devicePolling?.cancel(); deviceEvents?.cancel(); deviceNotice?.cancel(); ssh?.close(); super.onCleared() }
}
internal fun JSONArray?.objects(): List<JSONObject> = if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it) }
internal fun JSONObject.stepOrNull(): Int? = if(has("step") && !isNull("step")) (opt("step") as? Number)?.toInt() else null
