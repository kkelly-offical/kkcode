package cn.kkcode.remote

import java.net.URI

internal fun validGatewayUrl(value: String, debug: Boolean): Boolean = try {
    val uri = URI(value)
    val scheme = uri.scheme?.lowercase()
    val host = uri.host?.lowercase()
    host != null && uri.userInfo == null && uri.fragment == null && uri.query == null &&
        (scheme == "https" || scheme == "http" && (host == "127.0.0.1" || host == "localhost" || debug && host == "10.0.2.2"))
} catch(_: Exception) { false }
