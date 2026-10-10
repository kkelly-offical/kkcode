package cn.kkcode.remote

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import kotlinx.coroutines.CancellationException
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream

internal const val ATTACHMENT_PREVIEW_MAX_DIMENSION = 128
internal const val ATTACHMENT_PREVIEW_MAX_BYTES = 64 * 1024
internal const val ATTACHMENT_PREVIEW_MAX_BASE64_CHARS = ((ATTACHMENT_PREVIEW_MAX_BYTES + 2) / 3) * 4

internal data class AttachmentOrigin(val sessionId: String, val generation: Int, val client: DeviceApi, val device: String) {
    fun matches(selectedSession: String, currentGeneration: Int, currentClient: DeviceApi?): Boolean =
        sessionId == selectedSession && generation == currentGeneration && currentClient === client && currentClient?.device == device

    fun requireCurrent(selectedSession: String, currentGeneration: Int, currentClient: DeviceApi?) {
        if(!matches(selectedSession, currentGeneration, currentClient)) throw CancellationException("会话已切换")
    }

    suspend fun rpc(method: String, params: JSONObject): Any? = client.rpc(method, params, device)
}

internal fun attachmentPreviewSampleSize(width: Int, height: Int, maxDimension: Int = ATTACHMENT_PREVIEW_MAX_DIMENSION): Int {
    require(maxDimension > 0)
    if(width <= 0 || height <= 0) return 1
    var sample = 1
    while(maxOf(width, height) / (sample * 2) >= maxDimension) sample *= 2
    return sample
}

internal fun createAttachmentPreview(input: JSONObject): String {
    if(!input.optString("mediaType").startsWith("image/")) return ""
    return runCatching {
        val bytes = Base64.decode(input.optString("data"), Base64.NO_WRAP)
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if(bounds.outWidth <= 0 || bounds.outHeight <= 0) return@runCatching ""
        val options = BitmapFactory.Options().apply { inSampleSize = attachmentPreviewSampleSize(bounds.outWidth, bounds.outHeight) }
        val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options) ?: return@runCatching ""
        val scale = (ATTACHMENT_PREVIEW_MAX_DIMENSION.toFloat() / maxOf(decoded.width, decoded.height)).coerceAtMost(1f)
        val preview = if(scale < 1f) Bitmap.createScaledBitmap(decoded, (decoded.width * scale).toInt().coerceAtLeast(1), (decoded.height * scale).toInt().coerceAtLeast(1), true) else decoded
        try {
            val output = ByteArrayOutputStream()
            if(!preview.compress(Bitmap.CompressFormat.PNG, 100, output) || output.size() > ATTACHMENT_PREVIEW_MAX_BYTES) ""
            else Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP)
        } finally {
            if(preview !== decoded) preview.recycle()
            decoded.recycle()
        }
    }.getOrDefault("")
}

internal fun bindAttachmentPreview(result: JSONObject, mediaType: String, preview: String): JSONObject {
    result.remove("preview")
    if(mediaType.startsWith("image/") && preview.isNotBlank() && preview.length <= ATTACHMENT_PREVIEW_MAX_BASE64_CHARS) result.put("preview", preview)
    return result
}

internal fun readBoundedAttachment(input: InputStream, limit: Int): ByteArray {
    require(limit > 0)
    val output = ByteArrayOutputStream()
    val buffer = ByteArray(8192)
    while(true) {
        val count = input.read(buffer)
        if(count < 0) break
        if(count == 0) {
            val single = input.read()
            if(single < 0) break
            require(output.size() < limit) { "附件超过大小限制" }
            output.write(single)
            continue
        }
        require(output.size() + count <= limit) { "附件超过大小限制" }
        output.write(buffer, 0, count)
    }
    return output.toByteArray()
}

/** SAF grants access to exactly the chosen document; no broad storage permission. */
internal fun readAttachment(resolver: ContentResolver, uri: Uri): JSONObject {
    require(uri.scheme == "content") { "请选择设备上的文档" }
    var name = "attachment.txt"
    var declaredSize = -1L
    resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
        if(cursor.moveToFirst()) {
            cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 }?.let { name = cursor.getString(it) ?: name }
            cursor.getColumnIndex(OpenableColumns.SIZE).takeIf { it >= 0 && !cursor.isNull(it) }?.let { declaredSize = cursor.getLong(it) }
        }
    }
    val inferred = when(name.substringAfterLast('.').lowercase()) {
        "pdf" -> "application/pdf"; "docx" -> "application/vnd.openxmlformats-officedocument.wordprocessingml.document"; "xlsx" -> "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"; "pptx" -> "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        "png" -> "image/png"; "jpg", "jpeg" -> "image/jpeg"; "gif" -> "image/gif"; "webp" -> "image/webp"
        "wav" -> "audio/wav"; "mp3" -> "audio/mpeg"; "mp4" -> "video/mp4"; "mov" -> "video/quicktime"; "webm" -> "video/webm"; "mpeg", "mpg" -> "video/mpeg"
        "json" -> "application/json"; "xml" -> "application/xml"; "yaml", "yml" -> "application/yaml"
        "txt", "md", "mdx", "csv", "tsv", "log", "js", "jsx", "ts", "tsx", "py", "rb", "go", "rs", "java", "kt", "kts", "c", "h", "cpp", "hpp", "cs", "swift", "sh", "bash", "zsh", "html", "css", "scss", "sql", "toml", "ini", "conf" -> "text/plain"
        else -> "application/octet-stream"
    }
    val supplied = resolver.getType(uri)?.substringBefore(';')?.lowercase()
    val mime = if(supplied.isNullOrBlank() || supplied == "application/octet-stream") inferred else supplied
    val document = mime in setOf("application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.openxmlformats-officedocument.presentationml.presentation")
    require(document || mime in setOf("image/png", "image/jpeg", "image/gif", "image/webp", "audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3", "video/mp4", "video/quicktime", "video/webm", "video/mpeg", "application/json", "application/xml", "application/yaml", "application/x-yaml", "application/javascript", "application/typescript", "application/toml") || mime.startsWith("text/")) { "支持 PDF、DOCX、XLSX、PPTX、图片、WAV/MP3 音频、MP4/MOV/WebM/MPEG 视频和 UTF-8 文本" }
    val limit = if(document || listOf("image/", "audio/", "video/").any { mime.startsWith(it) }) 4 * 1024 * 1024 else 256 * 1024
    require(declaredSize <= limit) { "附件过大：媒体最多 4 MiB，文本最多 256 KiB" }
    val bytes = resolver.openInputStream(uri)?.use { readBoundedAttachment(it, limit) } ?: error("无法读取所选文档")
    return JSONObject().put("name", name).put("mediaType", mime).put("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
}
