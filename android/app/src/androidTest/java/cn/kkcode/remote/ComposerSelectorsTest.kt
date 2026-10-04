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

    @Test fun composerShowsUnifiedModeAndModelWithoutPermissionChip() {
        show { it.selected = "session-fixture"; it.connected = true; it.mode = "agent"; it.approval = "manual"; it.model = "k2-0905" }
        compose.onNodeWithContentDescription("执行模式").assertIsDisplayed()
        compose.onNodeWithContentDescription("权限").assertDoesNotExist()
        compose.onNodeWithContentDescription("模型").assertIsDisplayed()
        compose.onNodeWithText("Agent").assertIsDisplayed()
        compose.onNodeWithText("手动审批").assertDoesNotExist()
        compose.onNodeWithText("k2-0905").assertIsDisplayed()
    }

    @Test fun sharedSessionHidesAllComposerSelectors() {
        show { it.selected = "shared-session"; it.sharedDevice = true; it.mode = "agent"; it.approval = "manual"; it.model = "k2" }
        compose.onNodeWithContentDescription("执行模式").assertDoesNotExist()
        compose.onNodeWithContentDescription("权限").assertDoesNotExist()
        compose.onNodeWithContentDescription("模型").assertDoesNotExist()
    }

    @Test fun legacyPermissionEntryRedirectsToUnifiedMode() {
        val state = show { it.sheet = "approval"; it.approval = "manual" }
        compose.onNodeWithText("手动审批 · manual").assertDoesNotExist()
        compose.onNodeWithText("Auto", substring = false).performClick()
        compose.runOnIdle { assertEquals("auto", state.mode); assertEquals("", state.sheet) }
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
    @Test fun thinkingLevelsFollowCatalogAndKeepXhighDistinctFromMax() {
        val options = org.json.JSONArray()
        listOf("auto" to "自动", "low" to "略思", "medium" to "审思", "high" to "深思", "xhigh" to "精思", "max" to "穷理").forEach { (value, label) ->
            options.put(JSONObject().put("value", value).put("label", label).put("available", true))
        }
        val runtime = JSONObject().put("thinking", JSONObject().put("kind", "levels").put("selected", "xhigh").put("options", options))
            .put("context", JSONObject().put("limit", 262144)).put("output", JSONObject().put("reserved", 65536).put("source", "catalog"))
        show {
            it.selected = "session-fixture"; it.sheet = "model-picker"; it.provider = "fixture"; it.model = "model"
            it.settings = JSONObject().put("provider", JSONObject().put("fixture", JSONObject().put("default_model", "model")))
            it.catalogProvider = "fixture"; it.catalogSource = "network"
            it.modelOptions = listOf(JSONObject().put("id", "model").put("runtime", runtime))
        }
        compose.onNodeWithText("✓ 精思").assertIsDisplayed()
        compose.onNodeWithText("穷理").assertIsDisplayed()
        compose.onNodeWithText("上下文 262144 · 输出预留 65536（接口）").assertIsDisplayed()
    }

    @Test fun defaultModelShowsThinkingControlsBeforeAnExplicitModelSelection() {
        val options = org.json.JSONArray().put(JSONObject().put("value", "auto").put("label", "自动").put("available", true))
            .put(JSONObject().put("value", "high").put("label", "深思").put("available", true))
        val runtime = JSONObject().put("thinking", JSONObject().put("kind", "levels").put("selected", "auto").put("options", options))
        val state = show {
            it.selected = "session-fixture"; it.sheet = "model-picker"; it.provider = "fixture"; it.model = ""
            it.settings = JSONObject().put("provider", JSONObject().put("fixture", JSONObject().put("default_model", "default-model")))
            it.catalogProvider = "fixture"
            it.modelOptions = listOf(JSONObject().put("id", "default-model").put("runtime", runtime))
        }
        compose.onNodeWithText("思考强度").assertIsDisplayed()
        compose.onNodeWithText("深思").assertIsDisplayed()
        compose.runOnIdle { assertEquals("", state.model) }
    }

    @Test fun legacyRemoteExplainsMissingThinkingMetadataInsteadOfHidingTheEntry() {
        show {
            it.selected = "session-fixture"; it.sheet = "model-picker"; it.provider = "fixture"; it.model = "model"
            it.settings = JSONObject().put("provider", JSONObject().put("fixture", JSONObject().put("default_model", "model")))
            it.catalogProvider = "fixture"
            it.modelOptions = listOf(JSONObject().put("id", "model"))
        }
        compose.onNodeWithText("思考强度").assertIsDisplayed()
        compose.onNodeWithText("电脑端未提供思考设置。请确认电脑上的 KK Code / remote 为 1.0.10 或更新版本，然后重新连接。").assertIsDisplayed()
        compose.onNodeWithText("深思").assertDoesNotExist()
    }

}
