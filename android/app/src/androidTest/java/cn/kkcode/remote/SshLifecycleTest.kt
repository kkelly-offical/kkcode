package cn.kkcode.remote

import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Real SSHJ + loopback forwarding + real device/kernel/provider fixture on an
 * explicitly provisioned QA VM. Private fixture is never part of the APK. */
@RunWith(AndroidJUnit4::class)
class SshLifecycleTest {
    @Test fun losingAllAppTransportsDoesNotCancelATurnAndReconnectReplaysItsResult() = runBlocking {
        val file = File(InstrumentationRegistry.getInstrumentation().targetContext.filesDir, "ssh-lifecycle.json")
        require(file.isFile) { "Provision the explicit private SSH acceptance fixture first" }
        val f = JSONObject(file.readText())
        var connection = SshConnection(f.getString("commandPrefix"))
        suspend fun connect(): DeviceApi = connection.connect(f.getString("host"), 22, f.getString("username"), "", f.getString("fingerprint"), remotePort = f.getInt("remotePort"), privateKey = f.getString("privateKey"))
        try {
            var api = connect()
            val created = api.rpc("sessions.create", JSONObject().put("cwd", f.getString("workspace"))) as JSONObject
            val id = created.getString("id")
            api.rpc("control.acquire", JSONObject().put("sessionId", id))
            api.rpc("turns.start", JSONObject().put("sessionId", id).put("prompt", "SSH_DETACH_SLOW native acceptance"))
            delay(1500)
            connection.close() // All App SSH/TCP state is discarded, not a UI-only disconnect.
            delay(1500)
            connection = SshConnection(f.getString("commandPrefix")); api = connect()
            val active = api.rpc("sessions.get", JSONObject().put("sessionId", id)) as JSONObject
            assertTrue("The remote kernel must still be working after reconnect", active.getBoolean("running"))
            assertTrue(active.toString().contains("SSH_DETACH_SLOW"))
            connection.close(); delay(22000) // Finish while no App transport exists.
            connection = SshConnection(f.getString("commandPrefix")); api = connect()
            val finished = api.rpc("sessions.get", JSONObject().put("sessionId", id)) as JSONObject
            assertFalse(finished.getBoolean("running"))
            assertTrue(finished.toString().contains("SSH_BACKGROUND_COMPLETED"))
            assertEquals(136, finished.getJSONObject("context").getInt("tokens"))
        } finally { connection.close(); file.delete() }
    }
}
