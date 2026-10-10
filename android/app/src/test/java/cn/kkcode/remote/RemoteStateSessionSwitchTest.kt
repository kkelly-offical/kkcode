package cn.kkcode.remote

import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class RemoteStateSessionSwitchTest {
    @Before fun setMainDispatcher() { Dispatchers.setMain(StandardTestDispatcher()) }
    @After fun resetMainDispatcher() { Dispatchers.resetMain() }

    @Test fun manualSwitchClearsBeforeSlowSnapshotWithoutLateClearAndRecoveryPreserves() = runTest {
        val snapshotEntered = CountDownLatch(1)
        val releaseSnapshot = CountDownLatch(1)
        val server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path.orEmpty()
                if(path.contains("/events/stream")) return MockResponse().setResponseCode(404).setBody("{\"error\":{\"code\":\"not_sse\",\"message\":\"polling\"}}")
                val body = JSONObject(request.body.readUtf8())
                val params = body.optJSONObject("params") ?: JSONObject()
                val result: Any = when(body.optString("method")) {
                    "sessions.get" -> {
                        val id = params.optString("sessionId")
                        if(id == "slow") {
                            snapshotEntered.countDown()
                            assertTrue(releaseSnapshot.await(10, TimeUnit.SECONDS))
                        }
                        JSONObject().put("id", id).put("messages", JSONArray()).put("parts", JSONArray()).put("eventCursor", 7)
                    }
                    "events.list" -> JSONObject().put("events", JSONArray()).put("approvals", JSONArray())
                    else -> JSONObject()
                }
                return MockResponse().setHeader("Content-Type", "application/json").setBody(JSONObject().put("result", result).toString())
            }
        }
        server.start()
        val state = RemoteState(RemoteStateTestApplication.create(), false, MemoryRemoteStateVault())
        val store = ViewModelStore().apply { put("session-switch", state) }
        try {
            state.api = DeviceApi(server.url("/").toString().trimEnd('/'), relay = false)
            state.selected = "session-old"
            state.draft = "旧会话草稿"
            state.attachments = listOf(JSONObject().put("id", "old-attachment"))

            val switching = state.openSession(JSONObject().put("id", "slow"))
            assertEquals("", state.draft)
            assertTrue(state.attachments.isEmpty())
            runCurrent()
            assertTrue(snapshotEntered.await(5, TimeUnit.SECONDS))
            state.draft = "等待快照时的新输入"
            releaseSnapshot.countDown()
            switching.join()
            assertEquals("slow", state.selected)
            assertEquals("等待快照时的新输入", state.draft)

            state.draft = "自动恢复草稿"
            state.attachments = listOf(JSONObject().put("id", "recovery-attachment"))
            val recovering = state.openSession(JSONObject().put("id", "recovery"), preserveComposer = true)
            assertEquals("自动恢复草稿", state.draft)
            assertEquals(listOf("recovery-attachment"), state.attachments.map { it.optString("id") })
            recovering.join()
            assertEquals("自动恢复草稿", state.draft)
            assertEquals(listOf("recovery-attachment"), state.attachments.map { it.optString("id") })
        } finally {
            releaseSnapshot.countDown()
            store.clear()
            server.shutdown()
        }
    }
}
