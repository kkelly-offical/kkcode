@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package cn.kkcode.remote

import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.atomic.AtomicInteger

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class RemoteStateRelayLifecycleTest {
    @Before fun setMainDispatcher() { Dispatchers.setMain(StandardTestDispatcher()) }
    @After fun resetMainDispatcher() { Dispatchers.resetMain() }

    @Test fun relayAuthorizationFailureDoesNotInterruptDirectSshJobs() = runTest {
        val server = MockWebServer()
        val deviceLists = AtomicInteger()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path.orEmpty()
                if(path == "/api/v1/devices") {
                    return if(deviceLists.incrementAndGet() == 1) devicesResponse() else MockResponse().setResponseCode(401).setBody("{\"error\":{\"code\":\"login_required\",\"message\":\"expired\"}}")
                }
                if(path == "/api/v1/connections/ssh") return jsonResponse(JSONObject().put("revision", 1).put("items", JSONArray()))
                if(path.contains("/events/stream")) return MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE)
                val body = JSONObject(request.body.readUtf8())
                val result: Any = when(body.optString("method")) {
                    "sessions.get" -> snapshot(body.optJSONObject("params")?.optString("sessionId").orEmpty())
                    "events.list" -> JSONObject().put("events", JSONArray()).put("approvals", JSONArray())
                    "sessions.list" -> JSONArray()
                    else -> JSONObject()
                }
                return rpcResponse(result)
            }
        }
        server.start()
        val state = RemoteState(RemoteStateTestApplication.create(), false, MemoryRemoteStateVault())
        val store = ViewModelStore().apply { put("direct-ssh", state) }
        try {
            val relay = DeviceApi(server.url("/").toString().trimEnd('/'), device = "relay-old", relay = true)
            state.api = relay
            state.loadDevices()
            state.api = DeviceApi(server.url("/").toString().trimEnd('/'), relay = false)
            state.selectedSsh = "ssh-one"
            state.connected = true
            state.openSession(JSONObject().put("id", "ssh-session")).join()
            state.startDeviceEvents()
            assertTrue(state.jobIsActiveForTest("deviceEvents"))
            assertTrue(state.jobIsActiveForTest("polling"))

            advanceTimeBy(10000)
            awaitCondition { deviceLists.get() >= 2 }
            advanceTimeBy(10000)
            awaitCondition { deviceLists.get() >= 3 && state.jobIsActiveForTest("devicePolling") }

            assertTrue(state.connected)
            assertEquals("ssh-one", state.selectedSsh)
            assertFalse(state.manualDisconnectForTest())
            assertTrue(state.jobIsActiveForTest("deviceEvents"))
            assertTrue(state.jobIsActiveForTest("polling"))
            assertEquals("", state.sheet)
            assertEquals("", state.notice)
        } finally { store.clear(); server.shutdown() }
    }

    @Test fun choosingAnotherRelayDeviceRestartsPollingAndSynchronizesState() = runTest {
        val server = MockWebServer()
        val deviceLists = AtomicInteger()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path.orEmpty()
                if(path == "/api/v1/devices") {
                    return when(deviceLists.incrementAndGet()) {
                        1 -> devicesResponse()
                        2 -> MockResponse().setResponseCode(403).setBody("{\"error\":{\"code\":\"forbidden\",\"message\":\"revoked\"}}")
                        else -> devicesResponse(JSONObject().put("id", "relay-new").put("name", "已同步设备").put("online", false).put("permissions", JSONObject().put("session-new", "control")))
                    }
                }
                if(path == "/api/v1/connections/ssh") return jsonResponse(JSONObject().put("revision", 1).put("items", JSONArray()))
                if(path.contains("/events/stream")) return MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE)
                val body = JSONObject(request.body.readUtf8())
                val result: Any = when(body.optString("method")) {
                    "status" -> JSONObject().put("roots", JSONArray().put("/fixture")).put("shared", true)
                    "sessions.list" -> JSONArray()
                    "commands.list" -> JSONArray()
                    else -> JSONObject()
                }
                return rpcResponse(result)
            }
        }
        server.start()
        val state = RemoteState(RemoteStateTestApplication.create(), false, MemoryRemoteStateVault())
        val store = ViewModelStore().apply { put("relay", state) }
        try {
            val relay = DeviceApi(server.url("/").toString().trimEnd('/'), device = "relay-old", relay = true)
            state.api = relay
            state.loadDevices()
            state.connected = true
            advanceTimeBy(10000)
            awaitCondition { !state.connected && !state.jobIsActiveForTest("devicePolling") }
            assertTrue(state.manualDisconnectForTest())
            assertEquals("connections", state.sheet)

            state.chooseDevice(JSONObject().put("id", "relay-new").put("name", "新设备").put("online", true))
            assertTrue(state.connected)
            assertFalse(state.manualDisconnectForTest())
            assertTrue(state.jobIsActiveForTest("devicePolling"))

            advanceTimeBy(10000)
            awaitCondition { state.devices.singleOrNull()?.optString("name") == "已同步设备" }
            assertFalse(state.connected)
            state.selected = "session-new"
            assertTrue(state.canControl)
            assertTrue(state.jobIsActiveForTest("devicePolling"))
        } finally { store.clear(); server.shutdown() }
    }

    private suspend fun TestScope.awaitCondition(condition: () -> Boolean) {
        withContext(Dispatchers.IO) {
            val deadline = System.currentTimeMillis() + 5000
            while(!condition() && System.currentTimeMillis() < deadline) Thread.sleep(10)
        }
        runCurrent()
        assertTrue("Condition was not met within 5 seconds", condition())
    }

    private fun snapshot(id: String) = JSONObject().put("id", id).put("messages", JSONArray()).put("parts", JSONArray()).put("eventCursor", 7)
    private fun rpcResponse(result: Any) = jsonResponse(JSONObject().put("result", result))
    private fun devicesResponse(vararg items: JSONObject) = jsonResponse(JSONObject().put("items", JSONArray().apply { items.forEach { put(it) } }))
    private fun jsonResponse(value: JSONObject) = MockResponse().setHeader("Content-Type", "application/json").setBody(value.toString())
}
