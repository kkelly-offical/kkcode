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
class SshConnection : Closeable {
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
    suspend fun connect(host: String, port: Int, username: String, password: String, acceptedKey: String?, remotePort: Int = 18271, privateKey: String = ""): DeviceApi = withContext(Dispatchers.IO) {
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
        val session = ssh.startSession(); session.allocateDefaultPTY()
        val command = session.exec("kkcode --web --no-open --port $remotePort")
        val input = command.inputStream.bufferedReader()
        var bootstrap: String? = null
        repeat(30) {
            if (bootstrap == null) {
                val line = input.readLine() ?: throw IllegalStateException("KK Code exited; install a compatible version (recommended ${BuildConfig.VERSION_NAME}) on this computer")
                bootstrap = Regex("bootstrap=([A-Za-z0-9_-]+)").find(line)?.groupValues?.get(1)
            }
        }
        requireNotNull(bootstrap) { "Device service did not provide a pairing token" }
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
