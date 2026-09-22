package cn.kkcode.remote

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.URI
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resumeWithException

internal interface UpdateBody : AutoCloseable { val stream: InputStream; val length: Long }
internal fun interface UpdateTransport { suspend fun open(url: String): UpdateBody }

internal class GitHubUpdateTransport : UpdateTransport {
    private val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).callTimeout(5, TimeUnit.MINUTES).build()
    private suspend fun execute(call: Call): Response = suspendCancellableCoroutine { continuation ->
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, error: IOException) { if(continuation.isActive) continuation.resumeWithException(error) }
            override fun onResponse(call: Call, response: Response) { continuation.resume(response) { _, value, _ -> value.close() } }
        })
    }
    override suspend fun open(url: String): UpdateBody {
        var current = url
        repeat(6) {
            require(trustedUpdateTransportUrl(current)) { "更新下载地址不受信任" }
            val call = client.newCall(Request.Builder().url(current)
                .header("User-Agent", "KK Code/${BuildConfig.VERSION_NAME} (Android updater)")
                .header("Accept", if(URI(current).host == "api.github.com") "application/vnd.github+json" else "application/octet-stream")
                .build())
            val response = execute(call)
            if(response.code in listOf(301, 302, 303, 307, 308)) {
                val location = response.header("Location")
                response.close()
                require(!location.isNullOrBlank()) { "更新下载重定向无效" }
                current = URI(current).resolve(location).toString()
            } else {
                if(!response.isSuccessful || response.body == null) {
                    val status = response.code; response.close()
                    throw IOException(if(status == 403 || status == 429) "GitHub 暂时限流或拒绝访问，请稍后重试" else "更新服务暂不可用（HTTP $status）")
                }
                return object : UpdateBody {
                    override val stream = response.body!!.byteStream()
                    override val length = response.body!!.contentLength()
                    override fun close() { call.cancel(); response.close() }
                }
            }
        }
        throw IOException("更新下载重定向次数过多")
    }
}

internal class GitHubUpdateSource(
    private val policy: UpdatePolicy = UpdatePolicy(),
    private val transport: UpdateTransport = GitHubUpdateTransport(),
) {
    companion object { private val downloadLock = Mutex() }
    private suspend fun <T> withBody(url: String, block: suspend (UpdateBody) -> T): T = coroutineScope {
        val body = transport.open(url)
        val cancellation = launch(start = CoroutineStart.UNDISPATCHED) { try { awaitCancellation() } finally { body.close() } }
        try { body.use { block(it) } }
        catch(error: IOException) { currentCoroutineContext().ensureActive(); throw error }
        finally { cancellation.cancel() }
    }
    private suspend fun text(url: String, limit: Int): String = withBody(url) { body ->
        require(body.length <= limit) { "更新信息过大" }
        val bytes = java.io.ByteArrayOutputStream()
        copyUpdateBytes(body.stream, limit.toLong()) { chunk, size -> bytes.write(chunk, 0, size) }
        bytes.toString("UTF-8")
    }
    suspend fun check(channel: UpdateChannel, sdk: Int): AppUpdate? = withContext(Dispatchers.IO) {
        val candidates = mutableListOf<AppUpdate>()
        var manifests = 0
        for(page in 1..3) {
            currentCoroutineContext().ensureActive()
            val raw = text(policy.apiUrl(page), MAX_RELEASE_LIST)
            val releases = policy.releases(raw, channel)
            for(release in releases) {
                if(manifests >= 12) break
                manifests++
                val candidate = policy.manifest(text(policy.assetUrl(release.tag, "android-update.json"), MAX_UPDATE_METADATA), release)
                if(candidate.minSdk <= sdk) candidates += candidate
            }
            if(manifests >= 12 || org.json.JSONArray(raw).length() < 20) break
        }
        candidates.maxByOrNull { it.versionCode }
    }
    suspend fun download(update: AppUpdate, directory: File, progress: suspend (Long, Long) -> Unit = { _, _ -> }): File = withContext(Dispatchers.IO) { downloadLock.withLock {
        require(update.size in 1..MAX_UPDATE_BYTES && trustedUpdateTransportUrl(update.downloadUrl)) { "更新下载参数无效" }
        directory.mkdirs()
        val target = File(directory, "update-${update.versionCode}.apk")
        val partial = File(directory, "update-${update.versionCode}.part")
        require(target.canonicalFile.parentFile == directory.canonicalFile && partial.canonicalFile.parentFile == directory.canonicalFile) { "更新缓存路径无效" }
        for(old in directory.listFiles().orEmpty()) if(old.name.matches(Regex("update-[0-9]+\\.(apk|part)")) && old != target && old != partial) old.delete()
        require(directory.usableSpace >= update.size + 1024 * 1024) { "存储空间不足，请清理空间后重试" }
        try {
            withBody(update.downloadUrl) { body ->
                require(body.length < 0 || body.length == update.size) { "下载大小与更新清单不一致" }
                val digest = MessageDigest.getInstance("SHA-256")
                var total = 0L
                partial.outputStream().use { output ->
                    copyUpdateBytes(body.stream, update.size) { chunk, size ->
                        output.write(chunk, 0, size); digest.update(chunk, 0, size); total += size; progress(total, update.size)
                    }
                    output.fd.sync()
                }
                require(total == update.size) { "更新文件下载不完整" }
                require(digest.digest().joinToString("") { "%02x".format(it) } == update.sha256) { "更新文件校验失败，请重试" }
            }
            currentCoroutineContext().ensureActive()
            require(partial.renameTo(target)) { "无法保存已校验的更新" }
            target
        } finally { partial.delete() }
    } }
}

internal suspend fun copyUpdateBytes(input: InputStream, limit: Long, write: suspend (ByteArray, Int) -> Unit): Long {
    val buffer = ByteArray(65536); var total = 0L
    while(true) {
        currentCoroutineContext().ensureActive()
        var size = input.read(buffer)
        if(size < 0) break
        if(size == 0) { val next = input.read(); if(next < 0) break; buffer[0] = next.toByte(); size = 1 }
        total += size
        require(total <= limit) { "更新响应超过大小限制" }
        write(buffer, size)
    }
    return total
}
