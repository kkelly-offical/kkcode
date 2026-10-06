@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cn.kkcode.remote

import android.app.Application
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentProvider
import android.content.ContentValues
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import android.util.Base64
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.lifecycle.ViewModelStore
import androidx.test.core.app.ApplicationProvider
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import java.io.File
import java.util.concurrent.atomic.AtomicInteger

class AttachmentClipboardUiTest {
    @get:Rule val compose = createComposeRule()
    @Test fun imagePasteUsesPrivateAttachmentUploadAndCanRetryWithoutLosingDraft() {
        val server = MockWebServer()
        val uploads = AtomicInteger()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val body = JSONObject(request.body.readUtf8())
                if(body.optString("method") == "attachments.upload") {
                    val params = body.getJSONObject("params")
                    assertEquals("clipboard", params.getString("sessionId")); assertEquals(AttachmentFixtureProvider.PNG, params.getString("data"))
                    if(uploads.incrementAndGet() == 1) return MockResponse().setResponseCode(422).setBody("{\"error\":{\"code\":\"fixture_busy\",\"message\":\"测试上传暂未完成\"}}")
                    return MockResponse().setBody("{\"result\":{\"id\":\"image-one\",\"name\":\"剪贴板截图.png\",\"mediaType\":\"image/png\",\"size\":68}}")
                }
                return MockResponse().setBody("{\"result\":{}}")
            }
        }
        server.start()
        val app = ApplicationProvider.getApplicationContext<Application>()
        val state = RemoteState(app, false)
        val models = ViewModelStore()
        models.put("state", state); state.api = DeviceApi(server.url("/").toString(), relay = false); state.connected = true; state.selected = "clipboard"; state.draft = "保留这段正文"
        try {
            compose.setContent { KKCodeTheme(true) { KKCodeApp(state) } }
            compose.runOnIdle { app.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newUri(app.contentResolver, "fixture", Uri.parse("content://cn.kkcode.remote.test.attachments/image"))) }
            compose.onNode(hasSetTextAction()).performClick().performKeyInput { keyDown(Key.CtrlLeft); pressKey(Key.V); keyUp(Key.CtrlLeft) }
            compose.waitUntil(10000) { state.failedAttachments.isNotEmpty() }
            compose.onNodeWithText("重试").performClick()
            compose.waitUntil(10000) { state.attachments.size == 1 }
            compose.onNodeWithText("剪贴板截图.png").assertExists()
            compose.onNode(hasSetTextAction()).assertTextContains("保留这段正文")
            compose.runOnIdle { assertEquals(2, uploads.get()); assertEquals(0, state.failedAttachments.size) }
        } finally { models.clear(); server.shutdown() }
    }
}
