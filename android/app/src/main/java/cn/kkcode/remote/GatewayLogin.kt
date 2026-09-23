package cn.kkcode.remote

import java.io.IOException
import java.net.URI
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import org.json.JSONObject

internal const val LOGIN_RETURN_URI = "cn.kkcode.remote://auth/complete"
internal const val PENDING_LOGIN_KEY = "pending-gateway-login"
private val loginSecretPattern = Regex("[A-Za-z0-9_-]{43}")
private fun loginSecret(): String = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32).also { SecureRandom().nextBytes(it) })
internal fun loginChallenge(verifier: String): String = Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))

internal data class PendingGatewayLogin(
    val gateway: String, val deviceCode: String, val userCode: String,
    val state: String, val verifier: String, val native: Boolean,
    val expiresAt: Long, val intervalMs: Long, val nextPollAt: Long
) {
    fun json(): String = JSONObject().put("gateway", gateway).put("deviceCode", deviceCode).put("userCode", userCode)
        .put("state", state).put("verifier", verifier).put("native", native).put("expiresAt", expiresAt)
        .put("intervalMs", intervalMs).put("nextPollAt", nextPollAt).toString()
    fun proof(): JSONObject = JSONObject().put("device_code", deviceCode).also { if(native) it.put("code_verifier", verifier) }
    fun acceptsReturn(value: String?): Boolean = try {
        val uri = URI(value ?: "")
        native && uri.scheme == "cn.kkcode.remote" && uri.rawAuthority == "auth" && uri.rawPath == "/complete" && uri.rawFragment == null &&
            uri.rawQuery?.matches(Regex("state=[A-Za-z0-9_-]{43}")) == true &&
            MessageDigest.isEqual(uri.rawQuery.removePrefix("state=").toByteArray(), state.toByteArray())
    } catch(_: Exception) { false }

    companion object {
        fun read(value: String, debug: Boolean): PendingGatewayLogin {
            val data = JSONObject(value)
            val result = PendingGatewayLogin(data.getString("gateway"), data.getString("deviceCode"), data.getString("userCode"),
                data.getString("state"), data.getString("verifier"), data.getBoolean("native"), data.getLong("expiresAt"), data.getLong("intervalMs"), data.getLong("nextPollAt"))
            require(validGatewayUrl(result.gateway, debug) && result.deviceCode.length in 16..512 && result.state.matches(loginSecretPattern) && result.verifier.matches(loginSecretPattern))
            deviceLoginUrl(result.gateway, result.userCode, debug)
            require(result.expiresAt > 0 && result.intervalMs in 5000..600000 && result.nextPollAt > 0)
            return result
        }
    }
}

internal class GatewayLoginPaused : IOException("登录网络暂不可用，进度已保存；返回前台或点击继续登录可重试")
internal class GatewayLoginEnded(message: String) : Exception(message)
internal suspend fun retryLoginRequest(pause: suspend (Long) -> Unit = { delay(it) }, request: suspend () -> JSONObject): JSONObject {
    var failures = 0
    while(true) {
        try { return request() }
        catch(error: CancellationException) { throw error }
        catch(error: Exception) {
            if(error !is IOException && !(error is DeviceApiError && error.status in listOf(429, 502, 503, 504)) || failures >= 5) throw error
            pause((500L shl failures).coerceAtMost(8000)); failures++
        }
    }
}

internal suspend fun beginGatewayLogin(gateway: String, debug: Boolean, now: () -> Long = System::currentTimeMillis): PendingGatewayLogin {
    require(validGatewayUrl(gateway, debug)) { "请使用 HTTPS 网关地址，不支持 URL 用户名或密码" }
    val client = DeviceApi(gateway)
    val discovery = retryLoginRequest { client.call("/api/v1/discovery") }
    val canonical = discovery.getString("gateway")
    require(validGatewayUrl(canonical, debug)) { "网关返回了不安全的登录地址" }
    client.base = canonical
    val capability = discovery.optJSONObject("authentication")?.optJSONObject("nativeLogin")
    val native = capability?.optInt("version") == 1 && capability.optString("platform") == "android" &&
        capability.optString("redirectUri") == LOGIN_RETURN_URI && capability.optString("pkce") == "S256"
    val state = loginSecret(); val verifier = loginSecret()
    val request = JSONObject().put("name", "KK Code Android").put("kind", "client")
    if(native) request.put("native", JSONObject().put("platform", "android").put("state", state)
        .put("code_challenge", loginChallenge(verifier)).put("code_challenge_method", "S256"))
    val response = retryLoginRequest { client.call("/auth/device", request) }
    require(!native || response.optBoolean("native_return")) { "网关没有启用安全 App 回跳，请升级网关后重试" }
    val duration = response.getLong("expires_in"); require(duration in 1..3600) { "网关返回了无效的登录有效期" }
    val interval = response.optLong("interval", 5).coerceAtLeast(5); require(interval <= 60) { "网关返回了无效的轮询间隔" }
    val result = PendingGatewayLogin(canonical, response.getString("device_code"), response.getString("user_code"), state, verifier, native,
        now() + duration * 1000, interval * 1000, now() + interval * 1000)
    return PendingGatewayLogin.read(result.json(), debug)
}

/** Persist before every attempt so process recreation cannot reset rate limits. */
private fun loginTokenRequest(gateway: String): suspend (JSONObject) -> JSONObject {
    val client = DeviceApi(gateway)
    return { client.call("/auth/token", it) }
}
internal suspend fun pollGatewayLogin(
    initial: PendingGatewayLogin, persist: (PendingGatewayLogin) -> Unit,
    request: suspend (JSONObject) -> JSONObject = loginTokenRequest(initial.gateway),
    now: () -> Long = System::currentTimeMillis, pause: suspend (Long) -> Unit = { delay(it) }
): JSONObject {
    var pending = initial
    var failures = 0
    while(now() < pending.expiresAt) {
        pause((pending.nextPollAt - now()).coerceAtLeast(0).coerceAtMost((pending.expiresAt - now()).coerceAtLeast(0)))
        if(now() >= pending.expiresAt) break
        pending = pending.copy(nextPollAt = now() + pending.intervalMs); persist(pending)
        try { return request(pending.proof()) }
        catch(error: CancellationException) { throw error }
        catch(error: Exception) {
            val reason = if(error is DeviceApiError) error.message else null
            when(reason) {
                "authorization_pending" -> failures = 0
                "slow_down" -> { failures = 0; pending = pending.copy(intervalMs = (pending.intervalMs + 5000).coerceAtMost(600000)) }
                "access_denied" -> throw GatewayLoginEnded("登录已取消，可重新发起")
                "authorization_failed" -> throw GatewayLoginEnded("组织认证未能完成，请重新登录；持续失败请联系网关管理员")
                "membership_disabled" -> throw GatewayLoginEnded("组织已停用此账号，请联系管理员")
                "expired_token" -> throw GatewayLoginEnded("登录已超时，请重新登录")
                "invalid_grant" -> throw GatewayLoginEnded("登录校验失败，请重新登录")
                else -> {
                    if(error !is IOException && !(error is DeviceApiError && error.status in listOf(429, 502, 503, 504))) throw error
                    failures++
                    pending = pending.copy(nextPollAt = now() + (pending.intervalMs * (1L shl failures.coerceAtMost(4))).coerceAtMost(60000).coerceAtLeast(pending.intervalMs))
                    persist(pending)
                    if(failures > 5) throw GatewayLoginPaused()
                    continue
                }
            }
            pending = pending.copy(nextPollAt = now() + pending.intervalMs); persist(pending)
        }
    }
    throw GatewayLoginEnded("登录已超时，请重新登录")
}
