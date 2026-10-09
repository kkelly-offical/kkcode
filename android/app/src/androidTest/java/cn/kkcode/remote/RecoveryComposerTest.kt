package cn.kkcode.remote

import android.app.Application
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RecoveryComposerTest {
    @Test fun recoveredSessionKeepsComposerWithoutAttachmentWritesAndManualSwitchClearsIt() = runBlocking {
        val methods = java.util.Collections.synchronizedList(mutableListOf<String>())
        val server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if(request.method == "GET") return MockResponse().setResponseCode(404).setBody("{\"error\":{\"code\":\"not_sse\",\"message\":\"fixture polling\"}}")
                val body = JSONObject(request.body.readUtf8())
                methods += body.optString("method")
                val params = body.optJSONObject("params") ?: JSONObject()
                val result: Any = when(body.optString("method")) {
                    "sessions.get" -> JSONObject().put("id", params.optString("sessionId")).put("messages", JSONArray()).put("parts", JSONArray()).put("eventCursor", 7)
                    "events.list" -> JSONObject().put("events", JSONArray()).put("approvals", JSONArray())
                    "sessions.list" -> JSONArray()
                    else -> JSONObject()
                }
                return MockResponse().setHeader("Content-Type", "application/json").setBody(JSONObject().put("result", result).toString())
            }
        }
        server.start()
        val state = RemoteState(ApplicationProvider.getApplicationContext<Application>(), false)
        try {
            state.api = DeviceApi(server.url("/").toString().trimEnd('/'), "fixture-only", relay = false)
            state.connected = true; state.selectedSsh = "ssh-one"; state.selected = "session-one"
            state.draft = "保留未发送草稿"
            state.attachments = listOf(JSONObject().put("id", "attachment-one").put("name", "fixture.txt"))
            val failed = Uri.parse("content://fixture/failed")
            state.failedAttachments = listOf(failed)

            state.leaveChat(preserveComposer = true)
            state.openSession(JSONObject().put("id", "session-one"), preserveComposer = true).join()

            assertEquals("保留未发送草稿", state.draft)
            assertEquals(listOf("attachment-one"), state.attachments.map { it.optString("id") })
            assertEquals(listOf(failed), state.failedAttachments)
            assertFalse(methods.any { it in listOf("attachments.upload", "attachments.remove") })

            state.openSession(JSONObject().put("id", "session-two")).join()
            assertEquals("", state.draft)
            assertTrue(state.attachments.isEmpty())
            assertTrue(state.failedAttachments.isEmpty())
        } finally { state.disconnect(); server.shutdown() }
    }
}
