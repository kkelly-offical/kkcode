package cn.kkcode.remote

import android.app.Application
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

/** Native client/HTTP contract fixtures; real store and gateway behavior have
 * separate integration suites. No production identity or model is used here. */
@RunWith(AndroidJUnit4::class)
class SessionLifecycleTest {
    @Test fun metadataRewindMediaAndOldReplayUseTheSameSessionContract() = runBlocking {
        val server = MockWebServer()
        val calls = java.util.Collections.synchronizedList(mutableListOf<JSONObject>())
        val metadata = JSONObject().put("id", "ses-test").put("title", "自动名称").put("titleRevision", 0).put("archived", false).put("cwd", "/fixture").put("modeId", "auto")
        var history = JSONArray().put(JSONObject().put("id", "msg1").put("role", "user").put("content", "first?")).put(JSONObject().put("id", "msg2").put("role", "assistant").put("content", "first reply"))
            .put(JSONObject().put("id", "tool-media").put("role", "user").put("synthetic", true).put("content", JSONArray().put(JSONObject().put("type", "tool_result")).put(JSONObject().put("type", "image_preview").put("messageId", "tool-media").put("index", 1).put("mediaType", "image/svg+xml"))))
            .put(JSONObject().put("id", "msg3").put("role", "user").put("content", "second?")).put(JSONObject().put("id", "msg4").put("role", "assistant").put("content", "second reply"))
        var cursor = 5L
        var deleted = false
        fun snapshot() = JSONObject(metadata.toString()).put("messages", history).put("parts", JSONArray()).put("eventCursor", cursor)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val body = JSONObject(request.body.readUtf8()); calls.add(body)
                val params = body.optJSONObject("params") ?: JSONObject()
                val result: Any = when(body.getString("method")) {
                    "control.acquire", "control.release" -> JSONObject().put("yours", true)
                    "sessions.update" -> { if(params.has("title")) metadata.put("title", params.getString("title")).put("titleRevision", metadata.getInt("titleRevision") + 1); if(params.has("archived")) metadata.put("archived", params.getBoolean("archived")); JSONObject(metadata.toString()) }
                    "sessions.list" -> if(deleted) JSONArray() else JSONArray().put(metadata)
                    "sessions.delete" -> { assertTrue(params.getBoolean("confirmed")); deleted = true; JSONObject().put("deleted", true).put("recoverable", true).put("filesChanged", false) }
                    "sessions.get" -> snapshot()
                    "sessions.rewind" -> { history = JSONArray().put(history.get(0)).put(history.get(1)).put(history.get(2)); cursor = 50; JSONObject().put("ok", true).put("prompt", "second?") }
                    "media.preview" -> JSONObject().put("mediaType", "image/png").put("data", "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==")
                    else -> return MockResponse().setResponseCode(400).setBody("{\"error\":\"Unexpected method\"}")
                }
                return MockResponse().setHeader("Content-Type", "application/json").setBody(JSONObject().put("result", result).toString())
            }
        }
        server.start()
        val state = RemoteState(ApplicationProvider.getApplicationContext<Application>(), false)
        try {
            state.api = DeviceApi(server.url("/").toString(), "fixture-only", relay = false); state.selected = "ses-test"; state.applySnapshot(snapshot())
            assertEquals("auto", state.mode)
            assertEquals(listOf("msg1", "msg3"), state.messages.filter { it.kind == "user" }.map { it.messageId })
            assertEquals(1, state.messages.count { it.kind == "media" })
            val image = state.imagePreview(state.messages.first { it.kind == "media" }, state.selected)
            assertEquals("image/png", image.getString("mediaType"))
            state.updateSession(metadata, JSONObject().put("title", "用户命名").put("expectedTitleRevision", 0)).join()
            assertEquals("用户命名", state.sessions.single().getString("title"))
            state.updateSession(metadata, JSONObject().put("archived", true)).join(); assertTrue(state.sessionArchived)
            state.updateSession(metadata, JSONObject().put("archived", false)).join(); assertFalse(state.sessionArchived)
            state.rewindTarget = state.messages.first { it.messageId == "msg3" }; state.rewindConversation().join()
            assertEquals("second?", state.draft); assertEquals(1, state.messages.count { it.kind == "user" }); assertNull(state.rewindTarget)
            val rewind = calls.first { it.optString("method") == "sessions.rewind" }.getJSONObject("params")
            assertTrue(rewind.getBoolean("confirmed")); assertEquals("msg3", rewind.getString("messageId")); assertEquals("msg4", rewind.getString("expectedLastMessageId"))
            state.handleJournalEvent(JSONObject().put("seq", 49).put("id", "stale-tool").put("type", "tool.finish").put("payload", JSONObject().put("tool", "bash").put("invocationId", "stale-tool")))
            assertFalse(state.messages.any { it.id == "stale-tool" })
            val preview = calls.first { it.optString("method") == "media.preview" }.getJSONObject("params")
            assertEquals("ses-test", preview.getString("sessionId")); assertEquals("tool-media", preview.getString("messageId")); assertEquals(1, preview.getInt("index"))
            state.handleJournalEvent(JSONObject().put("seq", 60).put("type", "session.context.updated").put("payload", JSONObject().put("context", JSONObject().put("tokens", 8192).put("limit", 32768).put("source", "estimated"))))
            assertEquals(8192, state.contextUsage.getInt("tokens"))
            state.deleteConversation(metadata).join()
            assertTrue(deleted); assertEquals("", state.selected); assertTrue(state.sessions.isEmpty()); assertEquals(0, state.contextUsage.length())
        } finally { state.disconnect(); server.shutdown() }
    }
}
