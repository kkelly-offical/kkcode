package cn.kkcode.remote

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import kotlinx.coroutines.awaitCancellation
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

class MemoryUiTest {
    @get:Rule val compose = createComposeRule()
    private val id = "mem_00000000-0000-0000-0000-000000000001"
    private fun status() = JSONObject().put("features", JSONArray().put("memory.v1"))
    private fun entry(scope: String = "project", state: String = "candidate", version: Int = 7, text: String = "先运行测试再交付") = JSONObject()
        .put("id", id).put("scope", scope).put("text", text).put("version", version).put("status", state).put("automatic", false).put("evidence", JSONArray())
    private fun list(scope: String = "project", row: JSONObject? = entry(scope)) = JSONObject().put("scope", scope).put("revision", 1).put("entries", JSONArray().apply { if(row != null) put(row) })

    @Test fun sharedViewDoesNotFetchOwnerMemory() {
        val calls = AtomicInteger(0)
        compose.setContent { KKCodeTheme(true) { MemoryPanel("session", true) { _, _ -> calls.incrementAndGet(); JSONObject() } } }
        compose.onNodeWithText("记忆属于设备所有者，共享访客不能读取或修改。").assertIsDisplayed()
        compose.runOnIdle { assertEquals(0, calls.get()) }
    }

    @Test fun personalCandidateRequiresExplicitScopedVersionBoundConfirmation() {
        var confirmed = false; val confirmations = AtomicInteger(0)
        compose.setContent { KKCodeTheme(true) { MemoryPanel("", false) { method, params ->
            when(method) {
                "status" -> status()
                "memory.list" -> list("personal", entry("personal", if(confirmed) "active" else "candidate", if(confirmed) 8 else 7))
                "memory.confirm" -> { assertEquals("personal", params.getString("scope")); assertEquals(id, params.getString("id")); assertEquals(7, params.getInt("expectedVersion")); assertTrue(params.getBoolean("confirmed")); confirmed = true; confirmations.incrementAndGet(); entry("personal", "active", 8) }
                else -> error("unexpected $method")
            }
        } } }
        compose.onNodeWithText("确认启用").performClick()
        compose.onNodeWithText("确认跨项目个人偏好？").assertExists()
        compose.runOnIdle { assertEquals(0, confirmations.get()) }
        compose.onNodeWithText("确认", substring = false).performClick()
        compose.waitUntil { confirmations.get() == 1 }
        compose.onNodeWithText("已启用 · v8").assertExists()
    }

    @Test fun correctionStaysCandidateAndDoesNotReuseThePriorConfirmation() {
        var corrected = false; val corrections = AtomicInteger(0); val confirmations = AtomicInteger(0)
        compose.setContent { KKCodeTheme(false) { MemoryPanel("session", false) { method, params ->
            when(method) {
                "status" -> status()
                "memory.list" -> list(row = entry(state = if(corrected) "candidate" else "active", version = if(corrected) 8 else 7, text = if(corrected) "先运行静态检查" else "先运行测试再交付"))
                "memory.correct" -> { assertEquals(7, params.getInt("expectedVersion")); assertEquals("先运行静态检查", params.getString("text")); assertFalse(params.has("confirmed")); corrected = true; corrections.incrementAndGet(); entry(state = "candidate", version = 8) }
                "memory.confirm" -> { confirmations.incrementAndGet(); JSONObject() }
                else -> error("unexpected $method")
            }
        } } }
        compose.onNodeWithText("修正").performClick()
        compose.onNodeWithText("修正后的内容").performTextClearance()
        compose.onNodeWithText("修正后的内容").performTextInput("先运行静态检查")
        compose.onNodeWithText("确认", substring = false).performClick()
        compose.waitUntil { corrections.get() == 1 }
        compose.onNodeWithText("待确认 · v8").assertExists()
        compose.runOnIdle { assertEquals(0, confirmations.get()) }
    }

    @Test fun disableIsReversibleAndForgetRequiresItsOwnConfirmation() {
        var disabled = false; var forgotten = false
        val forgets = AtomicInteger(0)
        compose.setContent { KKCodeTheme(true) { MemoryPanel("session", false) { method, params ->
            when(method) {
                "status" -> status()
                "memory.list" -> list(row = if(forgotten) null else entry(state = if(disabled) "disabled" else "active", version = if(disabled) 8 else 7))
                "memory.enable" -> { assertFalse(params.getBoolean("enabled")); disabled = true; entry(state = "disabled", version = 8) }
                "memory.forget" -> { assertTrue(params.getBoolean("confirmed")); assertEquals(8, params.getInt("expectedVersion")); forgotten = true; forgets.incrementAndGet(); JSONObject().put("forgotten", true) }
                else -> error("unexpected $method")
            }
        } } }
        compose.onNodeWithText("禁用", substring = false).performClick()
        compose.onNodeWithText("重新启用").assertExists()
        compose.onNodeWithText("遗忘", substring = false).performClick()
        compose.runOnIdle { assertEquals(0, forgets.get()) }
        compose.onNodeWithText("确认遗忘").performClick()
        compose.waitUntil { forgets.get() == 1 }
        compose.onNodeWithText("当前范围暂无记忆。").assertExists()
    }

    @Test fun legacyImportIsNeverAutomaticAndCreatesOnlyCandidates() {
        val imports = AtomicInteger(0)
        compose.setContent { KKCodeTheme(true) { MemoryPanel("session", false) { method, params ->
            when(method) {
                "status" -> status(); "memory.list" -> list(row = null)
                "memory.legacy" -> JSONObject().put("sources", JSONArray().put(JSONObject().put("source", "auto-memory").put("bytes", 42)))
                "memory.import" -> { assertEquals("project", params.getString("scope")); assertEquals("auto-memory", params.getString("source")); assertTrue(params.getBoolean("confirmed")); imports.incrementAndGet(); JSONObject().put("activated", 0) }
                else -> error("unexpected $method")
            }
        } } }
        compose.runOnIdle { assertEquals(0, imports.get()) }
        compose.onNodeWithText("检查旧记忆文件").performClick()
        compose.onNodeWithText("导入 auto-memory", substring = true).performClick()
        compose.onNodeWithText("旧文件 auto-memory 未按账号分区", substring = true).assertExists()
        compose.runOnIdle { assertEquals(0, imports.get()) }
        compose.onNodeWithText("确认", substring = false).performClick()
        compose.waitUntil { imports.get() == 1 }
        compose.onNodeWithText("旧文件已导入为候选，尚未启用。").assertExists()
    }

    @Test fun switchingMemoryScopeCancelsTheOldRequest() {
        val started = AtomicBoolean(false); val cancelled = AtomicBoolean(false)
        compose.setContent { KKCodeTheme(true) { MemoryPanel("session", false) { method, params ->
            if(method == "status") status()
            else if(params.optString("scope") == "project") { started.set(true); try { awaitCancellation() } finally { cancelled.set(true) } }
            else list("personal", null)
        } } }
        compose.waitUntil(3000) { started.get() }
        compose.onNodeWithText("个人偏好", substring = false).performClick()
        compose.waitUntil(3000) { cancelled.get() }
        compose.onNodeWithText("当前范围暂无记忆。").assertExists()
    }
}
