package cn.kkcode.remote

import android.app.Application
import android.content.Intent
import android.net.Uri
import androidx.lifecycle.ViewModelStore
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.*
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/** Lifecycle tests supplement, not replace, the real Chrome + SSO return smoke. */
@RunWith(AndroidJUnit4::class)
class GatewayLoginLifecycleTest {
    private val application get() = ApplicationProvider.getApplicationContext<Application>()
    private suspend fun until(check: () -> Boolean) = withTimeout(20000) { while(!check()) delay(50) }
    private suspend fun fixture(onlineDevice: Boolean = false, block: suspend (MockWebServer, AtomicBoolean, AtomicInteger, () -> JSONObject?) -> Unit) {
        val vault = CredentialVault(application)
        val saved = listOf("gateway", "credentials", PENDING_LOGIN_KEY).associateWith { vault.get(it) }
        val approved = AtomicBoolean(false); val polls = AtomicInteger(); var request: JSONObject? = null
        val server = MockWebServer(); server.start()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(input: RecordedRequest): MockResponse {
                fun json(value: Any, code: Int = 200) = MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(value.toString())
                return when(input.path) {
                    "/api/v1/discovery" -> json(JSONObject().put("gateway", server.url("/").toString().trimEnd('/')).put("authentication", JSONObject().put("nativeLogin", JSONObject()
                        .put("version", 1).put("platform", "android").put("redirectUri", LOGIN_RETURN_URI).put("pkce", "S256"))))
                    "/auth/device" -> {
                        request = JSONObject(input.body.readUtf8())
                        json(JSONObject().put("device_code", "d".repeat(43)).put("user_code", "12345678").put("expires_in", 600).put("interval", 5).put("native_return", true))
                    }
                    "/auth/token" -> {
                        polls.incrementAndGet()
                        val proof = JSONObject(input.body.readUtf8())
                        if(loginChallenge(proof.optString("code_verifier")) != request?.optJSONObject("native")?.optString("code_challenge")) json(JSONObject().put("error", "invalid_grant"), 400)
                        else if(!approved.get()) json(JSONObject().put("error", "authorization_pending"), 400)
                        else json(JSONObject().put("access_token", "fixture-access").put("refresh_token", "fixture-refresh").put("expires_in", 3600)
                            .put("profile", JSONObject().put("name", "Native Login Fixture").put("organization", "Fixture")))
                    }
                    "/api/v1/devices" -> json(JSONArray().also { if(onlineDevice) it.put(JSONObject().put("id", "fixture-computer").put("name", "Computer").put("online", true)) })
                    "/auth/cancel" -> json(JSONObject().put("cancelled", true))
                    else -> json(JSONObject().put("error", "not_found"), 404)
                }
            }
        }
        try {
            saved.keys.forEach { vault.clear(it, durable = true) }
            block(server, approved, polls) { request }
        } finally {
            server.shutdown()
            saved.forEach { (key, value) -> if(value == null) vault.clear(key, durable = true) else vault.put(key, value, durable = true) }
        }
    }
    @Test fun pendingLoginSurvivesViewModelDeathAndResumesWithoutLaunchingBrowserAgain() = runBlocking {
        fixture { server, approved, _, request ->
            val store = ViewModelStore(); val original = RemoteState(application, false); store.put("original", original)
            var launches = 0
            original.gateway = server.url("/").toString().trimEnd('/')
            original.login { launches++ }
            until { launches == 1 }
            val persisted = CredentialVault(application).get(PENDING_LOGIN_KEY)!!
            val pending = PendingGatewayLogin.read(persisted, true)
            assertEquals(request()!!.getJSONObject("native").getString("state"), pending.state)
            withContext(Dispatchers.Main) { store.clear() }
            approved.set(true)
            val restoredStore = ViewModelStore(); val restored = RemoteState(application); restoredStore.put("restored", restored)
            try {
                assertFalse(restored.handleLoginReturn("$LOGIN_RETURN_URI?state=${"x".repeat(43)}"))
                assertTrue(restored.handleLoginReturn("$LOGIN_RETURN_URI?state=${pending.state}"))
                until { restored.profile.optString("name") == "Native Login Fixture" && !restored.loading }
                assertEquals(1, launches); assertEquals("", restored.loginCode)
                assertNull(CredentialVault(application).get(PENDING_LOGIN_KEY))
                assertNotNull(CredentialVault(application).get("credentials"))
                assertFalse(restored.handleLoginReturn("$LOGIN_RETURN_URI?state=${pending.state}"))
            } finally { withContext(Dispatchers.Main) { restoredStore.clear() } }
        }
    }
    @Test fun duplicateLoginAndReturnNeverCreateParallelPollersAndCancelClearsSecrets() = runBlocking {
        fixture { server, _, polls, _ ->
            val store = ViewModelStore(); val state = RemoteState(application, false); store.put("state", state)
            try {
                state.gateway = server.url("/").toString().trimEnd('/')
                val first = state.login { }
                until { state.loginCode.isNotBlank() }
                val pending = PendingGatewayLogin.read(CredentialVault(application).get(PENDING_LOGIN_KEY)!!, true)
                assertSame(first, state.login { fail("Must not open a second browser") })
                repeat(3) { assertTrue(state.handleLoginReturn("$LOGIN_RETURN_URI?state=${pending.state}")) }
                withContext(Dispatchers.Main) { state.cancelLogin() }
                first.join()
                assertEquals(0, polls.get()); assertEquals("", state.loginCode); assertFalse(state.loading)
                assertNull(CredentialVault(application).get(PENDING_LOGIN_KEY))
                assertFalse(state.handleLoginReturn("$LOGIN_RETURN_URI?state=${pending.state}"))
            } finally { withContext(Dispatchers.Main) { store.clear() } }
        }
    }
    @Test fun browserIntentCanResolveOnlyTheDeclaredNativeReturnPath() {
        val valid = Intent(Intent.ACTION_VIEW, Uri.parse("$LOGIN_RETURN_URI?state=${"s".repeat(43)}"))
            .addCategory(Intent.CATEGORY_BROWSABLE).setPackage(application.packageName)
        val resolved = application.packageManager.resolveActivity(valid, 0)
        assertEquals("cn.kkcode.remote.MainActivity", resolved?.activityInfo?.name)
        assertNull(application.packageManager.resolveActivity(Intent(valid).setData(Uri.parse("cn.kkcode.remote://auth/unexpected")), 0))
    }
    @Test fun completedIdentityRestoresWithoutConnectingWhenAutoConnectIsDisabled() = runBlocking {
        val prefs = application.getSharedPreferences("kkcode.ui", 0)
        val previous = prefs.getBoolean("autoConnect", true)
        prefs.edit().putBoolean("autoConnect", false).commit()
        try {
            fixture(onlineDevice = true) { server, _, _, _ ->
                val credentials = JSONObject().put("access_token", "fixture-access").put("refresh_token", "fixture-refresh")
                    .put("expiresAt", System.currentTimeMillis() + 3600000).put("profile", JSONObject().put("name", "Native Login Fixture").put("organization", "Fixture"))
                CredentialVault(application).completeLogin(server.url("/").toString().trimEnd('/'), credentials.toString())
                val store = ViewModelStore(); val state = RemoteState(application); store.put("state", state)
                try {
                    until { state.devices.isNotEmpty() }
                    assertEquals("Native Login Fixture", state.profile.getString("name"))
                    assertEquals("", state.api?.device); assertFalse(state.connected); assertFalse(state.autoConnect)
                    assertEquals("", state.notice)
                    assertEquals("/api/v1/devices", server.takeRequest().path)
                    assertEquals(1, server.requestCount)
                } finally { withContext(Dispatchers.Main) { store.clear() } }
            }
        } finally { prefs.edit().putBoolean("autoConnect", previous).commit() }
    }
}
