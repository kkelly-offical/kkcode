package cn.kkcode.remote

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class TodoProgressTest {
    private fun snapshot(revision: Int = 1, session: String = "s", states: List<String> = listOf("completed", "in_progress", "in_progress", "blocked", "cancelled")) = JSONObject().put("sessionId", session).put("revision", revision).put("items", JSONArray(states.mapIndexed { i, status -> JSONObject().put("id", "$i").put("content", "Task $i").put("status", status) }))
    @Test fun progressIsAuthoredCountsNotVerifiedOrEstimatedPercentage() {
        assertEquals("待办 1/5 · 进行中 2 · 受阻 1 · 已取消 1", todoProgressSummary(snapshot()))
        assertNull(todoProgressSummary(snapshot(states = emptyList())))
        assertNull(todoProgressSummary(null))
    }
    @Test fun wrongSessionAndOlderResponsesCannotReplaceCurrentSnapshot() {
        val current = snapshot(5)
        listOf(snapshot(4), snapshot(5), snapshot(6, "other"), snapshot(6, states = listOf("verified")), snapshot(6).put("revision", 1.5)).forEach { assertSame(current, acceptTodoSnapshot(current, it, "s")) }
        assertNull(acceptTodoSnapshot(null, snapshot(), "other"))
        assertEquals(0, acceptTodoSnapshot(current, snapshot(6, states = emptyList()), "s")!!.getJSONArray("items").length())
    }
    @Test fun childSnapshotsAreScopedAndUnknownOutcomesAreNotSuccess() {
        val child = JSONObject().put("parent_session_id", "s").put("session_id", "child").put("status", "running").put("result", "private")
        val items = scopedSubagents(listOf(child), "s")
        assertFalse(items.single().has("result"))
        assertTrue(scopedSubagents(listOf(child), "other").isEmpty())
        assertEquals("子代理 0/1 · 进行中 1 · 需关注 0", subagentProgressSummary(items))
        val event = JSONObject().put("type", "subagent.settled").put("sessionId", "s").put("payload", JSONObject().put("subSessionId", "child"))
        assertEquals("子代理 0/1 · 进行中 0 · 需关注 1", subagentProgressSummary(mergeSubagentEvent(items, event, "s")))
        assertEquals("待核查", subagentStatusLabel("unknown"))
    }
}
