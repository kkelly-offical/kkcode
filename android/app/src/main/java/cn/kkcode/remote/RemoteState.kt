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
    var deviceName by mutableStateOf("未连接设备")
    var profile by mutableStateOf(JSONObject())
    var connected by mutableStateOf(false)
    var busy by mutableStateOf(false)
    var contextUsage by mutableStateOf(JSONObject())
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
    var rewindTarget by mutableStateOf<ChatItem?>(null)
    var savingSession by mutableStateOf(false)
    var sessionArchived by mutableStateOf(false)
    private var snapshotLastMessage = ""
    private var snapshotCursor = 0L
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
    fun preference(name: String, value: Boolean) { prefs.edit().putBoolean(name, value).apply(); if (name == "autoConnect") autoConnect = value else showContext = value }
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
        val client = api ?: error("先添加一个设备连接"); val target = client.device; val generation = connectionGeneration
        if(client.relay) refreshToken()
        if(api !== client || client.device != target || generation != connectionGeneration) throw CancellationException("设备已切换")
        val result = try { client.rpc(method, params, target) } catch(error: Exception) {
            if(api !== client || client.device != target || generation != connectionGeneration) throw CancellationException("设备已切换")
            if(!client.relay && (error is java.io.IOException || error is DeviceApiError && error.status in listOf(401, 502, 503, 504))) { connected = false; resumeSshConnection(force = true) }
            throw error
        }
        if(api !== client || client.device != target || generation != connectionGeneration) throw CancellationException("设备已切换")
        return result
    }
    private fun clearDeviceSelection() {
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
            rpc("control.acquire", JSONObject().put("sessionId", id))
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
            } finally { rpc("control.release", JSONObject().put("sessionId", id)) }
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
                try { client.call("/api/v1/auth/heartbeat", JSONObject()); if(api === client) connected = true; return@launch }
                catch(error: CancellationException) { throw error }
                catch(_: Exception) { /* The SSH transport or native pairing expired. */ }
            }
            repeat(5) { attempt ->
                if(selectedSsh != id || manualDisconnect || loading) return@launch
                val profile = sshProfiles.find { it.optString("id") == id } ?: return@launch
                connected = false
                if(attempt > 0) delay((1000L shl attempt).coerceAtMost(15000))
                if(selectedSsh != id || manualDisconnect || loading) return@launch
                val reconnect = chooseSsh(profile, automatic = true) ?: return@launch
                reconnect.join()
                if(selectedSsh != id || manualDisconnect || fingerprint.isNotBlank()) return@launch
                if(connected) { notice = "SSH 已重新连接，正在同步远端任务"; return@launch }
            }
            polling?.cancel(); sshHeartbeat?.cancel()
            notice = "SSH 重连 5 次未成功；远端任务不会因此被取消，可从连接菜单重试"
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
            sshHeartbeat = viewModelScope.launch { while(isActive && api === next) { try { next.call("/api/v1/auth/heartbeat", JSONObject()) } catch(error: CancellationException) { throw error } catch(_: Exception) { if(api === next) { connected = false; resumeSshConnection(force = true) } }; delay(20000) } }
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
        polling?.cancel(); selected = item.getString("id"); cwd = item.optString("cwd", cwd)
        if(selectedSsh.isNotBlank()) vault.put("ssh-session:${accountScope()}:$selectedSsh", selected)
        val sessionId = selected; val source = api
        val snapshot = try { rpc("sessions.get", JSONObject().put("sessionId", selected)) as JSONObject }
        catch(error: Exception) { if(sessionGone(error, sessionId)) return@action; throw error }
        if(selected != sessionId || api !== source) return@action
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
        contextUsage = snapshot.optJSONObject("context") ?: JSONObject()
        messages = snapshotMessages(snapshot)
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
            val synthetic = it.optBoolean("synthetic") || it.optBoolean("continuation") || (content as? JSONArray).objects().any { b -> b.optString("type") == "tool_result" }
            val images = (content as? JSONArray).objects().filter { b -> b.optString("type") == "image_preview" }.map { b -> ChatItem("${it.optString("id")}-image-${b.optInt("index")}", "media", "图片预览", startedAt = it.optLong("createdAt"), media = b) }
            reasoning + images + if(synthetic || text.isBlank()) emptyList() else listOf(ChatItem(it.optString("id"), if(text.contains("<compaction-summary")) "compacted" else it.optString("role"), text, startedAt = it.optLong("createdAt"), turnId = it.optString("turnId"), step = it.stepOrNull(), messageId = if(it.optString("role") == "user" && !text.contains("<compaction-summary")) it.optString("id") else ""))
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
        return (history + tools.values + reviews).sortedBy { it.startedAt }
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
        rpc("control.acquire", JSONObject().put("sessionId", id))
        try { applySelection(rpc("sessions.configure", JSONObject().put("sessionId", id).put("mode", mode).also { if(model.isNotBlank()) it.put("model", model); if(provider.isNotBlank()) it.put("provider", provider) }) as JSONObject) }
        finally { runCatching { rpc("control.release", JSONObject().put("sessionId", id)) } }
        }
        selected = created.getString("id"); messages = emptyList(); contextUsage = JSONObject(); snapshotLastMessage = ""; snapshotCursor = 0; sessionArchived = false; persistedSteps = emptySet(); persistedUserTurns = emptySet(); attachments = emptyList(); draft = ""; historyHasMore = false; historyBefore = ""; startEvents(0); refreshSessions(); sheet = ""
        if(selectedSsh.isNotBlank()) vault.put("ssh-session:${accountScope()}:$selectedSsh", selected)
        } finally { loading = false }
    }
    private fun startEvents(initial: Long) {
        polling?.cancel(); val sessionId = selected
        polling = viewModelScope.launch {
            val cursor = SessionEventCursor(initial)
            var streamUnsupported = false
            var reconnectMs = 2000L
            while (isActive) {
                if (!streamUnsupported) {
                    try {
                        if(api?.relay == true) refreshToken()
                        val client = api ?: return@launch
                        client.streamEvents(sessionId, cursor.value).collect { frame ->
                            if(selected != sessionId) throw CancellationException()
                            val row = try { JSONObject(frame.data) } catch(_: Exception) { return@collect }
                            if(!cursor.accept(if(row.has("seq")) row.optLong("seq") else null)) return@collect
                            when (frame.event) {
                                "connected" -> {
                                    busy = row.optBoolean("running"); connected = true
                                    controlElsewhere = row.optJSONObject("control")?.optBoolean("yours") == false
                                    approvals = row.optJSONArray("approvals").objects()
                                }
                                "session.state" -> {
                                    busy = row.optBoolean("running")
                                    controlElsewhere = row.optJSONObject("control")?.optBoolean("yours") == false
                                }
                                "replay.gap" -> {
                                    val snapshot = rpc("sessions.get", JSONObject().put("sessionId", sessionId)) as JSONObject
                                    if(selected != sessionId) throw CancellationException()
                                    applySnapshot(snapshot); cursor.reset(snapshot.optLong("eventCursor", cursor.value))
                                    if(!snapshot.optBoolean("liveTruncated")) notice = "历史事件已归档，已重新同步完整会话"
                                }
                                "device.online" -> connected = true
                                "device.offline" -> { connected = false; notice = "设备已离线，等待恢复" }
                                else -> handleJournalEvent(row)
                            }
                        }
                        reconnectMs = 2000
                    } catch (e: CancellationException) { throw e }
                    catch (e: Exception) {
                        if(sessionGone(e, sessionId)) return@launch
                        if(api?.relay == false && (e is java.io.IOException || e is DeviceApiError && e.status in listOf(401, 502, 503, 504))) resumeSshConnection(force = true)
                        if(e is DeviceApiError && (e.status in listOf(404, 405, 501) || e.code == "not_sse")) { streamUnsupported = true; continue }
                        connected = false; notice = remoteErrorMessage(e, api?.relay == false)
                    }
                    delay(reconnectMs); reconnectMs = (reconnectMs * 2).coerceAtMost(15000)
                } else try {
                    val batch = rpc("events.list", JSONObject().put("sessionId", sessionId).put("after", cursor.value)) as JSONObject
                    if(batch.optBoolean("gap")) {
                        val snapshot = rpc("sessions.get", JSONObject().put("sessionId", sessionId)) as JSONObject
                        if(selected != sessionId) return@launch
                        applySnapshot(snapshot); cursor.reset(snapshot.optLong("eventCursor"))
                        if(!snapshot.optBoolean("liveTruncated")) notice = "历史事件已归档，已重新同步完整会话"
                        continue
                    }
                    for (event in batch.optJSONArray("events").objects()) {
                        if(!cursor.accept(event.getLong("seq"))) continue
                        handleJournalEvent(event)
                    }
                    approvals = batch.optJSONArray("approvals").objects(); connected = true
                    busy = batch.optBoolean("running")
                    controlElsewhere = batch.optJSONObject("control")?.optBoolean("yours") == false
                    delay(1000)
                } catch (e: CancellationException) { throw e } catch (e: Exception) { if(sessionGone(e, sessionId)) return@launch; connected = false; notice = remoteErrorMessage(e, api?.relay == false); delay(1000) }
            }
        }
    }
    internal suspend fun handleJournalEvent(event: JSONObject) {
        if(event.optLong("seq") in 1..snapshotCursor) return
        val type = event.getString("type"); val payload = event.optJSONObject("payload") ?: JSONObject()
        if(applyConversationEvent(event)) {
            if(type in listOf("turn.result", "turn.failed")) {
                val id = selected
                val snapshot = rpc("sessions.get", JSONObject().put("sessionId", id)) as JSONObject
                if(selected == id) applySnapshot(snapshot)
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
                if(selected == id) applySnapshot(snapshot)
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
            "session.compacted", "stream.provider_compaction" -> messages = messages + ChatItem(event.getString("id"), "compacted", "已精简上下文")
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
        when(type) {
            "stream.thinking.start" -> messages = beginStreamThinking(messages, StreamDelta(event.optString("id"), "thinking", "", turn, step, timestamp), persistedSteps)
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
            "turn.failed" -> { messages = finishStreamStep(messages, turn, null, timestamp); busy = false; notice = remoteErrorMessage(Exception(payload.optString("error")), api?.relay == false); messages = messages + ChatItem(event.optString("id"), "error", notice, turnId = turn, startedAt = timestamp) }
            else -> return false
        }
        return true
    }
    private fun finishThinking(timestamp: Long) {
        messages = messages.map { if(it.kind == "thinking" && !it.done) it.copy(done = true, durationMs = (timestamp - it.startedAt).coerceAtLeast(0)) else it }
    }
    fun send(text: String) = action {
        if (selected.isBlank()) return@action
        require(!sessionArchived) { "恢复归档后再继续对话" }
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
    fun discoverModels(name: String) = action {
        catalogError = ""
        try {
            val result = rpc("models.discover", JSONObject().put("provider", name)) as JSONObject
            modelOptions = result.optJSONArray("models").objects(); catalogProvider = name
            catalogSource = result.optString("source"); catalogStale = result.optBoolean("stale")
            if(result.optString("warning").isNotBlank()) notice = result.optString("warning")
        } catch(error: CancellationException) { throw error } catch(error: Exception) {
            modelOptions = emptyList(); catalogProvider = name; catalogSource = ""; catalogStale = false; catalogError = remoteErrorMessage(error, api?.relay == false)
        }
    }
    private suspend fun loadCatalog(name: String) {
        val result = rpc("models.discover", JSONObject().put("provider", name)) as JSONObject
        modelOptions = result.optJSONArray("models").objects(); catalogProvider = name
        catalogSource = result.optString("source"); catalogStale = result.optBoolean("stale")
    }
    val modelLabel: String
        get() {
            if(model.isNotBlank()) return model
            val fallback = settings.optJSONObject("provider")?.optJSONObject(provider)?.optString("default_model") ?: ""
            return fallback.ifBlank { provider }.ifBlank { "模型" }
        }
    fun openModelPicker() = action {
        require(!sharedDevice) { "共享会话不能切换模型" }
        if(connected) settings = rpc("settings.get") as JSONObject
        if(provider.isBlank()) provider = settings.optJSONObject("provider")?.optString("default").orEmpty()
        sheet = "model-picker"
        catalogError = ""
        if(provider.isNotBlank()) {
            try { loadCatalog(provider) }
            catch(error: CancellationException) { throw error }
            catch(error: Exception) { modelOptions = emptyList(); catalogProvider = provider; catalogSource = ""; catalogStale = false; catalogError = remoteErrorMessage(error, api?.relay == false) }
        }
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
        rpc("control.acquire", JSONObject().put("sessionId", selected))
        try { branchSnapshot = rpc(if(create) "branches.create" else "branches.switch", JSONObject().put("sessionId", selected).put("name", name).put("confirmed", true).put("stateToken", token)) as JSONObject; notice = "已${if(create) "创建并切换" else "切换"}到分支 $name" }
        finally { rpc("control.release", JSONObject().put("sessionId", selected)) }
    }
    fun gitOperation(method: String, params: JSONObject, token: String) = action {
        require(!sharedDevice && selected.isNotBlank()) { "请先打开自己的会话" }
        require(method in listOf("branches.switch", "branches.create", "worktrees.create", "worktrees.open"))
        val origin = selected
        loading = true
        try {
            rpc("control.acquire", JSONObject().put("sessionId", origin))
            try {
                val result = rpc(method, JSONObject(params.toString()).put("sessionId", origin).put("confirmed", true).put("stateToken", token)) as JSONObject
                if(method == "worktrees.open") { refreshSessions(); openSession(JSONObject().put("id", result.getString("sessionId")).put("cwd", result.getString("cwd"))).join() }
                else { branchSnapshot = result; notice = if(method == "worktrees.create") "Worktree 已创建，可点列表在其中新建对话" else "分支已更新" }
            } finally { rpc("control.release", JSONObject().put("sessionId", origin)) }
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
            rpc("control.acquire", JSONObject().put("sessionId", selected))
            try { applySelection(rpc("sessions.configure", JSONObject().put("sessionId", selected).put("provider", name).put("model", modelId)) as JSONObject) }
            finally { rpc("control.release", JSONObject().put("sessionId", selected)) }
        } else { provider = name; model = modelId }
        notice = "渠道已保存并立即生效"; backSheet()
    }
    fun loadExtensions() = action { extensions = rpc("extensions.list") as JSONObject; sheet = "extensions" }
    fun leaveChat() { polling?.cancel(); selected = ""; messages = emptyList(); contextUsage = JSONObject(); persistedSteps = emptySet(); persistedUserTurns = emptySet(); approvals = emptyList(); attachments = emptyList(); draft = ""; historyHasMore = false; historyBefore = ""; busy = false }
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
