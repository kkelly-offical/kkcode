package cn.kkcode.remote

import android.app.Application
import android.graphics.Bitmap
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.lifecycle.ViewModelStore
import androidx.test.core.app.ApplicationProvider
import org.json.JSONObject
import org.json.JSONArray
import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class ExperienceNavigationUiTest {
    @get:Rule val compose = createComposeRule()
    private fun screenshot(name: String) {
        compose.waitForIdle()
        InstrumentationRegistry.getInstrumentation().waitForIdleSync()
        Thread.sleep(250)
        val bitmap = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
        val app = ApplicationProvider.getApplicationContext<Application>()
        File(app.getExternalFilesDir(null), name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test fun workingLayoutPreservesTranscriptAndOneActivityBanner() {
        val state = RemoteState(ApplicationProvider.getApplicationContext<Application>(), false)
        val models = ViewModelStore(); models.put("state", state)
        val previousScale = state.readingScale
        try {
            state.updateReadingScale(1f)
            state.connected = true; state.selected = "visual"; state.deviceName = "工作电脑"; state.model = "fixture-model"; state.cwd = "/workspace/kkcode"
            state.busy = true; state.turnPhase = "running"
            state.contextUsage = JSONObject().put("tokens", 39000).put("limit", 1000000).put("source", "provider-usage")
            state.messages = listOf(ChatItem("q", "user", "把登录模块中的刷新逻辑拆出来，并检查调用方。"), ChatItem("a", "assistant", "已梳理现有接口，接下来拆分刷新逻辑。\n\n| 文件 | 状态 |\n| --- | --- |\n| login.ts | 已读取 |\n| token-store.ts | 正在修改 |"))
            val tasks = JSONObject().put("sessionId", "visual").put("revision", 1).put("items", JSONArray().put(JSONObject().put("id", "read").put("content", "读取项目结构").put("status", "completed")).put(JSONObject().put("id", "edit").put("content", "拆分刷新逻辑").put("activeForm", "正在拆分刷新逻辑").put("status", "in_progress")))
            kotlinx.coroutines.runBlocking { state.handleJournalEvent(JSONObject().put("type", "todo.updated").put("sessionId", "visual").put("payload", JSONObject().put("snapshot", tasks))) }
            compose.setContent { KKCodeTheme(true) { KKCodeApp(state) } }
            compose.onNodeWithText("任务 1/2").assertIsDisplayed()
            val bounds = compose.onNodeWithTag("conversation-list").getUnclippedBoundsInRoot()
            assertTrue(bounds.bottom - bounds.top > 200.dp)
            compose.onNodeWithContentDescription("上下文使用情况：", substring = true).assertIsDisplayed()
            screenshot("112-working.png")
            compose.onNodeWithContentDescription("会话活动").performClick()
            compose.onNodeWithText("正在拆分刷新逻辑").assertIsDisplayed()
            screenshot("112-activity.png")
        } finally { state.updateReadingScale(previousScale); models.clear() }
    }

    @Test fun projectsWithSameNameRemainSeparateAndSelectionDoesNotRewriteSessions() {
        val state = RemoteState(ApplicationProvider.getApplicationContext<Application>(), false)
        val models = ViewModelStore(); models.put("state", state)
        try {
            state.connected = true; state.deviceName = "隔离设备"; state.cwd = "/one/app"
            state.sessions = listOf(JSONObject().put("id", "one").put("title", "第一个项目的对话").put("cwd", "/one/app"), JSONObject().put("id", "two").put("title", "第二个项目的对话").put("cwd", "/two/app"))
            state.sheet = "projects"
            compose.setContent { KKCodeTheme(true) { KKCodeApp(state) } }
            compose.onNodeWithText("/one/app").assertIsDisplayed()
            compose.onNodeWithText("/two/app").performClick()
            compose.runOnIdle { assertEquals("/two/app", state.projectFilter); assertEquals(2, state.sessions.size); assertEquals("/one/app", state.sessions[0].getString("cwd")) }
            compose.onNodeWithText("第二个项目的对话").assertIsDisplayed()
            compose.onNodeWithText("第一个项目的对话").assertDoesNotExist()
        } finally { models.clear() }
    }

    @Test fun historySelectionPausesFollowAndLatestResumesIt() {
        val state = RemoteState(ApplicationProvider.getApplicationContext<Application>(), false)
        val models = ViewModelStore(); models.put("state", state)
        try {
            state.connected = true; state.selected = "history-ui"
            state.messages = (1..50).map { ChatItem("m-$it", "user", "历史消息 $it") }
            compose.setContent { KKCodeTheme(true) { KKCodeApp(state) } }
            compose.waitUntil(5000) { compose.onAllNodesWithText("历史消息 50").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithContentDescription("对话记录").performClick()
            compose.onNode(hasSetTextAction() and hasText("查找对话记录")).performTextInput("历史消息 10")
            compose.onNode(hasText("历史消息 10") and !hasSetTextAction()).performClick()
            compose.onNodeWithText("历史消息 10").assertIsDisplayed()
            compose.runOnIdle { state.messages = state.messages + ChatItem("latest", "user", "刚刚到达的新消息") }
            compose.onNodeWithText("历史消息 10").assertIsDisplayed()
            compose.onNodeWithText("回到最新").performClick()
            compose.onNodeWithText("刚刚到达的新消息").assertIsDisplayed()
        } finally { models.clear() }
    }

    @Test fun settingsHaveClearScopesWithoutDuplicatedConversationTools() {
        val state = RemoteState(ApplicationProvider.getApplicationContext<Application>(), false)
        val models = ViewModelStore(); models.put("state", state)
        val previousScale = state.readingScale
        try {
            state.connected = true; state.sheet = "settings"
            compose.setContent { KKCodeTheme(true) { KKCodeApp(state) } }
            compose.onNodeWithText("外观与阅读").assertIsDisplayed()
            compose.onNodeWithText("设备与连接").assertIsDisplayed()
            compose.onNodeWithText("子代理").assertDoesNotExist()
            compose.onNodeWithText("持久任务与交付记录").assertDoesNotExist()
            compose.onNodeWithText("外观与阅读").performClick()
            compose.onNodeWithText("较大").performScrollTo().performClick()
            compose.runOnIdle { assertEquals(1.1f, state.readingScale, .001f) }
        } finally { state.updateReadingScale(previousScale); models.clear() }
    }
}
