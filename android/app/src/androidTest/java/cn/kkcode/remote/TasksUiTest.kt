package cn.kkcode.remote

import androidx.compose.runtime.*
import androidx.compose.material3.Text
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import kotlinx.coroutines.awaitCancellation
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.File
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

class TasksUiTest {
    @get:Rule val compose = createComposeRule()
    private fun status() = JSONObject().put("features", JSONArray().put("runs.v1"))
    private fun task(state: String = "waiting_input", revision: Int = 7, unknown: Int = 0, active: Boolean = false) = JSONObject()
        .put("id", "run-1").put("sessionId", "session").put("objective", "核验示例任务").put("state", state).put("revision", revision).put("ownerEpoch", 3)
        .put("actionCounts", JSONObject().put("prepared", 0).put("unknown", unknown)).put("verification", JSONObject().put("required", 2).put("passed", 1))
        .put("lastTurn", if(active) JSONObject().put("status", "running") else JSONObject.NULL)
        .put("controls", JSONObject().put("canPause", true).put("canCancel", true))
    private fun list(task: JSONObject = task(), next: String? = null) = JSONObject().put("items", JSONArray().put(task)).put("nextCursor", next ?: JSONObject.NULL)
    private fun events() = JSONObject().put("runId", "run-1").put("events", JSONArray().put(JSONObject().put("sequence", 1).put("type", "turn.started"))).put("nextAfter", 1)

    @Test fun unsupportedDoesNotPretendThereAreNoTasks() {
        val lists = AtomicInteger(0)
        compose.setContent { KKCodeTheme(true) { TaskPanel("session", false) { method, _ -> if(method == "runs.list") lists.incrementAndGet(); JSONObject() } } }
        compose.onNodeWithText("当前设备版本不支持委托任务", substring = true).assertExists()
        compose.onNodeWithText("此会话还没有委托任务。").assertDoesNotExist()
        compose.runOnIdle { assertEquals(0, lists.get()) }
    }

    @Test fun pauseRequiresFreshExplicitConfirmationAndSendsObservedCas() {
        val stopped = AtomicInteger(0)
        compose.setContent { KKCodeTheme(true) { TaskPanel("session", false) { method, params -> when(method) {
            "status" -> status(); "runs.list" -> list(); "runs.get" -> task(); "runs.events" -> events()
            "runs.pause" -> { assertTrue(params.getBoolean("confirmed")); assertEquals(7, params.getInt("expectedRevision")); assertEquals(3, params.getInt("expectedOwnerEpoch")); assertEquals("session", params.getString("sessionId")); stopped.incrementAndGet(); task("paused", 8, active = true) }
            else -> error(method)
        } } } }
        compose.onNodeWithText("查看任务").performClick()
        compose.onNodeWithTag("task-status").assertTextContains("等待输入", substring = true)
        compose.onNodeWithText("暂停任务").performClick()
        compose.runOnIdle { assertEquals(0, stopped.get()) }
        compose.onNodeWithText("确认停止").performClick()
        compose.waitUntil { stopped.get() == 1 }
        compose.onNodeWithTag("task-status").assertTextContains("已暂停", substring = true)
        compose.onNodeWithText("仍有操作正在收尾", substring = true).assertExists()
    }

    @Test fun sharedUnknownTaskIsReadOnlyEvenIfServerControlsSayTrue() {
        compose.setContent { KKCodeTheme(false) { TaskPanel("session", true) { method, _ -> when(method) {
            "status" -> status(); "runs.list" -> list(task("outcome_unknown", unknown = 1)); "runs.get" -> task("outcome_unknown", unknown = 1); else -> events()
        } } } }
        compose.onNodeWithText("查看任务").performClick()
        compose.onNodeWithText("存在未知副作用", substring = true).assertExists()
        compose.onNodeWithText("暂停任务").assertDoesNotExist()
        compose.onNodeWithText("取消任务").assertDoesNotExist()
    }

    @Test fun zeroBudgetAndUnknownExposureAreNotFreeUsageOrActualBills() {
        val row = task("outcome_unknown").put("budget", JSONObject().put("budgetUsd", 0).put("spentUsd", 0).put("reservedUsd", 0)
            .put("unknownUsd", 2).put("deadlineAt", 1900000000000L).put("hasUnknown", true))
        compose.setContent { KKCodeTheme(true) { TaskPanel("session", false) { method, _ -> when(method) {
            "status" -> status(); "runs.list" -> list(row); "runs.get" -> row; else -> events()
        } } } }
        compose.onNodeWithText("查看任务").performClick()
        compose.onNodeWithText("额度为零", substring = true).assertExists()
        compose.onNodeWithText("不是实际账单", substring = true).assertExists()
        compose.onNodeWithText("待核查预留 $2.000000", substring = true).assertExists()
    }

    @Test fun explicitLocalFreeQuotaIsFiniteAndUnknownIsNotAnActualTokenBill() {
        val row = task("outcome_unknown").put("budget", JSONObject().put("budgetUsd", 0).put("spentUsd", 0).put("reservedUsd", 0)
            .put("unknownUsd", 0).put("deadlineAt", 1900000000000L).put("hasUnknown", true)
            .put("localFree", JSONObject().put("maxRequests", 5).put("maxTokens", 10000).put("usedRequests", 2).put("reservedTokens", 4000)))
        compose.setContent { KKCodeTheme(true) { TaskPanel("session", false) { method, _ -> when(method) {
            "status" -> status(); "runs.list" -> list(row); "runs.get" -> row
            else -> JSONObject().put("runId", "run-1").put("events", JSONArray().put(JSONObject().put("sequence", 1).put("type", "budget.unknown"))).put("nextAfter", 1)
        } } } }
        compose.onNodeWithText("查看任务").performClick()
        compose.onNodeWithText("本地免费 · 请求名额 2/5 · 累计预留 token 4000/10000").assertExists()
        compose.onNodeWithText("不是实际用量", substring = true).assertExists()
        compose.onNodeWithText("调用结果待核查：本地免费不代表结果已确认", substring = true).assertExists()
        compose.onNodeWithText("#1 · 调用结果待核查").assertExists()
        compose.onNodeWithText("额度为零", substring = true).assertDoesNotExist()
        compose.onNodeWithText("待核查预留 $0.000000", substring = true).assertDoesNotExist()
    }

    @Test fun staleControlShowsChineseErrorWithoutReportingSuccess() {
        compose.setContent { KKCodeTheme(true) { TaskPanel("session", false) { method, _ -> when(method) {
            "status" -> status(); "runs.list" -> list(); "runs.get" -> task(); "runs.events" -> events()
            else -> throw DeviceApiError("任务状态已经变化，请刷新后重新确认。", 409, "run_changed")
        } } } }
        compose.onNodeWithText("查看任务").performClick(); compose.onNodeWithText("取消任务").performClick(); compose.onNodeWithText("确认停止").performClick()
        compose.onNodeWithText("任务状态已经变化", substring = true).assertExists()
        compose.onNodeWithText("停止请求已记录，正在等待执行宿主安全收尾。").assertDoesNotExist()
    }

    @Test fun changingSessionDisposesRequestsAndDoesNotLeakOldResults() {
        var selected by mutableStateOf("session")
        val started = AtomicBoolean(false); val cancelled = AtomicBoolean(false)
        compose.setContent { KKCodeTheme(true) { key(selected) { if(selected == "session") TaskPanel(selected, false) { method, _ ->
            if(method == "status") status() else { started.set(true); try { awaitCancellation() } finally { cancelled.set(true) } }
        } else Text("新的会话") } } }
        compose.waitUntil { started.get() }; compose.runOnIdle { selected = "other" }; compose.waitUntil { cancelled.get() }
        compose.onNodeWithText("新的会话").assertExists(); compose.onNodeWithText("核验示例任务").assertDoesNotExist()
    }

    @Test fun evidenceUsesRunScopedDownloadAndHashVerification() {
        val bytes = "public task output".toByteArray(); val id = "art_00000000-0000-0000-0000-000000000001"
        val hash = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }; var saved: File? = null
        compose.setContent { KKCodeTheme(true) { TaskEvidence("session", "run-1", request = { method, params ->
            assertEquals("session", params.getString("sessionId")); assertEquals("run-1", params.getString("runId"))
            val meta = JSONObject().put("id", id).put("size", bytes.size).put("sha256", hash).put("mime", "text/plain")
            when(method) {
                "runs.artifacts.list" -> JSONObject().put("items", JSONArray().put(meta)).put("nextCursor", JSONObject.NULL)
                "runs.artifacts.download" -> meta.put("offset", 0).put("encoding", "base64").put("data", Base64.getEncoder().encodeToString(bytes)).put("nextCursor", JSONObject.NULL)
                else -> error("Unexpected method: $method")
            }
        }, onVerifiedDownload = { saved = it }) } }
        compose.onNodeWithText("下载证据").performClick(); compose.waitUntil(3000) { saved != null }
        compose.runOnIdle { assertArrayEquals(bytes, saved!!.readBytes()); saved!!.delete() }
    }
}
