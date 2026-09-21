package cn.kkcode.remote

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Response
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.io.IOException
import kotlin.coroutines.resumeWithException

class DeviceApiError(message: String, val status: Int, val code: String) : Exception(message)

class DeviceApi(var base: String, var token: String = "", var device: String = "", var relay: Boolean = true, var hostHeader: String? = null) {
    private val client = OkHttpClient.Builder().callTimeout(35, TimeUnit.SECONDS).build()
    private suspend fun execute(request: Request): Response = suspendCancellableCoroutine { continuation ->
        val call = client.newCall(request)
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, error: IOException) { if(continuation.isActive) continuation.resumeWithException(error) }
            override fun onResponse(call: Call, response: Response) { continuation.resume(response) { _, value, _ -> value.close() } }
        })
    }
    suspend fun call(path: String, body: JSONObject? = null): JSONObject = withContext(Dispatchers.IO) {
        val request = Request.Builder().url(base.trimEnd('/') + path)
        request.header("User-Agent", "KK Code/${BuildConfig.VERSION_NAME} (Android)")
        hostHeader?.let { request.header("Host", it) }
        if (token.isNotBlank()) request.header("Authorization", "Bearer $token")
        if (body != null) request.post(body.toString().toRequestBody("application/json".toMediaType()))
        execute(request.build()).use { response ->
            val raw = response.body?.string() ?: "{}"
            val result = try { if (raw.trimStart().startsWith("[")) JSONObject().put("items", org.json.JSONArray(raw)) else JSONObject(raw) } catch (_: Exception) { throw DeviceApiError("HTTP ${response.code}", response.code, "invalid_response") }
            if (!response.isSuccessful || result.has("error")) throw DeviceApiError(result.optJSONObject("error")?.optString("message") ?: result.optString("error", "HTTP ${response.code}"), response.code, result.optJSONObject("error")?.optString("code") ?: "http_${response.code}")
            result
        }
    }
    suspend fun rpc(method: String, params: JSONObject = JSONObject()): Any? {
        val path = if (relay) "/api/v1/devices/$device/rpc" else "/api/v1/rpc"
        val request = JSONObject().put("id", UUID.randomUUID().toString()).put("issuedAt", System.currentTimeMillis()).put("method", method).put("params", params)
        var attempts = 0
        while(true) {
            try { return call(path, request).opt("result") }
            catch(error: Exception) {
                val retryable = error is IOException || error is DeviceApiError && error.status in listOf(429, 502, 503, 504)
                if(!retryable || attempts >= 5) throw error
                delay((250L shl attempts).coerceAtMost(4000)); attempts++
            }
        }
    }
}
