package cn.kkcode.remote

import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.ext.junit.runners.AndroidJUnit4
import android.app.Application
import android.content.ContentValues
import android.provider.MediaStore
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.*
import org.json.JSONObject
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Opt-in real network tests. No credentials or lab CA are embedded in the APK. */
@RunWith(AndroidJUnit4::class)
class EnterpriseNetworkTest {
    private fun fixture(): JSONObject {
        assumeTrue(InstrumentationRegistry.getArguments().getString("enterprise") == "true")
        val file = java.io.File(InstrumentationRegistry.getInstrumentation().targetContext.filesDir, "enterprise-test.json")
        assumeTrue(file.isFile)
        return JSONObject(file.readText())
    }
    @Test fun relayUsesRealHttpsIdentityAndDeviceRpc() = runBlocking {
        val f = fixture()
        val api = DeviceApi(f.getString("gateway"), f.getString("accessToken"), f.getString("deviceId"))
        assertEquals("KK Code Enterprise Lab", api.call("/api/v1/discovery").getString("organization"))
        assertEquals("KK Code Enterprise Lab", api.call("/api/v1/profile").getString("organization"))
        assertEquals(f.getString("deviceId"), (api.rpc("status") as JSONObject).getJSONObject("device").getString("id"))
        val models = api.rpc("models.discover", JSONObject().put("provider", "lab-openai")) as JSONObject
        assertTrue(models.getJSONArray("models").length() >= 2)
        val sessions = api.rpc("sessions.list") as JSONArray
        assertTrue((0 until sessions.length()).any { sessions.getJSONObject(it).getString("id") == f.getString("sessionId") })
        val snapshot = api.rpc("sessions.get", JSONObject().put("sessionId", f.getString("sessionId"))) as JSONObject
        assertTrue(snapshot.getJSONArray("messages").length() >= 2)
    }
    @Test fun nativeLoginModelSelectionAndConversationSync() = runBlocking {
        val f = fixture()
        val application = ApplicationProvider.getApplicationContext<Application>()
        val loginFile = java.io.File(application.filesDir, "enterprise-login.json")
        val state = RemoteState(application, false)
        try {
            state.gateway = f.getString("gateway")
            withTimeout(90000) { state.login { url -> loginFile.writeText(JSONObject().put("url", url).toString()) }.join() }
            assertEquals("", state.notice)
            assertTrue("Native device login must select the registered computer", state.connected)
            assertEquals("KK Code Enterprise Lab", state.profile.getString("organization"))
            state.chooseDevice(state.devices.first { it.getString("id") == f.getString("deviceId") })
            state.openSession(state.sessions.first { it.getString("id") == f.getString("sessionId") }).join()
            assertEquals("", state.notice)
            state.discoverModels("lab-anthropic").join()
            assertTrue(state.modelOptions.size >= 2)
            state.selectModel("lab-anthropic", "lab-model-a").join()
            assertEquals("lab-model-a", state.model)
            state.selectMode("plan").join()
            assertEquals("plan", (state.rpc("sessions.get", JSONObject().put("sessionId", state.selected)) as JSONObject).getString("modeId"))
            state.selectMode("agent").join()
            val resolver = application.contentResolver
            val document = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, "kkcode-acceptance-${System.nanoTime()}.txt")
                put(MediaStore.Downloads.MIME_TYPE, "text/plain")
                put(MediaStore.Downloads.RELATIVE_PATH, "Download/KKCode-Acceptance")
            }) ?: error("Could not create the isolated Android document fixture")
            try {
                resolver.openOutputStream(document)!!.use { it.write("KKCODE_ANDROID_ATTACHMENT".toByteArray()) }
                state.attach(document).join()
                assertEquals("", state.notice)
                assertEquals(1, state.attachments.size)
                val attached = state.attachments.single().getString("id")
                val listed = state.rpc("attachments.list", JSONObject().put("sessionId", state.selected)) as JSONObject
                assertTrue(listed.getJSONArray("attachments").objects().any { it.optString("id") == attached })
                state.removeAttachment(attached).join()
                assertEquals("", state.notice)
                assertTrue(state.attachments.isEmpty())
            } finally { resolver.delete(document, null, null) }
            state.send("/keys").join()
            assertEquals("", state.sheet)
            assertTrue(state.notice.contains("只在 CLI"))
            state.sheet = ""
            state.send("LAB_ANDROID_NATIVE").join()
            assertEquals("", state.notice)
            withTimeout(30000) { while(state.busy) delay(100) }
            val snapshot = state.rpc("sessions.get", JSONObject().put("sessionId", state.selected)) as JSONObject
            assertTrue(snapshot.getJSONArray("messages").toString().contains("LAB_ANDROID_OK"))
            assertEquals("lab-anthropic", snapshot.getString("providerType"))
            if(f.optString("branchSessionId").isNotBlank()) {
                state.openSession(JSONObject().put("id", f.getString("branchSessionId"))).join()
                state.loadBranches().join()
                assertEquals("", state.notice)
                assertTrue(state.branchSnapshot.getBoolean("clean"))
                val initial = state.branchSnapshot.getString("current")
                val branch = "android-acceptance-${System.nanoTime()}"
                state.changeBranch(branch, true, state.branchSnapshot.getString("stateToken")).join()
                assertTrue(state.notice.startsWith("已创建并切换"))
                assertEquals(branch, state.branchSnapshot.getString("current"))
                state.changeBranch(initial, false, state.branchSnapshot.getString("stateToken")).join()
                assertTrue(state.notice.startsWith("已切换"))
                assertEquals(initial, state.branchSnapshot.getString("current"))
            }
        } finally { state.disconnect(); loginFile.delete() }
    }
    @Test fun sshChecksFingerprintAndPairsTheRealLinuxDevice() = runBlocking {
        val f = fixture()
        val ssh = SshConnection()
        try {
            var fingerprint = ""
            try { ssh.connect(f.getString("sshHost"), 22, "qa", "", null, privateKey = f.getString("sshPrivateKey")); fail("An unconfirmed host key must be rejected") }
            catch(required: HostKeyRequired) { fingerprint = required.fingerprint }
            val expected = f.getJSONArray("sshFingerprints")
            assertTrue("SSH host key must match the independently verified QA VM", (0 until expected.length()).any { expected.getString(it) == fingerprint })
            val api = ssh.connect(f.getString("sshHost"), 22, "qa", "", fingerprint, privateKey = f.getString("sshPrivateKey"))
            val status = api.rpc("status") as JSONObject
            assertTrue(status.getJSONArray("roots").getString(0).startsWith("/home/qa"))
            val folders = api.rpc("folders.list") as JSONObject
            assertEquals("/home/qa", folders.getString("path"))
            try { api.rpc("files.read", JSONObject().put("path", "/home/qa/.ssh/authorized_keys")); fail("Credential files must stay protected") }
            catch(error: DeviceApiError) { assertEquals(403, error.status) }
        } finally { ssh.close() }
    }
}
