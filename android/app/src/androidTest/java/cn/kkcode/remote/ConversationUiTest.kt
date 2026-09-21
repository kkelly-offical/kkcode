package cn.kkcode.remote

import android.app.Application
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import kotlinx.coroutines.runBlocking

@RunWith(AndroidJUnit4::class)
class ConversationUiTest {
    @get:Rule val compose = createComposeRule()
    private fun show(configure: (RemoteState) -> Unit = {}): RemoteState {
        val state = RemoteState(ApplicationProvider.getApplicationContext<Application>(), false)
        configure(state)
        compose.setContent { KKCodeTheme(dark = true) { KKCodeApp(state) } }
        return state
    }

    @Test fun startupHasNoConnectionOrModelForm() {
        val state = show()
        compose.onNodeWithText("你的对话，在这里继续").assertIsDisplayed()
        compose.onNodeWithText("网关地址").assertDoesNotExist()
        compose.onNodeWithText("API Key").assertDoesNotExist()
        compose.onNodeWithText("主机地址").assertDoesNotExist()
        compose.onNodeWithContentDescription("更多").performClick()
        compose.onNodeWithText("设置").performClick()
        compose.onNodeWithText("自动恢复远程连接").assertIsDisplayed()
        compose.onNodeWithText("网关地址").assertDoesNotExist()
        compose.onNodeWithContentDescription("关闭").performClick()
        compose.runOnIdle { assertEquals("", state.sheet) }
    }

    @Test fun connectionFormsAreExplicitAndBackRestoresTheirParent() {
        val state = show()
        compose.onNodeWithText("添加连接", useUnmergedTree = true).performClick()
        compose.onNodeWithText("SSH").assertIsDisplayed()
        compose.onNodeWithText("主机地址").assertDoesNotExist()
        compose.onNodeWithText("Remote 中继").performClick()
        compose.onNodeWithText("网关地址").assertIsDisplayed()
        compose.onNodeWithText("返回").performClick()
        compose.onNodeWithText("SSH").assertIsDisplayed()
        compose.runOnIdle { assertEquals("add", state.sheet) }
    }

    @Test fun providerFormRequiresAnExplicitAddAction() {
        show { it.connected = true; it.sheet = "models" }
        compose.onNodeWithText("API Key").assertDoesNotExist()
        compose.onNodeWithText("添加渠道").performClick()
        compose.onNodeWithText("API Key").assertExists()
        compose.onNodeWithText("返回").performClick()
        compose.onNodeWithText("API Key").assertDoesNotExist()
    }

    @Test fun slashCommandsAndComposerToolsAreContextual() {
        show {
            it.selected = "session-fixture"
            it.commands = listOf(JSONObject().put("name", "plan").put("description", "制定只读计划"))
        }
        compose.onNode(hasSetTextAction()).performTextInput("/pl")
        compose.onNodeWithText("/plan").assertIsDisplayed().performClick()
        compose.onNode(hasSetTextAction()).assertTextContains("/plan ")
        compose.onNodeWithContentDescription("添加与工具").performClick()
        compose.onNodeWithText("模型与渠道").assertIsDisplayed()
        compose.onNodeWithText("相机").assertDoesNotExist()
    }

    @Test fun codeChangesStayCollapsedUntilTapped() {
        val mutation = JSONObject().put("filePath", "/work/main.ts").put("addedLines", 1).put("removedLines", 1)
            .put("structuredPatch", JSONArray().put(JSONObject().put("oldStart", 1).put("oldLineCount", 1).put("newStart", 1).put("newLineCount", 1).put("lines", JSONArray().put(JSONObject().put("type", "remove").put("text", "old_value")).put(JSONObject().put("type", "add").put("text", "new_value")))))
        show {
            it.selected = "session-fixture"
            it.messages = listOf(ChatItem("tool", "tool", "edit", tool = JSONObject().put("tool", "edit").put("status", "completed").put("metadata", JSONObject().put("mutations", JSONArray().put(mutation)))))
        }
        compose.onNodeWithText("+ new_value").assertDoesNotExist()
        compose.onNodeWithText("已编辑 main.ts").performClick()
        compose.onNodeWithText("+ new_value").assertIsDisplayed()
        compose.onNodeWithText("− old_value").assertIsDisplayed()
        compose.onNodeWithText("已编辑 main.ts").performClick()
        compose.onNodeWithText("+ new_value").assertDoesNotExist()
    }

    @Test fun questionsSubmitActualIdsAndOptionValues() {
        var answer: JSONObject? = null
        val request = JSONObject().put("questions", JSONArray().put(JSONObject().put("id", "choice").put("text", "继续测试？").put("options", JSONArray().put(JSONObject().put("label", "继续").put("value", "continue")))))
        compose.setContent { MaterialTheme(colorScheme = darkColorScheme()) { QuestionForm("approval", request) { answer = it } } }
        compose.onNodeWithText("提交回答").assertIsNotEnabled()
        compose.onNodeWithText("继续").performClick()
        compose.onNodeWithText("提交回答").performClick()
        compose.runOnIdle { assertEquals("continue", answer?.getString("choice")); assertEquals(false, answer?.has("answer")) }
    }

    @Test fun readOnlySharingHidesOwnerActionsAndDisablesSending() {
        show { it.selected = "shared-session"; it.sharedDevice = true }
        compose.onNodeWithText("只读共享会话").assertIsDisplayed()
        compose.onNodeWithContentDescription("发送").assertIsNotEnabled()
        compose.onNodeWithContentDescription("添加与工具").assertDoesNotExist()
    }

    @Test fun attachmentAndBranchActionsAreRealContextualEntries() {
        show { it.selected = "session-fixture" }
        compose.onNodeWithContentDescription("添加与工具").performClick()
        compose.onNodeWithText("文件或图片").assertIsDisplayed()
        compose.onNodeWithText("Git 分支").assertIsDisplayed()
        compose.onNodeWithText("相机").assertDoesNotExist()
    }

    @Test fun branchChangeRequiresAnExplicitSecondConfirmation() {
        show {
            it.selected = "session-fixture"; it.sheet = "branches"
            it.branchSnapshot = JSONObject().put("clean", true).put("current", "main").put("stateToken", "test-state")
                .put("branches", JSONArray().put(JSONObject().put("name", "feature-test").put("current", false).put("checkedOut", false)))
        }
        compose.onNodeWithText("确认切换").assertDoesNotExist()
        compose.onNodeWithText("feature-test").performClick()
        compose.onNodeWithText("切换分支？").assertIsDisplayed()
        compose.onNodeWithText("确认切换").assertIsDisplayed()
        compose.onNodeWithText("取消").performClick()
        compose.onNodeWithText("确认切换").assertDoesNotExist()
    }

    @Test fun dirtyBranchStateDisablesMutation() {
        show {
            it.selected = "session-fixture"; it.sheet = "branches"
            it.branchSnapshot = JSONObject().put("clean", false).put("current", "main").put("branches", JSONArray().put(JSONObject().put("name", "feature-dirty")))
        }
        compose.onNodeWithText("feature-dirty").assertIsNotEnabled()
        compose.onNodeWithText("创建新分支").assertIsNotEnabled()
    }

    @Test fun childApprovalShowsTheAgentContext() {
        show {
            it.selected = "parent-session"
            it.approvals = listOf(JSONObject().put("id", "child-approval").put("kind", "permission").put("request", JSONObject().put("tool", "write").put("sourceSessionId", "child-session").put("sourceLabel", "代码审查代理")))
        }
        compose.onNodeWithText("子代理 · 代码审查代理").assertIsDisplayed()
        compose.onNodeWithText("允许本次").assertIsDisplayed()
    }

    @Test fun clientActionsDoNotConfusePreferencesWithSsoIdentity() {
        val state = show { it.selected = "session-fixture"; it.profile = JSONObject().put("name", "Enterprise Identity") }
        compose.runOnIdle { runBlocking { state.handleCommandResult("/profile", JSONObject().put("clientAction", "profile").put("preferences", JSONObject().put("languages", JSONArray().put("Kotlin")))) } }
        compose.onNodeWithText("工作偏好").assertIsDisplayed()
        compose.onNodeWithText("编程语言（逗号分隔）").assertIsDisplayed()
        compose.runOnIdle { assertEquals("Enterprise Identity", state.profile.getString("name")) }
    }

    @Test fun themeSelectionIsPersistedWithoutOpeningAConnectionForm() {
        val state = show { it.sheet = "theme" }
        compose.onNodeWithText("浅色").performClick()
        compose.runOnIdle { assertEquals("light", state.appearance); assertEquals("", state.sheet); state.updateAppearance("dark") }
        compose.onNodeWithText("网关地址").assertDoesNotExist()
    }

    @Test fun longHistoryHasAnExplicitBoundedPagingAction() {
        show { it.selected = "history-session"; it.historyHasMore = true; it.historyBefore = "previous-page"; it.messages = listOf(ChatItem("latest", "user", "最近的消息")) }
        compose.onNodeWithText("加载更早的消息").assertIsDisplayed().assertIsEnabled()
        compose.onNodeWithText("最近的消息").assertIsDisplayed()
    }
}
