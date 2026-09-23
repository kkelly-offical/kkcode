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
        compose.onNodeWithText("管理连接", useUnmergedTree = true).performClick()
        compose.onNodeWithText("SSH 直连").assertIsDisplayed()
        compose.onNodeWithText("主机地址").assertDoesNotExist()
        compose.onNodeWithText("添加网关连接").performClick()
        compose.onNodeWithText("网关地址").assertIsDisplayed()
        compose.onNodeWithText("添加 SSH 连接").assertDoesNotExist()
        compose.onNodeWithText("返回").performClick()
        compose.onNodeWithText("SSH 直连").assertIsDisplayed()
        compose.runOnIdle { assertEquals("connections", state.sheet) }
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
        compose.onNodeWithText("确认操作").assertDoesNotExist()
        compose.onNodeWithText("feature-test").performClick()
        compose.onNodeWithText("确认 Git 操作？").assertIsDisplayed()
        compose.onNodeWithText("确认操作").assertIsDisplayed()
        compose.onNodeWithText("取消").performClick()
        compose.onNodeWithText("确认操作").assertDoesNotExist()
    }

    @Test fun dirtyBranchStateDisablesMutation() {
        show {
            it.selected = "session-fixture"; it.sheet = "branches"
            it.branchSnapshot = JSONObject().put("clean", false).put("current", "main").put("branches", JSONArray().put(JSONObject().put("name", "feature-dirty")))
        }
        compose.onNodeWithText("feature-dirty").assertIsNotEnabled()
        compose.onNodeWithText("创建新分支").assertIsNotEnabled()
    }

    @Test fun eachSessionHasRenameArchiveAndRestoreActions() {
        val session = JSONObject().put("id", "managed-session").put("title", "跨端会话").put("cwd", "/workspace").put("updatedAt", System.currentTimeMillis())
        val state = show { it.connected = true; it.sessions = listOf(session) }
        compose.onNodeWithContentDescription("管理对话 跨端会话").performClick()
        compose.onNodeWithText("改名").assertIsDisplayed()
        compose.onNodeWithText("归档", substring = false).assertIsDisplayed()
        compose.onNodeWithText("删除", substring = false).assertIsDisplayed()
        compose.onNodeWithText("对话名称").assertDoesNotExist()
        compose.onNodeWithText("删除", substring = false).performClick()
        compose.onNodeWithText("确认删除").assertIsDisplayed()
        compose.onNodeWithText("不删除工作区文件", substring = true).assertIsDisplayed()
        compose.onNodeWithText("返回").performClick()
        compose.onNodeWithText("改名").performClick()
        compose.onNodeWithText("对话名称").assertIsDisplayed()
        compose.onNodeWithText("保存名称").assertIsEnabled()
        compose.onNodeWithText("返回").performClick()
        compose.onNodeWithText("关闭").performClick()
        compose.runOnIdle { assertEquals(null, state.managedSession); state.sessions = listOf(JSONObject(session.toString()).put("archived", true)) }
        compose.onNodeWithContentDescription("管理对话 跨端会话").assertDoesNotExist()
        compose.onNodeWithContentDescription("更多").performClick()
        compose.onNodeWithText("已归档对话", substring = false).performClick()
        compose.onNodeWithContentDescription("管理对话 跨端会话").performClick()
        compose.onNodeWithText("恢复", substring = false).assertIsDisplayed()
    }

    @Test fun contextUsageIsCompactAndDetailsOpenOnlyOnTap() {
        show {
            it.selected = "context-session"; it.contextUsage = JSONObject().put("tokens", 8192).put("limit", 32768).put("source", "estimated").put("outputReserved", 4096)
        }
        compose.onNodeWithText("上下文", substring = true).assertIsDisplayed().performClick()
        compose.onNodeWithText("上下文使用情况").assertIsDisplayed()
        compose.onNodeWithText("当前上下文占用，不是累计用量", substring = true).assertIsDisplayed()
        compose.onNodeWithText("知道了").performClick()
        compose.onNodeWithText("上下文使用情况").assertDoesNotExist()
    }

    @Test fun messageRewindExplainsThatFilesRemainAndCancelKeepsHistory() {
        val state = show {
            it.selected = "rewind-session"
            it.messages = listOf(ChatItem("question", "user", "修一下登录页", messageId = "question"), ChatItem("answer", "assistant", "已完成"))
        }
        compose.onNodeWithText("回退", substring = false).performClick()
        compose.onNodeWithText("不会撤销任何文件或 Git 修改。", substring = true).assertIsDisplayed()
        compose.onNodeWithText("确认回退对话").assertIsDisplayed()
        compose.onNodeWithText("取消").performClick()
        compose.runOnIdle { assertEquals(2, state.messages.size); assertEquals(null, state.rewindTarget) }
    }

    @Test fun dirtyWorkspaceStillOffersIsolatedWorktreeCreation() {
        show {
            it.selected = "worktree-session"; it.sheet = "branches"
            it.branchSnapshot = JSONObject().put("clean", false).put("current", "main").put("stateToken", "snapshot").put("suggestedParent", "/workspace")
                .put("branches", JSONArray().put(JSONObject().put("name", "main").put("current", true)))
                .put("remoteBranches", JSONArray().put(JSONObject().put("name", "origin/main")))
        }
        compose.onNodeWithText("Worktree", substring = false).performClick()
        compose.onNodeWithText("Worktree 父目录").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("新文件夹名称").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("创建 Worktree", substring = false).performScrollTo().assertIsNotEnabled()
        compose.onNodeWithText("起点：当前 HEAD").performScrollTo().performClick()
        compose.onNodeWithText("origin/main", substring = false).assertIsDisplayed()
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
