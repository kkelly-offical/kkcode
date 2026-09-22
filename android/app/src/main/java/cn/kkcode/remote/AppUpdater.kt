package cn.kkcode.remote

import android.app.Application
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.compose.runtime.*
import kotlinx.coroutines.*
import org.json.JSONObject
import java.io.File

internal enum class UpdatePhase { IDLE, CHECKING, CURRENT, AVAILABLE, DOWNLOADING, READY, PERMISSION, INSTALLING, ERROR }

internal class AppUpdater(
    private val application: Application,
    private val scope: CoroutineScope,
    private val source: GitHubUpdateSource = GitHubUpdateSource(),
) {
    private val prefs = application.getSharedPreferences("kkcode.updates", Context.MODE_PRIVATE)
    var channel by mutableStateOf(runCatching { UpdateChannel.valueOf(prefs.getString("channel", if(BuildConfig.VERSION_NAME.contains('-')) "PREVIEW" else "STABLE")!!) }.getOrDefault(UpdateChannel.STABLE)); private set
    var phase by mutableStateOf(UpdatePhase.IDLE); private set
    var candidate by mutableStateOf<AppUpdate?>(null); private set
    var message by mutableStateOf(""); private set
    var progress by mutableIntStateOf(0); private set
    var checkedAt by mutableLongStateOf(0); private set
    var dismissedCode by mutableLongStateOf(prefs.getLong("dismissedCode", 0)); private set
    val currentVersion: String get() = BuildConfig.VERSION_NAME
    val hasUpdate: Boolean get() = (candidate?.versionCode ?: 0) > BuildConfig.VERSION_CODE
    val working: Boolean get() = phase in setOf(UpdatePhase.CHECKING, UpdatePhase.DOWNLOADING, UpdatePhase.INSTALLING)
    private var job: Job? = null
    private var downloaded: File? = null
    private val directory get() = File(application.cacheDir, "app-updates")
    init { restoreCandidate() }

    private fun cache(update: AppUpdate): String = JSONObject().put("schemaVersion", 1).put("applicationId", BuildConfig.APPLICATION_ID)
        .put("versionName", update.versionName).put("versionCode", update.versionCode).put("minSdk", update.minSdk).put("protocolVersion", "1")
        .put("channel", if(update.versionName.contains('-')) "preview" else "stable")
        .put("apk", JSONObject().put("name", update.apkName).put("size", update.size).put("sha256", update.sha256).put("certificateSha256", update.certificateSha256))
        .put("notes", update.notes).toString()
    private fun restoreCandidate() {
        candidate = runCatching {
            val text = prefs.getString("candidate-${channel.name}", null) ?: return@runCatching null
            val json = JSONObject(checkUpdateJson(text, MAX_UPDATE_METADATA)); val version = json.getString("versionName")
            val apk = json.getJSONObject("apk"); val release = GitHubRelease("v$version", version.contains('-'), json.optString("notes").take(16000), mapOf(apk.getString("name") to strictUpdateLong(apk, "size", 1, MAX_UPDATE_BYTES)))
            require(channel == UpdateChannel.PREVIEW || !release.prerelease)
            UpdatePolicy().manifest(text, release).takeIf { it.minSdk <= Build.VERSION.SDK_INT }
        }.getOrNull()
        checkedAt = prefs.getLong("checked-${channel.name}", 0)
        phase = if(hasUpdate) UpdatePhase.AVAILABLE else UpdatePhase.IDLE
    }
    fun dismissNotice() { dismissedCode = candidate?.versionCode ?: 0; prefs.edit().putLong("dismissedCode", dismissedCode).apply() }
    fun selectChannel(value: UpdateChannel) {
        if(phase == UpdatePhase.INSTALLING || channel == value) return
        job?.cancel(); downloaded = null; channel = value; prefs.edit().putString("channel", value.name).apply()
        restoreCandidate(); check(true)
    }
    fun onForeground() {
        val install = updateInstallPreferences(application)
        when(install.getString("status", "")) {
            "success" -> { message = "更新安装完成"; install.edit().clear().apply() }
            "failed" -> { message = install.getString("message", "安装未完成") ?: "安装未完成"; phase = if(downloaded != null) UpdatePhase.READY else UpdatePhase.ERROR; install.edit().clear().apply() }
            "confirmation", "installing" -> if(phase == UpdatePhase.INSTALLING) { phase = if(downloaded != null) UpdatePhase.READY else UpdatePhase.AVAILABLE; message = "安装尚未完成，可再次确认或稍后重试" }
        }
        if(phase == UpdatePhase.PERMISSION && application.packageManager.canRequestPackageInstalls()) { phase = UpdatePhase.READY; message = "安装权限已允许，请点“安装更新”继续" }
        if(phase !in setOf(UpdatePhase.READY, UpdatePhase.PERMISSION, UpdatePhase.INSTALLING, UpdatePhase.DOWNLOADING)) check(false)
    }
    fun check(force: Boolean = true) {
        if(phase in setOf(UpdatePhase.DOWNLOADING, UpdatePhase.INSTALLING)) return
        val now = System.currentTimeMillis(); val lastAttempt = prefs.getLong("attempt-${channel.name}", 0)
        if(!force && ((checkedAt > 0 && now - checkedAt in 0..(12 * 3600_000L)) || now - lastAttempt in 0..(30 * 60_000L))) return
        job?.cancel(); val selectedChannel = channel
        phase = UpdatePhase.CHECKING; message = ""; prefs.edit().putLong("attempt-${channel.name}", now).apply()
        job = scope.launch {
            try {
                val result = source.check(selectedChannel, Build.VERSION.SDK_INT)
                ensureActive(); if(channel != selectedChannel) return@launch
                candidate = result; checkedAt = System.currentTimeMillis(); downloaded = null
                prefs.edit().putLong("checked-${channel.name}", checkedAt).also { if(result == null) it.remove("candidate-${channel.name}") else it.putString("candidate-${channel.name}", cache(result)) }.apply()
                phase = if(hasUpdate) UpdatePhase.AVAILABLE else UpdatePhase.CURRENT
                message = if(result == null) "该渠道暂无适用于此设备的已验证 Android 发行版" else if(hasUpdate) "发现新版本 ${result.versionName}" else "已安装当前渠道的最新兼容版本"
            } catch(error: CancellationException) { throw error }
            catch(error: Exception) { phase = UpdatePhase.ERROR; message = updateErrorMessage(error) }
        }
    }
    fun download() {
        val update = candidate?.takeIf { hasUpdate } ?: return
        if(working) return
        job?.cancel(); phase = UpdatePhase.DOWNLOADING; message = "正在下载并校验更新"; progress = 0
        job = scope.launch {
            try {
                val file = source.download(update, directory) { current, total ->
                    val percent = (current * 100 / total).toInt()
                    if(percent != progress) withContext(Dispatchers.Main.immediate) { progress = percent }
                }
                withContext(Dispatchers.IO) { verifyUpdateApk(application, file, update) }
                ensureActive(); downloaded = file; phase = UpdatePhase.READY; message = "文件与签名校验通过，可以安装"
            } catch(error: CancellationException) { throw error }
            catch(error: Exception) { phase = UpdatePhase.ERROR; message = updateErrorMessage(error) }
        }
    }
    fun cancel() {
        if(phase == UpdatePhase.INSTALLING) return
        job?.cancel(); job = null; phase = if(hasUpdate) UpdatePhase.AVAILABLE else UpdatePhase.IDLE; message = "已取消，可以稍后重试"
    }
    fun install(context: Context) {
        val update = candidate ?: return
        val file = downloaded ?: return
        if(phase == UpdatePhase.INSTALLING) return
        if(!application.packageManager.canRequestPackageInstalls()) {
            phase = UpdatePhase.PERMISSION; message = "请在系统设置中允许 KK Code 安装应用，返回后继续"
            try { context.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))) }
            catch(_: Exception) { phase = UpdatePhase.READY; message = "无法打开安装权限设置，请在系统设置中手动允许" }
            return
        }
        phase = UpdatePhase.INSTALLING; message = "请在系统界面确认更新；安装时 App 会关闭"
        job = scope.launch {
            try { withContext(Dispatchers.IO) { commitUpdateInstall(application, file, update) } }
            catch(error: CancellationException) { throw error }
            catch(error: Exception) { phase = UpdatePhase.READY; message = updateErrorMessage(error) }
        }
    }
}

internal fun updateErrorMessage(error: Exception): String = if(error is IllegalArgumentException || error is IllegalStateException) error.message ?: "更新校验失败" else "无法完成更新请求，请检查网络后重试；聊天不受影响"
