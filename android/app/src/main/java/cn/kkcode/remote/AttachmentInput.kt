package cn.kkcode.remote

import android.content.ContentResolver
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream

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
        "png" -> "image/png"; "jpg", "jpeg" -> "image/jpeg"; "gif" -> "image/gif"; "webp" -> "image/webp"
        "wav" -> "audio/wav"; "mp3" -> "audio/mpeg"; "mp4" -> "video/mp4"; "mov" -> "video/quicktime"; "webm" -> "video/webm"; "mpeg", "mpg" -> "video/mpeg"
        "json" -> "application/json"; "xml" -> "application/xml"; "yaml", "yml" -> "application/yaml"
        "txt", "md", "mdx", "csv", "tsv", "log", "js", "jsx", "ts", "tsx", "py", "rb", "go", "rs", "java", "kt", "kts", "c", "h", "cpp", "hpp", "cs", "swift", "sh", "bash", "zsh", "html", "css", "scss", "sql", "toml", "ini", "conf" -> "text/plain"
        else -> "application/octet-stream"
    }
    val supplied = resolver.getType(uri)?.substringBefore(';')?.lowercase()
    val mime = if(supplied.isNullOrBlank() || supplied == "application/octet-stream") inferred else supplied
    require(mime in setOf("image/png", "image/jpeg", "image/gif", "image/webp", "audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3", "video/mp4", "video/quicktime", "video/webm", "video/mpeg", "application/json", "application/xml", "application/yaml", "application/x-yaml", "application/javascript", "application/typescript", "application/toml") || mime.startsWith("text/")) { "支持图片、WAV/MP3 音频、MP4/MOV/WebM/MPEG 视频和 UTF-8 文本" }
    val limit = if(listOf("image/", "audio/", "video/").any { mime.startsWith(it) }) 4 * 1024 * 1024 else 256 * 1024
    require(declaredSize <= limit) { "附件过大：媒体最多 4 MiB，文本最多 256 KiB" }
    val bytes = resolver.openInputStream(uri)?.use { readBoundedAttachment(it, limit) } ?: error("无法读取所选文档")
    return JSONObject().put("name", name).put("mediaType", mime).put("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
}
