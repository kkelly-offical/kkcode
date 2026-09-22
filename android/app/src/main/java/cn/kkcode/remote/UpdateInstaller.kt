package cn.kkcode.remote

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import java.io.File
import java.security.MessageDigest

internal data class UpdateArchive(val packageName: String, val versionName: String, val versionCode: Long, val signers: Set<String>, val debuggable: Boolean)
internal fun assertUpdateArchive(update: AppUpdate, archive: UpdateArchive, installed: UpdateArchive) {
    require(archive.packageName == installed.packageName) { "安装包不是当前应用" }
    require(archive.versionName == update.versionName && archive.versionCode == update.versionCode && archive.versionCode > installed.versionCode) { "安装版本不匹配或不是新版本" }
    require(!archive.debuggable) { "不能把开发安装包当作正式更新" }
    require(archive.signers == setOf(update.certificateSha256)) { "APK 签名与更新清单不一致" }
    require(installed.signers == archive.signers) { "当前安装的签名与正式版不同，不能覆盖更新；请手动安装正式版，勿直接删除数据" }
}

internal fun archiveInfo(info: android.content.pm.PackageInfo): UpdateArchive = UpdateArchive(
    info.packageName, info.versionName ?: "", info.longVersionCode,
    info.signingInfo?.apkContentsSigners?.map { signature -> MessageDigest.getInstance("SHA-256").digest(signature.toByteArray()).joinToString("") { "%02x".format(it) } }?.toSet() ?: emptySet(),
    (info.applicationInfo?.flags ?: 0) and ApplicationInfo.FLAG_DEBUGGABLE != 0,
)

internal fun verifyUpdateApk(context: Context, file: File, update: AppUpdate) {
    require(file.isFile && file.length() == update.size) { "已下载的安装包不可用，请重新下载" }
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input -> val buffer = ByteArray(65536); while(true) { val count = input.read(buffer); if(count < 0) break; digest.update(buffer, 0, count) } }
    require(digest.digest().joinToString("") { "%02x".format(it) } == update.sha256) { "安装包在下载后发生变化，已停止安装" }
    val manager = context.packageManager
    val archive = manager.getPackageArchiveInfo(file.path, PackageManager.GET_SIGNING_CERTIFICATES) ?: error("系统无法读取 APK 签名")
    val installed = manager.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
    assertUpdateArchive(update, archiveInfo(archive), archiveInfo(installed))
}

internal fun updateInstallPreferences(context: Context) = context.getSharedPreferences("kkcode.update-install", Context.MODE_PRIVATE)
internal fun commitUpdateInstall(context: Context, file: File, update: AppUpdate): Int {
    require(context.packageManager.canRequestPackageInstalls()) { "请先允许 KK Code 安装应用" }
    verifyUpdateApk(context, file, update)
    val installer = context.packageManager.packageInstaller
    val preferences = updateInstallPreferences(context)
    val previous = preferences.getInt("session", -1)
    if(previous >= 0) runCatching { installer.abandonSession(previous) }
    val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
        setAppPackageName(context.packageName); setSize(file.length())
        if(Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
    }
    val id = installer.createSession(params)
    try {
        installer.openSession(id).use { session ->
            session.openWrite("base.apk", 0, file.length()).use { output -> file.inputStream().use { it.copyTo(output) }; session.fsync(output) }
            check(preferences.edit().putInt("session", id).putLong("versionCode", update.versionCode).putString("status", "installing").putString("message", "").commit())
            val callback = Intent(context, UpdateInstallReceiver::class.java).setAction("${context.packageName}.UPDATE_INSTALL")
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or if(Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
            val sender = PendingIntent.getBroadcast(context, id, callback, flags)
            session.commit(sender.intentSender)
        }
        return id
    } catch(error: Exception) {
        runCatching { installer.abandonSession(id) }
        preferences.edit().putString("status", "failed").putString("message", "系统未能开始安装，请重试").apply()
        throw error
    }
}

/** Explicit, non-exported callback. PendingIntent is only handed to PackageInstaller. */
class UpdateInstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if(intent.action != "${context.packageName}.UPDATE_INSTALL") return
        val preferences = updateInstallPreferences(context)
        if(intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -2) != preferences.getInt("session", -1)) return
        when(val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION") val confirmation = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                preferences.edit().putString("status", "confirmation").apply()
                try { requireNotNull(confirmation); context.startActivity(confirmation.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                catch(_: Exception) { preferences.edit().putString("status", "failed").putString("message", "请回到应用重新发起系统安装确认").apply() }
            }
            PackageInstaller.STATUS_SUCCESS -> preferences.edit().putString("status", "success").putString("message", "更新安装完成").apply()
            else -> preferences.edit().putString("status", "failed").putString("message", if(status == PackageInstaller.STATUS_FAILURE_ABORTED) "已取消安装，可以稍后重试" else "系统未完成更新（错误码 $status），请重试或手动安装").apply()
        }
    }
}
