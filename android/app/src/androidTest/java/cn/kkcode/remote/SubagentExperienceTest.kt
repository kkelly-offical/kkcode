package cn.kkcode.remote

import android.app.Application
import android.graphics.Bitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class SubagentExperienceTest {
    @get:Rule val compose = createComposeRule()
    private fun show(): RemoteState {
        val state = RemoteState(ApplicationProvider.getApplicationContext<Application>(), false)
        state.selected = "parent"; state.connected = true; state.deviceName = "开发电脑"; state.model = "k3"; state.mode = "auto"
        compose.setContent { KKCodeTheme(dark = true) { KKCodeApp(state) } }
        return state
    }
    private fun child(revision: Int = 2, status: String = "running") = JSONObject().put("session_id", "child-one").put("parent_session_id", "parent").put("revision", revision)
        .put("subagent", "explore").put("description", "梳理项目结构与调用链").put("status", status).put("model", "k3").put("provider", "团队模型")
        .put("started_at", System.currentTimeMillis() - 18000).put("runtime", JSONObject().put("thinking", "深思").put("output_reserved", 65536).put("context_limit", 1048576))
        .put("activity", JSONObject().put("phase", "tool").put("tool", "read").put("step", 3)).put("context", JSONObject().put("tokens", 39000).put("limit", 1048576).put("percent", 4))
    private fun event(state: RemoteState, child: JSONObject, type: String = "subagent.progress") = compose.runOnIdle {
        runBlocking { state.handleJournalEvent(JSONObject().put("type", type).put("sessionId", "parent").put("payload", JSONObject().put("subSessionId", "child-one").put("child", child))) }
    }
    private fun screenshot(name: String) {
        compose.waitForIdle()
        InstrumentationRegistry.getInstrumentation().waitForIdleSync()
        Thread.sleep(250) // allow the popup surface to reach SurfaceFlinger before capture
        val app = ApplicationProvider.getApplicationContext<Application>()
        val bitmap = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
        File(app.getExternalFilesDir(null), name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
    @Test fun shortcutShowsActualChildDetailsAndLiveUpdatesWithoutUuidDump() {
        val state = show(); event(state, child())
        compose.onNodeWithContentDescription("会话活动").performClick()
        compose.onNodeWithText("子代理", substring = false).performClick()
        compose.onNodeWithText("梳理项目结构与调用链").assertIsDisplayed()
        compose.onNodeWithText("团队模型 / k3").assertIsDisplayed()
        compose.onNodeWithText("思考 · 深思").assertIsDisplayed()
        compose.onNodeWithText("此会话还没有持久任务。").assertDoesNotExist()
        compose.onNodeWithText("child-one").assertDoesNotExist()
        screenshot("111-subagents.png")
        event(state, child(4, "completed"), "subagent.settled")
        event(state, child(3, "running"))
        compose.onNodeWithTag("subagent-panel-summary").assertTextEquals("子代理 1/1 · 进行中 0 · 需关注 0")
        compose.onNodeWithText("停止此子代理").assertDoesNotExist()
    }
    @Test fun headerMenuIsAnAnchoredPopupAndOpensRenameOnlyWhenChosen() {
        val state = show()
        compose.onNodeWithContentDescription("更多").performClick()
        compose.onNode(isPopup()).assertExists()
        compose.onNodeWithText("改名").assertIsDisplayed()
        compose.onNodeWithText("归档对话").assertIsDisplayed()
        compose.onNodeWithText("对话名称").assertDoesNotExist()
        assertEquals("", state.sheet)
        screenshot("111-menu.png")
        compose.onNodeWithText("改名").performClick()
        compose.onNodeWithText("对话名称").assertIsDisplayed()
        compose.onNode(isPopup()).assertDoesNotExist()
    }
    @Test fun buddyFollowsThinkingWaitingApprovalAndStopsWithoutSubmittingText() {
        val state = show()
        compose.runOnIdle { state.busy = true; state.messages = listOf(ChatItem("thought", "thinking", "", done = false)) }
        compose.onNodeWithTag("buddy-thinking", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("正在认真思考").assertIsDisplayed()
        compose.runOnIdle { state.turnPhase = "waiting_children" }
        compose.onNodeWithTag("buddy-waiting", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("等待伙伴的汇报").assertIsDisplayed()
        compose.runOnIdle { state.approvals = listOf(JSONObject().put("id", "approval").put("kind", "permission").put("request", JSONObject().put("tool", "write"))) }
        compose.onNodeWithTag("buddy-approval", useUnmergedTree = true).assertExists()
        compose.runOnIdle { state.stopping = true }
        compose.onNodeWithTag("buddy-stopping", useUnmergedTree = true).assertExists()
        compose.runOnIdle { state.busy = false; state.stopping = false; state.approvals = emptyList(); state.lastTurnOutcome = "cancelled" }
        compose.onNodeWithTag("buddy-stopped", useUnmergedTree = true).assertExists()
        compose.runOnIdle { assertEquals("", state.draft) }
    }
    @Test fun enabledBuddyMotionChangesRenderedFrames() {
        compose.mainClock.autoAdvance = false
        compose.setContent { KKCodeTheme(dark = true) { PixelBuddy(80.dp, "mint", "working", true) } }
        compose.mainClock.advanceTimeByFrame()
        val first = compose.onNodeWithTag("buddy-working").captureToImage().asAndroidBitmap()
        compose.mainClock.advanceTimeBy(240)
        val second = compose.onNodeWithTag("buddy-working").captureToImage().asAndroidBitmap()
        assertFalse("Working pose must animate when enabled", first.sameAs(second))
    }
}
