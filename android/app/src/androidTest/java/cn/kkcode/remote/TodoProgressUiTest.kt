package cn.kkcode.remote

import android.app.Application
import androidx.compose.runtime.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Rule
import org.junit.Test

class TodoProgressUiTest {
    @get:Rule val compose = createComposeRule()
    @Test fun collapsedTasksExpandAndResetWithDeviceSessionIdentity() {
        val value = JSONObject().put("sessionId", "s").put("revision", 1).put("items", JSONArray().put(JSONObject().put("id", "one").put("content", "核验文件").put("status", "in_progress").put("owner", JSONObject().put("agentId", "worker")).put("dependencies", JSONArray().put("base"))))
        var identity by mutableStateOf("device:s")
        var snapshot by mutableStateOf<JSONObject?>(value)
        compose.setContent { KKCodeTheme(true) { TodoProgressView(snapshot, identity) } }
        compose.onNodeWithText("待办 0/1 · 进行中 1 · 受阻 0").performClick()
        compose.onNodeWithText("任务状态由代理更新；已完成不等于已验证。").assertExists()
        compose.onNodeWithText("负责人：worker · 依赖：base").assertExists()
        compose.runOnIdle { identity = "other-device:s" }
        compose.onNodeWithText("任务状态由代理更新；已完成不等于已验证。").assertDoesNotExist()
        compose.runOnIdle { snapshot = null }
        compose.onNodeWithText("待办 0/1 · 进行中 1 · 受阻 0").assertDoesNotExist()
    }

    @Test fun childOnlyProgressShowsEveryOutcomeWithoutInventingSuccess() {
        fun children(states: List<String>) = states.mapIndexed { i, status -> JSONObject().put("session_id", "child-$i").put("subagent", "worker-$i").put("status", status) }
        var items by mutableStateOf(children(listOf("running", "completed", "error", "cancelled", "unknown")))
        var identity by mutableStateOf("device:s")
        compose.setContent { KKCodeTheme(true) { TodoProgressView(null, identity, items) } }
        compose.onNodeWithText("子代理 1/5 · 进行中 1 · 需关注 2").performClick()
        listOf("worker-0 · 进行中", "worker-1 · 已完成", "worker-2 · 失败", "worker-3 · 已取消", "worker-4 · 待核查").forEach { compose.onNodeWithText(it).assertExists() }
        compose.runOnIdle { identity = "other-device:s" }
        compose.onNodeWithText("worker-0 · 进行中").assertDoesNotExist()
        compose.runOnIdle { items = emptyList() }
        compose.onNodeWithText("子代理 1/5 · 进行中 1 · 需关注 2").assertDoesNotExist()
    }

    @Test fun realConversationRetainsTaskAndLiveChildProgressInEveryMode() {
        val state = RemoteState(ApplicationProvider.getApplicationContext<Application>(), false)
        state.selected = "mode-session"; state.connected = true
        val snapshot = JSONObject().put("sessionId", state.selected).put("revision", 1).put("items", JSONArray().put(JSONObject().put("id", "task").put("content", "核验当前模式").put("status", "in_progress")))
        state.applySnapshot(JSONObject().put("id", state.selected).put("todos", snapshot))
        compose.setContent { KKCodeTheme(true) { KKCodeApp(state) } }
        for(mode in listOf("agent", "auto", "yolo", "plan", "ultra")) {
            compose.runOnIdle {
                state.applySnapshot(JSONObject().put("id", state.selected).put("modeId", mode).put("todos", snapshot).put("subagents", JSONArray()))
                runBlocking { state.handleJournalEvent(JSONObject().put("type", "subagent.delegated").put("sessionId", state.selected).put("payload", JSONObject().put("subSessionId", "child-$mode").put("subagent", "worker-$mode"))) }
            }
            compose.onNodeWithContentDescription("执行模式").assertIsDisplayed()
            compose.onNodeWithContentDescription("权限").assertDoesNotExist()
            compose.onNodeWithText("待办 0/1 · 进行中 1 · 受阻 0 · 子代理 0/1 · 进行中 1 · 需关注 0").assertIsDisplayed()
            compose.runOnIdle {
                runBlocking { state.handleJournalEvent(JSONObject().put("type", "subagent.settled").put("sessionId", state.selected).put("payload", JSONObject().put("subSessionId", "child-$mode").put("subagent", "worker-$mode").put("status", "completed"))) }
            }
            compose.onNodeWithText("待办 0/1 · 进行中 1 · 受阻 0 · 子代理 1/1 · 进行中 0 · 需关注 0").assertIsDisplayed()
        }
        compose.runOnIdle { state.leaveChat() }
        compose.onNodeWithText("待办 0/1 · 进行中 1 · 受阻 0 · 子代理 1/1 · 进行中 0 · 需关注 0").assertDoesNotExist()
    }
}
