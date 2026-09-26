package cn.kkcode.remote

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ConfigurationDiagnosticsUiTest {
    @get:Rule val compose = createComposeRule()
    @Test fun permissionWarningIsVisibleUntilTheDeviceReportsARepairedConfiguration() {
        val error = JSONObject().put("source", "用户配置").put("field", "permission.default_policy").put("message", "请手动迁移后重试")
        val settings = mutableStateOf(JSONObject().put("_diagnostics", JSONObject().put("errorCount", 1).put("toolsBlocked", true).put("errors", JSONArray().put(error))))
        compose.setContent { KKCodeTheme(dark = false) { ConfigurationDiagnostics(settings.value) } }
        compose.onNodeWithText("权限配置需要修正，工具执行已暂停").assertIsDisplayed()
        compose.onNodeWithText("用户配置 · permission.default_policy：请手动迁移后重试").assertIsDisplayed()
        compose.runOnIdle { settings.value = JSONObject().put("_diagnostics", JSONObject().put("errorCount", 0).put("warningCount", 0)) }
        compose.onNodeWithText("权限配置需要修正，工具执行已暂停").assertDoesNotExist()
    }
}
