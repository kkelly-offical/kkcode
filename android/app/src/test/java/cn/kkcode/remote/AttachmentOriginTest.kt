package cn.kkcode.remote

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class AttachmentOriginTest {
    @Test fun originRejectsSessionGenerationClientAndDeviceChanges() {
        val client = DeviceApi("http://127.0.0.1:1", device = "device-old")
        val origin = AttachmentOrigin("session-old", 7, client, "device-old")
        assertTrue(origin.matches("session-old", 7, client))
        assertFalse(origin.matches("session-new", 7, client))
        assertFalse(origin.matches("session-old", 8, client))
        assertFalse(origin.matches("session-old", 7, null))
        assertFalse(origin.matches("session-old", 7, DeviceApi("http://127.0.0.1:2", device = "device-old")))
        client.device = "device-new"
        assertFalse(origin.matches("session-old", 7, client))
        assertThrows(CancellationException::class.java) { origin.requireCurrent("session-old", 7, client) }
    }

    @Test fun cleanupRpcStaysOnTheOriginalClientAndDevice() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody("{\"result\":{}}"))
        server.start()
        try {
            val client = DeviceApi(server.url("/").toString().trimEnd('/'), device = "device-old")
            val origin = AttachmentOrigin("session-old", 3, client, "device-old")
            client.device = "device-new"
            origin.rpc("attachments.remove", JSONObject().put("sessionId", "session-old").put("id", "attachment-old"))
            val request = server.takeRequest()
            assertEquals("/api/v1/devices/device-old/rpc", request.path)
            val body = JSONObject(request.body.readUtf8())
            assertEquals("attachments.remove", body.optString("method"))
            assertEquals("session-old", body.optJSONObject("params")?.optString("sessionId"))
        } finally { server.shutdown() }
    }
}
