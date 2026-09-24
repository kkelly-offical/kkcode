package cn.kkcode.remote

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.Base64
import java.util.UUID

internal const val ARTIFACT_MAX_BYTES = 128L * 1024 * 1024
internal const val ARTIFACT_PAGE_BYTES = 256 * 1024
private val artifactIdPattern = Regex("^art_[0-9a-f-]{36}$")
private val artifactHashPattern = Regex("^[0-9a-f]{64}$")

internal data class ArtifactItem(val id: String, val size: Long, val sha256: String, val mime: String, val pinned: Boolean, val referenced: Boolean) {
    companion object {
        fun parse(value: JSONObject): ArtifactItem {
            val id = value.optString("id"); val hash = value.optString("sha256")
            val size = artifactInteger(value, "size")
            require(artifactIdPattern.matches(id) && artifactHashPattern.matches(hash) && size in 0..ARTIFACT_MAX_BYTES) { "产物元数据无效或超过 128 MiB 安全上限。" }
            return ArtifactItem(id, size, hash, value.optString("mime", "application/octet-stream").take(200),
                value.optJSONObject("retention")?.optBoolean("pinned") == true, value.optJSONObject("retention")?.optBoolean("referenced") == true)
        }
    }
}

private fun artifactInteger(value: JSONObject, field: String): Long {
    val number = value.opt(field)
    require(number is Number && number.toDouble().isFinite() && number.toDouble() == number.toLong().toDouble() && number.toLong() >= 0) { "产物分块字段 $field 无效。" }
    return number.toLong()
}

internal data class ArtifactChunk(val bytes: ByteArray, val offset: Long, val nextCursor: String?)
internal fun decodeArtifactChunk(page: JSONObject, item: ArtifactItem, expectedOffset: Long, maxBytes: Int = ARTIFACT_PAGE_BYTES): ArtifactChunk {
    require(page.optString("id") == item.id && page.optString("sha256") == item.sha256 && artifactInteger(page, "size") == item.size) { "产物快照已改变，下载已停止。" }
    require(page.optString("encoding") == "base64" && artifactInteger(page, "offset") == expectedOffset) { "产物分块顺序或编码无效，下载已停止。" }
    val encoded = page.opt("data")
    require(encoded is String && encoded.length <= ((maxBytes + 2) / 3) * 4 && encoded.length % 4 == 0 && Regex("^[A-Za-z0-9+/]*={0,2}$").matches(encoded)) { "产物分块数据无效或过大。" }
    val bytes = try { Base64.getDecoder().decode(encoded) } catch (_: IllegalArgumentException) { throw IllegalArgumentException("产物分块不是有效 Base64。") }
    require(Base64.getEncoder().encodeToString(bytes) == encoded && bytes.size <= maxBytes && expectedOffset + bytes.size <= item.size) { "产物分块大小或编码不一致。" }
    require(page.has("nextCursor")) { "产物响应缺少结束标记。" }
    val next = if(page.isNull("nextCursor")) null else page.opt("nextCursor").let {
        require(it is String && it.length in 1..2048 && Regex("^[A-Za-z0-9_-]+$").matches(it)) { "产物分页游标无效。" }; it
    }
    require((next == null) == (expectedOffset + bytes.size == item.size)) { "产物提前结束或结束后仍有分块，下载已停止。" }
    require(bytes.isNotEmpty() || item.size == 0L) { "产物分块没有进展。" }
    return ArtifactChunk(bytes, expectedOffset, next)
}

/** One bounded page at a time, never Buffer/ByteArray the complete artifact.
 * The caller owns the verified cache file and must delete it after saving. */
internal suspend fun downloadArtifactToCache(
    item: ArtifactItem,
    sessionId: String,
    directory: File,
    request: suspend (String, JSONObject) -> JSONObject,
    progress: suspend (Long, Long) -> Unit = { _, _ -> }
): File {
    var staged: File? = null
    try { return withContext(Dispatchers.IO) {
    require(sessionId.isNotBlank()) { "请先选择会话。" }
    require(item.size in 0..ARTIFACT_MAX_BYTES && artifactIdPattern.matches(item.id) && artifactHashPattern.matches(item.sha256)) { "产物元数据无效。" }
    check(directory.isDirectory || directory.mkdirs()) { "无法创建本机下载缓存。" }
    val partial = File.createTempFile("artifact-", ".part", directory)
    staged = partial
    partial.setReadable(false, false); partial.setReadable(true, true)
    partial.setWritable(false, false); partial.setWritable(true, true)
    try {
        val digest = MessageDigest.getInstance("SHA-256")
        val cursors = HashSet<String>()
        var cursor: String? = null; var offset = 0L; var pages = 0
        FileOutputStream(partial).use { output ->
            do {
                currentCoroutineContext().ensureActive()
                require(++pages <= 4096) { "产物分页次数超过安全上限。" }
                val params = JSONObject().put("sessionId", sessionId).put("id", item.id).put("limit", ARTIFACT_PAGE_BYTES)
                if(cursor != null) params.put("cursor", cursor)
                val page = request("artifacts.download", params)
                currentCoroutineContext().ensureActive()
                val chunk = decodeArtifactChunk(page, item, offset)
                output.write(chunk.bytes); digest.update(chunk.bytes); offset += chunk.bytes.size
                cursor = chunk.nextCursor
                if(cursor != null) require(cursors.add(cursor!!)) { "产物分页游标重复，下载已停止。" }
                progress(offset, item.size)
            } while(cursor != null)
            output.fd.sync()
        }
        currentCoroutineContext().ensureActive()
        val actual = digest.digest().joinToString("") { "%02x".format(it) }
        require(actual == item.sha256 && offset == item.size) { "产物 SHA-256 校验失败，未提供保存或打开。" }
        val complete = File(directory, "artifact-${UUID.randomUUID()}.verified")
        check(partial.renameTo(complete)) { "无法完成已校验产物的缓存写入。" }
        staged = complete
        complete
    } finally {
        partial.delete()
    }
    } } catch(error: Throwable) {
        withContext(NonCancellable + Dispatchers.IO) { staged?.delete() }
        throw error
    }
}
