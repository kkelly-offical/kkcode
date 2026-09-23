package cn.kkcode.remote

import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.core.app.ApplicationProvider
import androidx.lifecycle.ViewModelStore
import android.app.Application
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
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
            connection.close()
            val app = ApplicationProvider.getApplicationContext<Application>()
            val state = RemoteState(app, false) { SshConnection(f.getString("commandPrefix")) }
            val models = ViewModelStore(); models.put("ssh-recovery", state)
            val oldAutoConnect = state.autoConnect
            try {
                state.preference("autoConnect", true)
                state.fingerprint = f.getString("fingerprint"); state.trustSshKey(f.getString("host"), "22", f.getString("username"))
                state.connectSsh(f.getString("host"), "22", f.getString("username"), "", f.getString("privateKey"), "Native SSH recovery fixture", true, f.getInt("remotePort")).join()
                assertTrue("Native ViewModel connected", state.connected)
                state.cwd = f.getString("workspace"); state.newChat().join()
                val activeId = state.selected
                state.send("SSH_DETACH_SLOW automatic recovery").join()
                withTimeout(10000) { while(!state.busy) delay(50) }
                val expiredClient = state.api!!
                expiredClient.call("/api/v1/auth/logout", JSONObject())
                state.resumeSshConnection(force = true)
                withTimeout(15000) { while(state.api === expiredClient || state.selected != activeId || !state.busy) delay(50) }
                withTimeout(30000) { while(state.busy || state.messages.none { it.text.contains("SSH_BACKGROUND_COMPLETED") }) delay(100) }
                assertEquals(activeId, state.selected)
            } finally {
                state.sshProfiles.find { it.optString("id") == state.selectedSsh }?.let { state.forgetSsh(it).join() }
                state.preference("autoConnect", oldAutoConnect); models.clear()
            }
        } finally { connection.close(); file.delete() }
    }
}
