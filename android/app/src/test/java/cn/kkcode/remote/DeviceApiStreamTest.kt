package cn.kkcode.remote

import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.launch
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withContext
import kotlinx.coroutines.Dispatchers
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test

class DeviceApiStreamTest {
    @Test fun gatewayRedirectsNeverMoveTheAuthenticatedStreamToAnotherServer() = runBlocking {
        val trap = MockWebServer()
        val gateway = MockWebServer()
        trap.start(); gateway.start()
        try {
            for(status in listOf(307, 308)) {
                gateway.enqueue(MockResponse().setResponseCode(status).setHeader("Location", trap.url("/capture")).setBody("{}"))
                val api = DeviceApi(gateway.url("/").toString().trimEnd('/'), token = "fixture-secret", relay = false)
                val error = assertThrows(DeviceApiError::class.java) { runBlocking { api.streamEvents("s", 0).toList() } }
                assertEquals(status, error.status)
            }
            assertEquals(0, trap.requestCount)
        } finally { gateway.shutdown(); trap.shutdown() }
    }
    @Test fun deviceScopeMcpSummaryUsesEmptySessionAndPreservesPayload() = runBlocking {
        server("event: mcp.loaded\ndata: {\"type\":\"mcp.loaded\",\"configured\":1,\"connected\":1,\"toolCount\":4}\n\n") { web ->
            val api = DeviceApi(web.url("/").toString().trimEnd('/'), relay = false)
            val frame = api.streamEvents("", 0).toList().single()
            assertEquals("mcp.loaded", frame.event)
            assertTrue(frame.data.contains("toolCount"))
            assertEquals("/api/v1/events/stream?sessionId=&after=0", web.takeRequest().path)
        }
    }

    @Test fun cancellationClosesAnUnresponsiveStreamImmediately() = runBlocking {
        val web = MockWebServer()
        web.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        web.start()
        try {
            val api = DeviceApi(web.url("/").toString().trimEnd('/'), relay = false)
            val job = launch { api.streamEvents("", 0).collect {} }
            assertNotNull(withContext(Dispatchers.IO) { web.takeRequest(3, TimeUnit.SECONDS) })
            withTimeout(3000) { job.cancelAndJoin() }
        } finally { web.shutdown() }
    }
    private suspend fun server(body: String, code: Int = 200, contentType: String? = null, block: suspend (MockWebServer) -> Unit) {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(code).setHeader("Content-Type", contentType ?: if(code == 200) "text/event-stream" else "application/json").setBody(body))
        try { server.start(); block(server) } finally { server.shutdown() }
    }

    @Test fun relaySessionStreamFramesAndHeaders() = runBlocking {
        val sse = buildString {
            append("retry: 2000\n")
            append(": keepalive\n\n")
            append("event: connected\ndata: {\"type\":\"connected\",\"running\":true}\n\n")
            append("id: 42\nevent: stream.text.delta\ndata: {\"id\":\"e1\",\"seq\":42,\"type\":\"stream.text.delta\"}\n\n")
        }
        server(sse) { web ->
            val api = DeviceApi(web.url("/").toString().trimEnd('/'), token = "tkn", device = "dev-1", relay = true)
            val frames = api.streamEvents("session-1", 40).toList()
            assertEquals(listOf("connected", "stream.text.delta"), frames.map { it.event })
            assertEquals("", frames[0].id)
            assertEquals("42", frames[1].id)
            assertTrue(frames[1].data.contains("\"seq\":42"))
            val recorded = web.takeRequest()
            assertEquals("/api/v1/devices/dev-1/events/stream?sessionId=session-1&after=40", recorded.path)
            assertEquals("Bearer tkn", recorded.getHeader("Authorization"))
            assertEquals("text/event-stream", recorded.getHeader("Accept"))
        }
    }

    @Test fun directDeviceStreamPath() = runBlocking {
        server("event: session.state\ndata: {\"type\":\"session.state\",\"running\":false}\n\n") { web ->
            val api = DeviceApi(web.url("/").toString().trimEnd('/'), token = "tkn", relay = false)
            val frames = api.streamEvents("s 2", 0).toList()
            assertEquals("session.state", frames.single().event)
            assertEquals("{\"type\":\"session.state\",\"running\":false}", frames.single().data)
            assertEquals("/api/v1/events/stream?sessionId=s+2&after=0", web.takeRequest().path)
        }
    }

    @Test fun httpErrorBeforeStreamRaisesDeviceApiError() = runBlocking {
        server("{\"error\":{\"code\":\"forbidden\",\"message\":\"Device access denied\"}}", code = 403) { web ->
            val api = DeviceApi(web.url("/").toString().trimEnd('/'), token = "bad", device = "dev-1")
            val error = assertThrows(DeviceApiError::class.java) { runBlocking { api.streamEvents("s", 0).toList() } }
            assertEquals(403, error.status)
            assertEquals("forbidden", error.code)
            assertEquals("Device access denied", error.message)
        }
    }

    @Test fun nonSseOkResponseSignalsFallback() = runBlocking {
        server("{\"events\":[]}", contentType = "application/json") { web ->
            val api = DeviceApi(web.url("/").toString().trimEnd('/'), relay = false)
            val error = assertThrows(DeviceApiError::class.java) { runBlocking { api.streamEvents("s", 0).toList() } }
            assertEquals("not_sse", error.code)
        }
    }

    @Test fun errorFieldExtractionToleratesNoiseAndMissingKeys() {
        assertEquals("device_offline", sseErrorField("{\"error\":{\"code\":\"device_offline\",\"message\":\"offline\"}}", "code"))
        assertEquals("offline", sseErrorField("{\"error\":{\"code\":\"device_offline\",\"message\":\"offline\"}}", "message"))
        assertNull(sseErrorField("not json", "code"))
        assertNull(sseErrorField("{\"error\":{\"code\":\"\"}}", "code"))
    }

    @Test fun multiLineDataAndCrlfSurviveTheWire() = runBlocking {
        server("event: connected\r\ndata: {\"type\":\r\ndata: \"connected\"}\r\n\r\n") { web ->
            val api = DeviceApi(web.url("/").toString().trimEnd('/'), relay = false)
            val frame = api.streamEvents("s", 0).toList().single()
            assertEquals("connected", frame.event)
            assertEquals("{\"type\":\n\"connected\"}", frame.data)
        }
    }
}
