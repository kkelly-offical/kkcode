package cn.kkcode.remote

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ExperienceNavigationTest {
    @Test fun projectsUseExactPathInsteadOfDirectoryName() {
        val sessions = listOf(JSONObject().put("id", "a").put("cwd", "/one/app"), JSONObject().put("id", "b").put("cwd", "/two/app"), JSONObject().put("id", "c").put("cwd", "/one/app/nested"))
        assertEquals(listOf("a"), projectSessions(sessions, "/one/app/").map { it.getString("id") })
        assertEquals(3, projectSessions(sessions, "").size)
    }
    @Test fun pathRulesRespectHostPathSemantics() {
        assertEquals(projectPathKey("C:\\Work\\Project\\"), projectPathKey("c:/work/project"))
        assertNotEquals(projectPathKey("/Work/Project"), projectPathKey("/work/project"))
        assertNotEquals(projectPathKey("/work/project "), projectPathKey("/work/project"))
        assertEquals("/", projectPathKey("/"))
    }
    @Test fun historyRevealsOnlyTheContainingCollapsedGroup() {
        val target = ChatItem("answer", "assistant", "answer")
        val collapsed = ChatItem("old", "compacted-history", "", children = listOf(ChatItem("run", "run-summary", "", children = listOf(target))))
        val other = ChatItem("other", "run-summary", "", children = listOf(ChatItem("unrelated", "tool", "")))
        assertEquals(listOf(target, other), revealHistoryPath(listOf(collapsed, other), "answer"))
        assertEquals(listOf(collapsed, other), revealHistoryPath(listOf(collapsed, other), "missing"))
    }
}
