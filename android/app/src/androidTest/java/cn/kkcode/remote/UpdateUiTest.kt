package cn.kkcode.remote

import android.app.Application
import android.content.Context
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.ByteArrayInputStream

class UpdateUiTest {
    @get:Rule val compose = createComposeRule()
    private val app = ApplicationProvider.getApplicationContext<Application>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    @After fun cleanup() { scope.cancel(); app.getSharedPreferences("kkcode.updates", Context.MODE_PRIVATE).edit().clear().commit() }
    private fun fresh(source: GitHubUpdateSource): AppUpdater {
        app.getSharedPreferences("kkcode.updates", Context.MODE_PRIVATE).edit().clear().commit()
        return AppUpdater(app, scope, source)
    }
    private fun body(text: String) = object : UpdateBody {
        private val data = text.toByteArray()
        override val length = data.size.toLong()
        override val stream = ByteArrayInputStream(data)
        override fun close() { stream.close() }
    }
    @Test fun updateEntryUsesTheExistingProfileVersionLocationAndDoesNotRequireLogin() {
        val state = RemoteState(app, false); state.sheet = "profile"
        compose.setContent { KKCodeTheme(true) { KKCodeApp(state) } }
        compose.onNodeWithText("KK Code ${BuildConfig.VERSION_NAME} · 检查更新").performScrollTo().performClick()
        compose.onNodeWithText("应用更新").assertIsDisplayed()
        compose.onNodeWithText("检查更新", substring = false).assertExists()
        compose.onNodeWithText("稳定版", substring = false).assertIsDisplayed()
        compose.onNodeWithText("API Key", substring = false).assertDoesNotExist()
        compose.onNodeWithContentDescription("关闭").performClick()
        compose.runOnIdle { assertEquals("", state.sheet) }
    }
    @Test fun networkFailureIsNotReportedAsUpToDateAndHasARetryAction() {
        val updater = fresh(GitHubUpdateSource(transport = UpdateTransport { throw java.io.IOException("offline") }))
        compose.setContent { KKCodeTheme(true) { UpdateSheet(updater) } }
        compose.onNodeWithText("检查更新", substring = false).performClick()
        compose.waitUntil(3000) { updater.phase == UpdatePhase.ERROR }
        compose.onNodeWithText("无法完成更新请求", substring = true).assertExists()
        compose.onNodeWithText("已安装当前渠道的最新兼容版本").assertDoesNotExist()
        compose.onNodeWithText("检查更新", substring = false).assertIsEnabled()
    }
    @Test fun channelsAreSelectableAndNoAndroidArtifactIsReportedHonestly() {
        val updater = fresh(GitHubUpdateSource(transport = UpdateTransport { body("[]") }))
        compose.setContent { KKCodeTheme(false) { UpdateSheet(updater) } }
        if(updater.channel == UpdateChannel.PREVIEW) {
            compose.onNodeWithText("稳定版", substring = false).performClick()
            compose.waitUntil(3000) { updater.phase == UpdatePhase.CURRENT }
        }
        compose.onNodeWithText("预览版", substring = false).performClick()
        compose.waitUntil(3000) { updater.phase == UpdatePhase.CURRENT }
        compose.onNodeWithText("该渠道暂无", substring = true).assertExists()
        compose.onNodeWithText("预览版", substring = false).assertIsSelected()
        compose.onNodeWithText("下载更新").assertDoesNotExist()
        compose.runOnIdle { assertEquals(UpdateChannel.PREVIEW, updater.channel) }
    }
    @Test fun aFailedHashNeverOffersInstallation() {
        val version = "1.0.999"
        val tag = "v$version"
        val name = "kkcode-android-$version.apk"
        val policy = UpdatePolicy()
        val release = JSONObject().put("tag_name", tag).put("draft", false).put("prerelease", false).put("body", "Fixture notes")
            .put("assets", JSONArray().put(JSONObject().put("name", "android-update.json").put("size", 600).put("browser_download_url", policy.assetUrl(tag, "android-update.json")))
                .put(JSONObject().put("name", name).put("size", 3).put("browser_download_url", policy.assetUrl(tag, name))))
        val manifest = JSONObject().put("schemaVersion", 1).put("applicationId", BuildConfig.APPLICATION_ID).put("versionName", version).put("versionCode", 20001).put("minSdk", 29).put("protocolVersion", "1").put("channel", "stable")
            .put("apk", JSONObject().put("name", name).put("size", 3).put("sha256", "0".repeat(64)).put("certificateSha256", BuildConfig.UPDATE_CERT_SHA256))
        val updater = fresh(GitHubUpdateSource(transport = UpdateTransport { url -> body(if(url.contains("api.github.com")) JSONArray().put(release).toString() else if(url.endsWith(".json")) manifest.toString() else "bad") }))
        compose.setContent { KKCodeTheme(true) { UpdateSheet(updater) } }
        compose.onNodeWithText("检查更新", substring = false).performClick()
        compose.waitUntil(3000) { updater.hasUpdate }
        compose.onNodeWithText("下载更新").performClick()
        compose.waitUntil(3000) { updater.phase == UpdatePhase.ERROR }
        compose.onNodeWithText("更新文件校验失败", substring = true).assertExists()
        compose.onNodeWithText("安装更新", substring = false).assertDoesNotExist()
        assertFalse(java.io.File(app.cacheDir, "app-updates/update-20001.part").exists())
    }
}
