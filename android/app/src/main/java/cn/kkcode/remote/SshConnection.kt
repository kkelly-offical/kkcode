package cn.kkcode.remote

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.connection.channel.direct.Parameters
import net.schmizz.sshj.transport.verification.HostKeyVerifier
import net.schmizz.sshj.common.Buffer
import java.security.PublicKey
import java.net.ServerSocket
import java.security.MessageDigest
import android.util.Base64
import java.io.Closeable
import kotlin.concurrent.thread
import java.util.Timer
import kotlin.concurrent.schedule
import java.security.Security
import org.bouncycastle.jce.provider.BouncyCastleProvider
import net.schmizz.sshj.common.SecurityUtils

class HostKeyRequired(val fingerprint: String) : Exception("Confirm SSH host key: $fingerprint")
internal fun sshStartupError(detail: String): String = when {
    detail.contains("scope", ignoreCase = true) -> "SSH 目录范围与电脑上现有远控不一致。请在 SSH 设置中匹配“所有普通目录”或“仅 home”，不必重新登录网关。"
    detail.contains("port", ignoreCase = true) -> "SSH 服务端口与电脑上的 WebUI/远控不一致或已被占用，请核对 SSH 设置中的远端端口。"
    else -> "SSH 后台宿主未能启动，请在电脑安装 KK Code ${BuildConfig.VERSION_NAME} 或更新版本，并在电脑终端检查 kkcode remote status。"
}
class SshConnection internal constructor(private val commandPrefix: String = "kkcode") : Closeable {
    companion object {
        @Synchronized private fun prepareCrypto() {
            val installed = Security.getProvider("BC")
            if(installed !is BouncyCastleProvider) {
                val index = Security.getProviders().indexOf(installed)
                Security.removeProvider("BC")
                // Keep Conscrypt/AndroidKeyStore ahead of BC; only SSHJ explicitly selects it.
                Security.insertProviderAt(BouncyCastleProvider(), if(index >= 0) index + 1 else Security.getProviders().size + 1)
            }
            SecurityUtils.setSecurityProvider("BC")
        }
    }
    private var client: SSHClient? = null
    private var listener: ServerSocket? = null
    suspend fun connect(host: String, port: Int, username: String, password: String, acceptedKey: String?, remotePort: Int = 18271, privateKey: String = "", allFolders: Boolean = false): DeviceApi = withContext(Dispatchers.IO) {
        require(port in 1..65535 && remotePort in 1..65535)
        prepareCrypto()
        close()
        val ssh = SSHClient(); client = ssh
        ssh.connectTimeout = 10000; ssh.timeout = 15000
        val deadline = Timer("kkcode-ssh-connect", true)
        deadline.schedule(30000) { runCatching { ssh.close() } }
        try {
        var observed: String? = null
        ssh.addHostKeyVerifier(object : HostKeyVerifier {
            override fun verify(hostname: String, port: Int, key: PublicKey): Boolean {
                val wire = Buffer.PlainBuffer().putPublicKey(key).compactData
                observed = "SHA256:" + Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(wire), Base64.NO_WRAP or Base64.NO_PADDING)
                return acceptedKey == observed
            }
            override fun findExistingAlgorithms(hostname: String, port: Int): List<String> = emptyList()
        })
        try { ssh.connect(host, port) } catch (error: Exception) { ssh.close(); if (observed != null && acceptedKey != observed) throw HostKeyRequired(observed!!); throw error }
        if (privateKey.isBlank()) ssh.authPassword(username, password)
        else ssh.authPublickey(username, ssh.loadKeys(privateKey, null, net.schmizz.sshj.userauth.password.PasswordUtils.createOneOff(password.toCharArray())))
        ssh.connection.keepAlive.keepAliveInterval = 10
        val session = ssh.startSession()
        val command = session.exec("$commandPrefix ssh-host --json ${if(allFolders) "--all-folders" else "--home-only"} --port $remotePort")
        val input = command.inputStream.bufferedReader()
        fun readHandshakeLine(): String? {
            val line = StringBuilder()
            while(true) {
                val next = input.read()
                if(next < 0) return if(line.isEmpty()) null else line.toString()
                if(next == 10) return line.toString().trimEnd('\r')
                require(line.length < 4096) { "SSH handshake exceeds the supported size" }
                line.append(next.toChar())
            }
        }
        var bootstrap: String? = null
        repeat(30) {
            if (bootstrap == null) {
                val line = readHandshakeLine() ?: run {
                    command.join(2, java.util.concurrent.TimeUnit.SECONDS)
                    val bytes = ByteArray(2048); val count = command.errorStream.read(bytes)
                    throw IllegalStateException(sshStartupError(if(count > 0) String(bytes, 0, count, Charsets.UTF_8) else ""))
                }
                if(line.length <= 4096 && line.startsWith("{")) {
                    val ready = runCatching { org.json.JSONObject(line) }.getOrNull()
                    if(ready != null && ready.optString("lifetime") in listOf("drain-on-disconnect", "foreground-remote") && ready.optInt("port") == remotePort) bootstrap = ready.optString("bootstrap").takeIf { it.matches(Regex("[A-Za-z0-9_-]{32,128}")) }
                }
            }
        }
        requireNotNull(bootstrap) { "Device service did not provide a pairing token" }
        command.close(); session.close()
        val server = ServerSocket(0, 50, java.net.InetAddress.getByName("127.0.0.1")); listener = server
        val forwarder = ssh.newLocalPortForwarder(Parameters("127.0.0.1", server.localPort, "127.0.0.1", remotePort), server)
        thread(isDaemon = true, name = "kkcode-ssh") { runCatching { forwarder.listen() } }
        val api = DeviceApi("http://127.0.0.1:${server.localPort}", relay = false, hostHeader = "127.0.0.1:$remotePort")
        // Host validation is bound to the actual target; forwarding port is local only.
        api.token = api.call("/api/v1/auth/pair", org.json.JSONObject().put("bootstrap", bootstrap).put("native", true)).getString("token")
        api
        } catch(error: Exception) { close(); throw error }
        finally { deadline.cancel() }
    }
    override fun close() { runCatching { listener?.close() }; runCatching { client?.disconnect() }; runCatching { client?.close() }; listener = null; client = null }
}
