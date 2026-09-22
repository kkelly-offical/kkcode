package cn.kkcode.remote

import org.json.JSONArray
import org.json.JSONObject
import java.net.URI

internal const val MAX_UPDATE_BYTES = 256L * 1024 * 1024
internal const val MAX_UPDATE_METADATA = 128 * 1024
internal const val MAX_RELEASE_LIST = 2 * 1024 * 1024
internal enum class UpdateChannel(val label: String) { STABLE("稳定版"), PREVIEW("预览版") }
internal data class AppUpdate(
    val versionName: String, val versionCode: Long, val minSdk: Int,
    val apkName: String, val size: Long, val sha256: String, val certificateSha256: String,
    val downloadUrl: String, val releaseUrl: String, val notes: String,
)
internal data class GitHubRelease(val tag: String, val prerelease: Boolean, val notes: String, val assetSizes: Map<String, Long>)

/** Fixed public GitHub source. Never receives SSO credentials or a user-supplied host. */
internal class UpdatePolicy(
    val repository: String = BuildConfig.UPDATE_REPOSITORY,
    val certificate: String = BuildConfig.UPDATE_CERT_SHA256,
    val applicationId: String = BuildConfig.APPLICATION_ID,
) {
    private val version = Regex("[0-9]+\\.[0-9]+\\.[0-9]+(?:-preview\\.[0-9]+)?")
    private val digest = Regex("[a-f0-9]{64}")
    init {
        require(repository.matches(Regex("[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")))
        require(certificate.matches(digest))
    }
    fun releaseUrl(tag: String): String = "https://github.com/$repository/releases/tag/$tag"
    fun assetUrl(tag: String, name: String): String = "https://github.com/$repository/releases/download/$tag/$name"
    fun apiUrl(page: Int): String {
        require(page in 1..3)
        return "https://api.github.com/repos/$repository/releases?per_page=20&page=$page"
    }
    fun releases(text: String, channel: UpdateChannel): List<GitHubRelease> {
        val rows = JSONArray(checkUpdateJson(text, MAX_RELEASE_LIST))
        require(rows.length() <= 100) { "GitHub 版本目录过大" }
        return (0 until rows.length()).mapNotNull { index ->
            val row = rows.getJSONObject(index)
            val tag = row.optString("tag_name")
            if(row.optBoolean("draft", true) || !tag.startsWith('v') || !version.matches(tag.drop(1))) return@mapNotNull null
            val prerelease = tag.contains('-')
            if(row.optBoolean("prerelease") != prerelease || channel == UpdateChannel.STABLE && prerelease) return@mapNotNull null
            val assets = row.optJSONArray("assets") ?: return@mapNotNull null
            require(assets.length() <= 100) { "GitHub 附件目录过大" }
            val sizes = mutableMapOf<String, Long>()
            for(at in 0 until assets.length()) {
                val asset = assets.getJSONObject(at)
                val name = asset.optString("name")
                if(name != "android-update.json" && name != "kkcode-android-${tag.drop(1)}.apk") continue
                require(asset.optString("browser_download_url") == assetUrl(tag, name)) { "更新附件地址不属于官方仓库" }
                require(!sizes.containsKey(name)) { "更新附件名称重复" }
                sizes[name] = strictUpdateLong(asset, "size", 1, MAX_UPDATE_BYTES)
            }
            if("android-update.json" !in sizes || "kkcode-android-${tag.drop(1)}.apk" !in sizes) return@mapNotNull null
            require(sizes.getValue("android-update.json") <= MAX_UPDATE_METADATA) { "更新清单过大" }
            GitHubRelease(tag, prerelease, row.optString("body").take(16000), sizes)
        }
    }
    fun manifest(text: String, release: GitHubRelease): AppUpdate {
        val data = JSONObject(checkUpdateJson(text, MAX_UPDATE_METADATA))
        require(strictUpdateLong(data, "schemaVersion", 1, 1) == 1L)
        require(data.getString("applicationId") == applicationId) { "更新包名不匹配" }
        val name = data.getString("versionName")
        require(name == release.tag.drop(1) && version.matches(name)) { "更新版本与发布标签不一致" }
        require(data.getString("channel") == if(release.prerelease) "preview" else "stable") { "更新渠道不匹配" }
        require(data.getString("protocolVersion") == "1") { "更新协议不兼容" }
        val code = strictUpdateLong(data, "versionCode", 1, 2100000000)
        val minSdk = strictUpdateLong(data, "minSdk", 29, 100).toInt()
        val apk = data.getJSONObject("apk")
        val file = apk.getString("name")
        require(file == "kkcode-android-$name.apk") { "更新文件名不匹配" }
        val hash = apk.getString("sha256")
        require(digest.matches(hash)) { "更新文件校验值无效" }
        require(apk.getString("certificateSha256") == certificate) { "更新签名不属于 KK Code" }
        val size = strictUpdateLong(apk, "size", 1, MAX_UPDATE_BYTES)
        require(release.assetSizes[file] == size) { "更新文件大小与发布附件不一致" }
        return AppUpdate(name, code, minSdk, file, size, hash, certificate, assetUrl(release.tag, file), releaseUrl(release.tag), release.notes)
    }
}

internal fun strictUpdateLong(value: JSONObject, key: String, min: Long, max: Long): Long {
    val raw = value.get(key)
    require(raw is Int || raw is Long) { "更新清单 $key 必须为整数" }
    return (raw as Number).toLong().also { require(it in min..max) { "更新清单 $key 超出范围" } }
}

internal fun checkUpdateJson(text: String, limit: Int): String {
    require(text.toByteArray(Charsets.UTF_8).size <= limit) { "更新信息过大" }
    var depth = 0; var quoted = false; var escaped = false
    for(char in text) {
        if(quoted) { if(escaped) escaped = false else if(char == '\\') escaped = true else if(char == '"') quoted = false }
        else when(char) { '"' -> quoted = true; '{', '[' -> { depth++; require(depth <= 32) { "更新信息嵌套过深" } }; '}', ']' -> depth-- }
    }
    return text
}

internal fun trustedUpdateTransportUrl(value: String): Boolean = try {
    val url = URI(value)
    url.scheme == "https" && url.rawUserInfo == null && url.rawFragment == null && (url.port == -1 || url.port == 443) &&
        url.host in setOf("api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com")
} catch(_: Exception) { false }
