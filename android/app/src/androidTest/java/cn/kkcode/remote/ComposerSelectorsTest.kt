package cn.kkcode.remote

import android.app.Application
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ComposerSelectorsTest {
    @get:Rule val compose = createComposeRule()
    private fun show(configure: (RemoteState) -> Unit = {}): RemoteState {
        val state = RemoteState(ApplicationProvider.getApplicationContext<Application>(), false)
        configure(state)
        compose.setContent { KKCodeTheme(dark = true) { KKCodeApp(state) } }
        return state
    }

    @Test fun composerShowsModePermissionAndModelChips() {
        show { it.selected = "session-fixture"; it.connected = true; it.mode = "agent"; it.approval = "manual"; it.model = "k2-0905" }
        compose.onNodeWithContentDescription("执行模式").assertIsDisplayed()
        compose.onNodeWithContentDescription("权限").assertIsDisplayed()
        compose.onNodeWithContentDescription("模型").assertIsDisplayed()
        compose.onNodeWithText("agent").assertIsDisplayed()
        compose.onNodeWithText("手动审批").assertIsDisplayed()
        compose.onNodeWithText("k2-0905").assertIsDisplayed()
    }

    @Test fun sharedSessionHidesAllComposerSelectors() {
        show { it.selected = "shared-session"; it.sharedDevice = true; it.mode = "agent"; it.approval = "manual"; it.model = "k2" }
        compose.onNodeWithContentDescription("执行模式").assertDoesNotExist()
        compose.onNodeWithContentDescription("权限").assertDoesNotExist()
        compose.onNodeWithContentDescription("模型").assertDoesNotExist()
    }

    @Test fun permissionPickerAppliesSelectionImmediately() {
        val state = show { it.sheet = "approval"; it.approval = "manual" }
        compose.onNodeWithText("完全放行", substring = true).assertIsDisplayed()
        compose.onNodeWithText("只读", substring = true).assertIsDisplayed()
        compose.onNodeWithText("手动审批 · manual").performClick()
        compose.runOnIdle { assertEquals("manual", state.approval); assertEquals("", state.sheet) }
    }

    @Test fun modelPickerListsProvidersWithDiscoverySource() {
        show {
            it.selected = "session-fixture"; it.sheet = "model-picker"; it.provider = "kimi"; it.model = "k2"
            it.settings = JSONObject().put("provider", JSONObject().put("kimi", JSONObject().put("default_model", "k2")).put("default", "kimi").put("model_capabilities", JSONObject().put("k2", JSONObject().put("image", true))))
            it.catalogProvider = "kimi"; it.catalogSource = "network"
            it.modelOptions = listOf(JSONObject().put("id", "k2"), JSONObject().put("id", "k2-turbo").put("capabilities", JSONObject().put("image", true).put("audio", true)).put("capabilitySources", JSONObject().put("image", "heuristic")))
        }
        compose.onNodeWithText("kimi").assertIsDisplayed()
        compose.onNodeWithText("自动发现 · 实时目录").assertIsDisplayed()
        compose.onNodeWithText("k2-turbo").assertIsDisplayed()
        compose.onNodeWithText("图像? · 音频").assertIsDisplayed()
        compose.onNodeWithText("model_capabilities").assertDoesNotExist()
        compose.onNodeWithText("手动输入模型 ID").assertDoesNotExist()
    }

    @Test fun mcpSummaryDistinguishesFailuresFromSuccessfulConnections() {
        val summary = JSONObject().put("type", "mcp.loaded").put("configured", 2).put("connected", 1).put("toolCount", 3).put("failedCount", 1).put("failed", org.json.JSONArray().put(JSONObject().put("name", "docs")))
        assertEquals("MCP 1/2 已连接 · 3 个工具 · 1 项失败（docs）", mcpLoadNotice(summary))
        assertEquals("", mcpLoadNotice(JSONObject().put("type", "mcp.loaded").put("configured", 0)))
    }

    @Test fun modelPickerOffersManualEntryOnlyWhenDiscoveryFails() {
        show {
            it.selected = "session-fixture"; it.sheet = "model-picker"; it.provider = "kimi"
            it.settings = JSONObject().put("provider", JSONObject().put("kimi", JSONObject().put("default_model", "k2")))
            it.catalogProvider = "kimi"; it.catalogError = "HTTP 503"
        }
        compose.onNodeWithText("手动输入模型 ID").assertIsDisplayed()
        compose.onNodeWithText("使用此模型").assertIsNotEnabled()
    }
}
