package cn.kkcode.remote

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class RemoteUxTest {
    @Test fun legacyHttpErrorsPreserveTheirRealReasonAndBecomeChinese() {
        val error = deviceResponseError(JSONObject().put("error", "Bad Request").put("code", "unknown_provider").put("message", "Configure this provider before selecting it"), 400)
        assertEquals("unknown_provider", error.code); assertTrue(error.message!!.startsWith("Configure"))
        assertTrue(remoteErrorMessage(error, true).contains("当前电脑"))
        assertTrue(remoteErrorMessage(DeviceApiError("Internal Server Error", 500, "http_500")).contains("kkcode doctor"))
        assertTrue(remoteErrorMessage(DeviceApiError("expired", 401, "login_required"), true).contains("无需重新登录网关"))
    }
    @Test fun diagnosticsDoNotDisplayCredentials() {
        val safe = safeErrorDetail("api_key=fixture-private-value Bearer fixture-token-value")
        assertFalse(safe.contains("fixture-private-value")); assertFalse(safe.contains("fixture-token-value"))
    }
    @Test fun onlyExplicitlyEmptyIdleSessionsAreHidden() {
        assertFalse(sessionHasVisibleContent(JSONObject().put("hasContent", false)))
        assertTrue(sessionHasVisibleContent(JSONObject().put("hasContent", false).put("status", "running")))
        assertTrue(sessionHasVisibleContent(JSONObject()))
        assertTrue(sessionHasVisibleContent(JSONObject().put("hasContent", true)))
    }
    @Test fun processFoldsOnlyAfterCompletionAndKeepsFinalReport() {
        val rows = listOf(ChatItem("u", "user", "question", startedAt = 1000), ChatItem("t", "thinking", "thoughts", startedAt = 1100), ChatItem("c", "assistant", "checking", startedAt = 2000), ChatItem("tool", "tool", "read", startedAt = 3000), ChatItem("a", "assistant", "report", startedAt = 6000))
        assertEquals(rows, collapseCompletedRuns(rows, true))
        val folded = collapseCompletedRuns(rows, false)
        assertEquals(listOf("user", "run-summary", "assistant"), folded.map { it.kind })
        assertEquals(5000L, folded[1].durationMs); assertEquals(listOf("t", "c", "tool"), folded[1].children.map { it.id }); assertEquals("report", folded.last().text)
        val failed = rows + ChatItem("failed", "error", "failed")
        assertEquals(failed, collapseCompletedRuns(failed, false))
    }
    @Test fun thinkingStartIsExpandableBeforeTokensAndDeltaKeepsIdentity() {
        val first = beginStreamThinking(emptyList(), StreamDelta("start", "thinking", "", "turn", 1, 1000), emptySet())
        val delta = appendStreamDelta(first, StreamDelta("delta", "thinking", "streamed thoughts", "turn", 1, 2000), emptySet())
        assertEquals("start", delta.single().id); assertEquals("streamed thoughts", delta.single().text); assertFalse(delta.single().done)
        assertEquals(3000L, finishStreamStep(delta, "turn", 1, 4000).single().durationMs)
    }
    @Test fun browserLinksCannotLaunchLocalFilesOrArbitraryApps() {
        assertEquals("https://example.org/source", browserLink("https://example.org/source"))
        for(value in listOf("javascript:alert(1)", "intent://launch", "file:///etc/passwd", "https://user:pass@example.org/")) assertNull(browserLink(value))
    }
}
