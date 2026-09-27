package cn.kkcode.remote

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
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
    @Test fun cancelledTurnCanResumeBeforeItsDelayedStartAcknowledgement() = runBlocking {
        val server = MockWebServer()
        val firstAck = java.util.concurrent.CountDownLatch(1)
        val executions = java.util.Collections.synchronizedList(mutableListOf<String>())
        val stops = java.util.concurrent.atomic.AtomicInteger()
        val snapshot = java.util.concurrent.atomic.AtomicReference(JSONObject().put("id", "ses-stop"))
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val body = JSONObject(request.body.readUtf8())
                val params = body.optJSONObject("params") ?: JSONObject()
                val result: Any = when(body.optString("method")) {
                    "sessions.get" -> snapshot.get()
                    "sessions.list" -> JSONArray().put(JSONObject().put("id", "ses-stop").put("title", "停止验收"))
                    "turns.start" -> {
                        val execution = params.getString("executionId"); executions.add(execution)
                        if(executions.size == 1) assertTrue(firstAck.await(20, java.util.concurrent.TimeUnit.SECONDS))
                        JSONObject().put("accepted", true).put("executionId", execution)
                    }
                    "turns.cancel" -> {
                        assertEquals(executions.first(), params.getString("executionId")); stops.incrementAndGet()
                        JSONObject().put("cancelled", true).put("running", true).put("turnState", JSONObject().put("phase", "stopping").put("executionId", executions.first()))
                    }
                    else -> JSONObject().put("yours", true)
                }
                return MockResponse().setHeader("Content-Type", "application/json").setBody(JSONObject().put("result", result).toString())
            }
        }
        server.start()
        val state = RemoteState(ApplicationProvider.getApplicationContext<Application>(), false)
        suspend fun until(read: () -> Boolean) { withTimeout(10000) { while(!read()) delay(10) } }
        var seq = 0
        suspend fun event(type: String, execution: String, payload: JSONObject = JSONObject()) {
            if(type in listOf("turn.cancelled", "turn.result")) {
                val original = executions.first()
                val running = execution != executions.last()
                val history = JSONArray().put(JSONObject().put("id", "partial").put("role", "assistant").put("turnId", "turn-$original").put("step", 1).put("interrupted", true).put("content", JSONArray().put(JSONObject().put("type", "reasoning").put("text", "保留思考")).put(JSONObject().put("type", "text").put("text", "保留正文"))))
                if(type == "turn.result") history.put(JSONObject().put("id", "continued").put("role", "assistant").put("turnId", "turn-$execution").put("content", "继续后的结果"))
                snapshot.set(JSONObject().put("id", "ses-stop").put("messages", history).put("parts", JSONArray().put(JSONObject().put("id", "cancel-part").put("type", "turn-cancelled").put("turnId", "turn-$original"))).put("running", running).apply { if(running) put("turnState", JSONObject().put("executionId", executions.last()).put("phase", "running")) })
            }
            state.handleJournalEvent(JSONObject().put("id", "cancel-event-${++seq}").put("seq", seq).put("type", type).put("turnId", "turn-$execution").put("payload", payload.put("executionId", execution)))
        }
        try {
            state.api = DeviceApi(server.url("/").toString(), "fixture-only", relay = false); state.selected = "ses-stop"; state.draft = "原始提问"
            val first = state.send(state.draft)
            until { executions.size == 1 }
            val original = executions.first()
            event("turn.start", original, JSONObject().put("prompt", "原始提问"))
            assertEquals("", state.draft)
            event("stream.thinking.delta", original, JSONObject().put("text", "保留思考").put("step", 1))
            event("stream.text.delta", original, JSONObject().put("text", "保留正文").put("step", 1))
            state.draft = "未发送的草稿"; state.stop(); state.stop()
            until { stops.get() == 1 && state.stopping }
            assertTrue(state.busy); assertEquals("stopping", state.turnPhase)
            event("turn.cancelled", original)
            assertFalse(state.busy); assertFalse(state.stopping)
            assertTrue(state.messages.any { it.kind == "assistant" && it.text == "保留正文" })
            assertTrue(state.messages.any { it.kind == "cancelled" })
            state.prepareResume(); assertEquals("未发送的草稿", state.draft)
            state.draft = ""; state.prepareResume(); assertTrue(state.draft.contains("先核查已有结果"))
            assertEquals(1, executions.size)
            state.send(state.draft).join()
            assertEquals(2, executions.size)
            val next = executions.last()
            event("turn.start", next)
            event("turn.cancelled", original) // stale finalization cannot clear the new turn
            assertTrue(state.busy)
            event("turn.result", next, JSONObject().put("reply", "继续后的结果"))
            state.draft = "新草稿"
            firstAck.countDown(); first.join()
            assertFalse(state.busy); assertFalse(state.stopping); assertEquals("新草稿", state.draft)
            assertEquals(1, stops.get())
        } finally { firstAck.countDown(); state.disconnect(); server.shutdown() }
    }

    @Test fun rejectedStopRemainsRunningAndCanBeRetried() = runBlocking {
        val server = MockWebServer(); val stops = java.util.concurrent.atomic.AtomicInteger()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val body = JSONObject(request.body.readUtf8())
                if(body.optString("method") == "turns.cancel" && stops.incrementAndGet() == 1) return MockResponse().setResponseCode(409).setBody("{\"error\":{\"code\":\"control_busy\",\"message\":\"Fixture stop rejected\"}}")
                return MockResponse().setHeader("Content-Type", "application/json").setBody("{\"result\":{\"running\":true,\"cancelled\":true,\"turnState\":{\"executionId\":\"test-stop\",\"phase\":\"stopping\"}}}")
            }
        }
        server.start()
        val state = RemoteState(ApplicationProvider.getApplicationContext<Application>(), false)
        try {
            state.api = DeviceApi(server.url("/").toString(), "fixture-only", relay = false); state.selected = "ses-stop"
            state.observeTurnState(JSONObject().put("running", true).put("turnState", JSONObject().put("executionId", "test-stop").put("phase", "running")))
            state.stop()
            withTimeout(10000) { while(!state.notice.contains("停止尚未确认")) delay(10) }
            assertTrue(state.busy); assertFalse(state.stopping)
            state.stop()
            withTimeout(10000) { while(stops.get() < 2) delay(10) }
            assertTrue(state.busy); assertTrue(state.stopping)
        } finally { state.disconnect(); server.shutdown() }
    }

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
