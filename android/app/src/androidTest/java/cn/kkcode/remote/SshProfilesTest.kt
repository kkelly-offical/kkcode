package cn.kkcode.remote

import android.app.Application
import androidx.lifecycle.ViewModelStore
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SshProfilesTest {
    @Test fun accountBooksStayIsolatedAndOfflineCacheStillListsDirectConnections() = runBlocking {
        val server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if(request.path == "/api/v1/devices") return MockResponse().setBody("[]")
                if(request.path == "/api/v1/connections/ssh") {
                    val account = request.getHeader("Authorization")!!.removePrefix("Bearer ")
                    val profile = JSONObject().put("id", "ssh-$account").put("name", "Host $account").put("host", "localhost").put("port", 22).put("remotePort", 18271).put("username", account).put("hostKey", "").put("folders", "home")
                    return MockResponse().setBody(JSONObject().put("revision", 1).put("items", JSONArray().put(profile)).toString())
                }
                return MockResponse().setResponseCode(404)
            }
        }
        server.start()
        val models = ViewModelStore()
        fun state(account: String): RemoteState = RemoteState(ApplicationProvider.getApplicationContext<Application>(), false).also {
            models.put(account, it); it.gateway = server.url("/").toString(); it.profile = JSONObject().put("id", account)
            it.api = DeviceApi(it.gateway, account)
        }
        val a = state("account-a")
        val b = state("account-b")
        try {
            a.loadDevices(); b.loadDevices()
            assertEquals("Host account-a", a.sshProfiles.single().getString("name"))
            assertEquals("Host account-b", b.sshProfiles.single().getString("name"))
            assertFalse(a.sshProfiles.single().has("password")); assertFalse(b.sshProfiles.single().has("privateKey"))
            server.shutdown()
            a.loadSshProfiles(); b.loadSshProfiles()
            assertEquals("ssh-account-a", a.sshProfiles.single().getString("id"))
            assertEquals("ssh-account-b", b.sshProfiles.single().getString("id"))
            a.selectedSsh = a.sshProfiles.single().getString("id")
            a.api = DeviceApi(a.gateway, relay = false)
            a.preference("autoConnect", true)
            a.resumeSshConnection()
            withTimeout(3000) { while(a.sheet != "ssh") delay(20) }
            assertEquals("ssh", a.sheet)
            assertTrue(a.notice.contains("网关不会保存"))
            a.disconnect(); a.sheet = ""
            a.resumeSshConnection(force = true); delay(50)
            assertEquals("", a.sheet)
        } finally { models.clear(); runCatching { server.shutdown() } }
    }
}
