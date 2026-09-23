package cn.kkcode.remote

import org.json.JSONObject
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException

internal fun deviceResponseError(result: JSONObject, status: Int): DeviceApiError {
    val nested = result.optJSONObject("error")
    val message = nested?.optString("message")?.takeIf { it.isNotBlank() }
        ?: result.optString("message").takeIf { it.isNotBlank() }
        ?: result.optString("error_description").takeIf { it.isNotBlank() }
        ?: (result.opt("error") as? String)?.takeIf { it.isNotBlank() }
        ?: "HTTP $status"
    val code = nested?.optString("code")?.takeIf { it.isNotBlank() }
        ?: result.optString("code").takeIf { it.isNotBlank() } ?: "http_$status"
    return DeviceApiError(message, status, code)
}

internal fun safeErrorDetail(value: String): String = value
    .replace(Regex("-----BEGIN [^-]*PRIVATE KEY-----[\\s\\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)"), "[密钥已隐藏]")
    .replace(Regex("(?i)Bearer\\s+[^\\s,;]+"), "Bearer [已隐藏]")
    .replace(Regex("(?i)(api[_-]?key|token|password|secret)([\\s\"']*[:=][\\s\"']*)[^\\s\"'&,;]+"), "$1$2[已隐藏]")
    .replace(Regex("\\bsk-[A-Za-z0-9_-]{8,}"), "[密钥已隐藏]")
    .replace(Regex("[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f]"), "").take(700)

internal fun remoteErrorMessage(error: Throwable, ssh: Boolean = false): String {
    val code = (error as? DeviceApiError)?.code.orEmpty()
    val detail = safeErrorDetail(error.message.orEmpty())
    if(detail.contains("Credential files", true)) return "凭据文件不能作为附件上传。请移除 .env、私钥或其他含密钥的文件后重试。"
    val known = when(code) {
        "unknown_provider" -> "当前电脑未配置所选模型渠道。请在这台电脑的“模型与渠道”中选择或添加渠道；另一台设备的模型配置不会自动适用。"
        "invalid_model" -> "模型 ID 无效。请从当前电脑的渠道目录重新选择，或填写模型服务实际提供的 ID。"
        "invalid_mode", "invalid_approval" -> "执行模式无效，请重新选择模式；若持续出现，请将被控电脑 CLI 与 App 升级到配套版本。"
        "unknown_method" -> "被控电脑不支持这项操作。请升级该电脑上的 KK Code CLI，再断开并重新连接；只更新 App 或网关并不会更新电脑。"
        "login_required", "pairing_denied" -> if(ssh) "SSH 隧道的本地配对已过期。请重新连接这台 SSH 电脑；无需重新登录网关，远端在途任务不会因此取消。" else "登录或设备配对已过期，请重新登录或配对后再试。"
        "host_denied", "origin_denied" -> "设备拒绝了请求来源。请检查连接地址与服务端口是否一致；不要关闭主机或来源校验。"
        "session_missing" -> "这段对话已不存在，请返回会话列表重新选择。"
        "control_required", "control_busy" -> "当前没有这段对话的控制权。请等待另一客户端完成，或由设备所有者明确接管。"
        "session_busy", "turn_busy", "configuration_busy", "workspace_busy", "device_busy" -> "当前任务或配置切换尚未完成。请等待完成，或先停止任务后再操作。"
        "outcome_unknown", "request_expired", "result_expired" -> "上一项操作可能已经执行。请先刷新会话并核对结果，不要重复提交可能修改文件的操作。"
        "invalid_request_time" -> "手机与被控电脑的时间相差过大。请启用自动时间同步后重新连接。"
        "device_offline" -> "被控电脑已离线。请检查电脑网络及 KK Code 远控服务，然后重新连接。"
        "invalid_response" -> "服务返回了无法识别的内容。请检查地址是否指向 KK Code 服务，而不是登录页面、反向代理错误页或模型接口。"
        else -> null
    }
    if(known != null) return known
    if(error.message.orEmpty().any { it in '\u4e00'..'\u9fff' }) return detail
    if(error is UnknownHostException) return "无法解析服务器地址，请检查主机名、DNS 与当前网络。"
    if(error is ConnectException) return if(ssh) "无法连接 SSH 隧道。请检查服务器 SSH 端口与网络，重新连接后会继续同步远端任务。" else "无法连接服务器，请检查地址、端口、防火墙和网络。"
    if(error is SocketTimeoutException) return "连接或响应超时，请检查服务器网络与服务状态后重试。"
    if(error.javaClass.name.contains("UserAuth") || detail.contains("Exhausted available authentication methods", true)) return "SSH 身份验证失败。请检查用户名、密码或私钥；使用加密私钥时还需填写正确口令。"
    if(ssh && Regex("private key|passphrase|decrypt|key format", RegexOption.IGNORE_CASE).containsMatchIn(detail)) return "SSH 私钥无法读取或解密，请检查私钥内容是否完整、格式是否受支持，以及口令是否正确。"
    if(error is java.io.IOException) return if(ssh) "SSH 连接中断。远端在途任务不会因手机断线而取消；可从设备列表重新连接。" else "网络连接中断，请检查网络后重试。"
    val status = (error as? DeviceApiError)?.status
    return when(status) {
        400, 422 -> "操作未被接受（HTTP $status）。请核对当前电脑的工作目录、模型渠道和输入参数。" + if(detail !in listOf("", "Bad Request", "Unprocessable Entity", "HTTP $status")) "\n详细原因：$detail" else ""
        401 -> if(ssh) "SSH 本地配对已过期，请重新连接这台电脑。" else "登录已过期，请重新登录后再试。"
        403 -> "当前账号或目录授权不允许此操作。请联系设备所有者检查权限。"
        404 -> "请求的服务或内容不存在。请检查地址，并确认电脑 CLI、网关和 App 版本配套。"
        409 -> "状态已发生变化，请刷新后重试；若已有任务正在执行，请先核对其结果。"
        429 -> "请求过于频繁，请稍后重试。"
        500 -> "服务内部处理失败（HTTP 500）。请在被控电脑运行 kkcode doctor 检查配置与日志；若是网关请求，请管理员检查网关日志。"
        502, 503, 504 -> "远端服务暂时不可用（HTTP $status）。请检查被控电脑是否在线及中继/SSH 连接是否正常；重试前先核对上一项操作结果。"
        else -> "操作未完成，请检查当前连接与配置后重试。" + if(detail.isNotBlank()) "\n详细原因：$detail" else ""
    }
}
