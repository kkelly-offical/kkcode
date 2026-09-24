package cn.kkcode.remote

import android.app.Application
import androidx.compose.runtime.*
import androidx.compose.material3.Text
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.awaitCancellation
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.File
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

class ArtifactsUiTest {
    @get:Rule val compose = createComposeRule()
    private val app = ApplicationProvider.getApplicationContext<Application>()
    private val id = "art_00000000-0000-0000-0000-000000000001"
    private val bytes = "<svg><script>not executed</script></svg>\nfixture".toByteArray()
    private val hash = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private fun metadata(pinned: Boolean = false) = JSONObject().put("id", id).put("size", bytes.size).put("sha256", hash).put("mime", "text/plain")
        .put("retention", JSONObject().put("pinned", pinned).put("referenced", true))
    private fun list(pinned: Boolean = false) = JSONObject().put("items", JSONArray().put(metadata(pinned))).put("nextCursor", JSONObject.NULL)
    private fun page() = JSONObject().put("id", id).put("size", bytes.size).put("sha256", hash).put("offset", 0).put("encoding", "base64")
        .put("data", Base64.getEncoder().encodeToString(bytes)).put("nextCursor", JSONObject.NULL)
    private fun status() = JSONObject().put("features", JSONArray().put("artifacts.v1"))
    @After fun cleanup() { File(app.cacheDir, "artifact-downloads").deleteRecursively() }

    @Test fun unsupportedDeviceShowsExplanationWithoutPretendingTheListIsEmpty() {
        var listed = false
        compose.setContent { KKCodeTheme(true) { ArtifactPanel("session", false, request = { method, _ -> if(method == "artifacts.list") listed = true; JSONObject() }) } }
        compose.onNodeWithText("当前设备版本不支持产物访问", substring = true).assertExists()
        compose.onNodeWithText("此会话暂时没有已归档产物。").assertDoesNotExist()
        compose.runOnIdle { assertFalse(listed) }
    }

    @Test fun previewIsLiteralTextSearchUsesSessionAndPinPruneNeedExplicitActions() {
        var pinned = false
        val pinCalls = AtomicInteger(0); val searches = AtomicInteger(0); val prunes = AtomicInteger(0)
        compose.setContent { KKCodeTheme(false) { ArtifactPanel("session", false, request = { method, params ->
            when(method) {
                "status" -> status()
                "artifacts.list" -> list(pinned)
                "artifacts.read" -> { assertEquals("session", params.getString("sessionId")); page() }
                "artifacts.search" -> { searches.incrementAndGet(); assertEquals("fixture", params.getString("query")); JSONObject().put("id", id).put("sha256", hash).put("matches", JSONArray().put(JSONObject().put("offset", 39))).put("nextCursor", JSONObject.NULL) }
                "artifacts.pin" -> { pinned = params.getBoolean("pinned"); pinCalls.incrementAndGet(); metadata(pinned) }
                "artifacts.prune" -> { assertTrue(params.getBoolean("confirmed")); prunes.incrementAndGet(); JSONObject().put("removed", JSONArray()) }
                else -> error("unexpected $method")
            }
        }) } }
        compose.onNodeWithText("预览").performClick()
        compose.onNodeWithTag("artifact-preview").assertTextContains("<svg><script>not executed</script></svg>", substring = true)
        compose.onNodeWithText("搜索完整文本").performTextInput("fixture")
        compose.onNodeWithText("搜索", substring = false).performClick()
        compose.waitUntil { searches.get() == 1 }
        compose.onNodeWithText("匹配字节位置：39").assertExists()
        compose.onNodeWithText("固定", substring = false).performClick()
        compose.waitUntil { pinCalls.get() == 1 }
        compose.onNodeWithText("取消固定").assertExists()
        compose.onNodeWithText("清理到期产物").performClick()
        compose.runOnIdle { assertEquals(0, prunes.get()) }
        compose.onNodeWithText("确认清理").performClick()
        compose.waitUntil { prunes.get() == 1 }
    }

    @Test fun sharedSessionHasDownloadButNoLifecycleMutations() {
        compose.setContent { KKCodeTheme(true) { ArtifactPanel("session", true, request = { method, _ -> if(method == "status") status() else list() }) } }
        compose.onNodeWithText("共享会话：仅可查看和下载，不能固定或清理。").assertExists()
        compose.onNodeWithText("下载").assertIsEnabled()
        compose.onNodeWithText("固定", substring = false).assertDoesNotExist()
        compose.onNodeWithText("清理到期产物").assertDoesNotExist()
    }

    @Test fun onlyVerifiedDownloadsReachTheUserSaveCallback() {
        var saved: File? = null
        compose.setContent { KKCodeTheme(true) { ArtifactPanel("session", false, request = { method, _ -> when(method) { "status" -> status(); "artifacts.list" -> list(); else -> page() } }, onVerifiedDownload = { file, _ -> saved = file }) } }
        compose.onNodeWithText("下载").performClick()
        compose.waitUntil(3000) { saved != null }
        compose.runOnIdle { assertArrayEquals(bytes, saved!!.readBytes()); assertTrue(saved!!.name.endsWith(".verified")) }
        compose.onNodeWithText("校验通过，请选择保存位置。").assertExists()
    }

    @Test fun disposingTheSheetCancelsAnInFlightDownloadAndClearsItsCache() {
        var show by mutableStateOf(true)
        val started = AtomicBoolean(false); val cancelled = AtomicBoolean(false)
        compose.setContent { KKCodeTheme(true) {
            if(show) ArtifactPanel("session", false, request = { method, _ -> when(method) {
                "status" -> status(); "artifacts.list" -> list()
                else -> { started.set(true); try { awaitCancellation() } finally { cancelled.set(true) } }
            } }) else Text("已切换会话")
        } }
        compose.onNodeWithText("下载").performClick()
        compose.waitUntil(3000) { started.get() }
        compose.runOnIdle { show = false }
        compose.waitUntil(3000) { cancelled.get() && File(app.cacheDir, "artifact-downloads").listFiles()?.isEmpty() != false }
        compose.onNodeWithText("已切换会话").assertIsDisplayed()
    }
}
