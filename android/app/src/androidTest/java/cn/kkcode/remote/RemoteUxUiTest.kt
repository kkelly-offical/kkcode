package cn.kkcode.remote

import android.app.Application
import android.content.ContextWrapper
import android.content.Intent
import android.text.Spanned
import android.text.style.ClickableSpan
import android.widget.TextView
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.lifecycle.ViewModelStore
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RemoteUxUiTest {
    @get:Rule val compose = createComposeRule()

    @Test fun responsesFormDiscoversWithoutAModelAndEditingNeverSavesRedactedCredentials() {
        val server = MockWebServer()
        val calls = java.util.Collections.synchronizedList(mutableListOf<JSONObject>())
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val body = JSONObject(request.body.readUtf8()); calls += body
                val result = if(body.optString("method") == "models.discover") JSONObject().put("models", JSONArray().put(JSONObject().put("id", "discovered-responses-model"))) else JSONObject()
                return MockResponse().setHeader("Content-Type", "application/json").setBody(JSONObject().put("result", result).toString())
            }
        }
        server.start()
        val state = RemoteState(ApplicationProvider.getApplicationContext<Application>(), false)
        val models = ViewModelStore(); models.put("state", state)
        state.api = DeviceApi(server.url("/").toString(), relay = false); state.connected = true; state.sheet = "provider"
        try {
            compose.setContent { KKCodeTheme(dark = true) { KKCodeApp(state) } }
            compose.onNodeWithText("OpenAI Responses API").performClick()
            compose.onNode(hasSetTextAction() and hasText("名称")).performTextInput("responses")
            compose.onNode(hasSetTextAction() and hasText("Base URL")).performTextInput("https://responses.example.org/v1")
            compose.onNodeWithText("读取模型列表").performScrollTo().performClick()
            compose.waitUntil(5000) { state.modelOptions.any { it.optString("id") == "discovered-responses-model" } }
            compose.onNodeWithText("保存到电脑").performScrollTo().performClick()
            compose.waitUntil(5000) { state.notice == "渠道已保存并立即生效" }
            val discovery = calls.first { it.optString("method") == "models.discover" }.getJSONObject("params").getJSONObject("connection")
            assertEquals("openai-responses", discovery.getString("type")); assertFalse(discovery.has("model"))
            val saved = calls.first { it.optString("method") == "settings.update" }.getJSONObject("params").getJSONObject("config").getJSONObject("provider").getJSONObject("responses")
            assertEquals("discovered-responses-model", saved.getString("default_model")); assertEquals("openai-responses", saved.getString("type"))
            compose.waitForIdle()
            compose.runOnIdle {
                state.settings = JSONObject().put("provider", JSONObject().put("responses", saved.put("api_key", "[REDACTED]")))
                state.editingProvider = "responses"; state.sheet = "provider"
            }
            assertEquals("", compose.onNode(hasSetTextAction() and hasText("API Key")).fetchSemanticsNode().config[SemanticsProperties.EditableText].text)
            compose.onNodeWithText("读取模型列表").performScrollTo().performClick()
            compose.waitUntil(5000) { calls.count { it.optString("method") == "models.discover" } == 2 }
            assertEquals("responses", calls.last { it.optString("method") == "models.discover" }.getJSONObject("params").getString("provider"))
            compose.onNodeWithText("保存到电脑").performScrollTo().performClick()
            compose.waitUntil(5000) { calls.count { it.optString("method") == "settings.update" } == 2 }
            assertFalse(calls.last { it.optString("method") == "settings.update" }.getJSONObject("params").getJSONObject("config").getJSONObject("provider").getJSONObject("responses").has("api_key"))
        } finally { models.clear(); server.shutdown() }
    }

    @Test fun markdownAndPlainSourcesDispatchBrowserIntentsOnlyAfterClick() {
        val opened = mutableListOf<Intent>()
        val context = object : ContextWrapper(ApplicationProvider.getApplicationContext<Application>()) {
            override fun startActivity(intent: Intent) { opened += intent }
        }
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            val view = TextView(context).apply { setTextIsSelectable(true); tag = sourceMarkdown(context) }
            renderSourceMarkdown(view, "[说明](https://example.org/docs) 和 https://example.org/plain")
            assertTrue(opened.isEmpty())
            val text = view.text as Spanned
            text.getSpans(0, text.length, ClickableSpan::class.java).forEach { it.onClick(view) }
            assertEquals(setOf("https://example.org/docs", "https://example.org/plain"), opened.map { it.dataString }.toSet())
            assertTrue(opened.all { it.action == Intent.ACTION_VIEW && it.hasCategory(Intent.CATEGORY_BROWSABLE) && it.flags and Intent.FLAG_ACTIVITY_NEW_TASK != 0 })
            opened.clear()
            renderSourceMarkdown(view, "[不可执行](javascript:alert(1)) 和 [本地](file:///etc/passwd)")
            val unsafe = view.text as Spanned
            unsafe.getSpans(0, unsafe.length, ClickableSpan::class.java).forEach { it.onClick(view) }
            assertTrue(opened.isEmpty())
        }
    }

    @Test fun emptyDraftsStayHiddenAndCurrentSshChipDoesNotOpenCredentials() {
        val state = RemoteState(ApplicationProvider.getApplicationContext<Application>(), false)
        val models = ViewModelStore(); models.put("state", state)
        state.connected = true; state.selectedSsh = "ssh-test"; state.deviceName = "SSH 测试机"
        state.api = DeviceApi("http://127.0.0.1:1", relay = false)
        state.sshProfiles = listOf(JSONObject().put("id", "ssh-test").put("name", "SSH 测试机"))
        state.devices = listOf(JSONObject().put("id", "relay-test").put("name", "网关测试机").put("online", true))
        state.sessions = listOf(JSONObject().put("id", "empty").put("title", "空草稿").put("hasContent", false), JSONObject().put("id", "real").put("title", "真实对话").put("hasContent", true))
        try {
            compose.setContent { KKCodeTheme(dark = true) { KKCodeApp(state) } }
            compose.onNodeWithText("空草稿").assertDoesNotExist()
            compose.onNodeWithText("真实对话").assertIsDisplayed()
            compose.onNodeWithText("网关测试机 · 网关").assertIsDisplayed()
            compose.onNodeWithText("SSH 测试机 · SSH").assertIsDisplayed().performClick()
            compose.onNodeWithText("主机地址").assertDoesNotExist()
            compose.runOnIdle { assertEquals("", state.sheet); assertEquals("ssh-test", state.selectedSsh) }
        } finally { models.clear() }
    }

    @Test fun thinkingCanExpandBeforeTheFirstTokenAndRemainOpenDuringStreaming() {
        val item = mutableStateOf(ChatItem("thinking", "thinking", "", done = false, startedAt = System.currentTimeMillis()))
        compose.setContent { KKCodeTheme(dark = true) { ActivityRow(item.value) } }
        compose.onNodeWithContentDescription("展开详情").performClick()
        compose.onNodeWithText("模型尚未返回", substring = true).assertIsDisplayed()
        compose.runOnIdle { item.value = item.value.copy(text = "第一段思考") }
        compose.onNodeWithText("第一段思考").assertIsDisplayed()
        compose.runOnIdle { item.value = item.value.copy(text = "第一段思考，第二段流式内容") }
        compose.onNodeWithText("第二段流式内容", substring = true).assertIsDisplayed()
        compose.onNodeWithContentDescription("收起详情").performClick()
        compose.onNodeWithText("第二段流式内容", substring = true).assertDoesNotExist()
    }

    @Test fun openingWaitingThinkingCarriesIntoTheFirstRealStreamRow() {
        val state = RemoteState(ApplicationProvider.getApplicationContext<Application>(), false)
        val models = ViewModelStore(); models.put("state", state)
        state.selected = "waiting-stream"; state.connected = true; state.busy = true
        state.messages = listOf(ChatItem("user", "user", "先检查项目"))
        try {
            compose.setContent { KKCodeTheme(dark = true) { KKCodeApp(state) } }
            compose.onNodeWithContentDescription("展开详情").performClick()
            compose.onNodeWithText("模型尚未返回", substring = true).assertIsDisplayed()
            compose.runOnIdle { state.messages = state.messages + ChatItem("real-stream", "thinking", "首段内容不需要再次点击", done = false, streamed = true) }
            compose.onNodeWithText("首段内容不需要再次点击").assertIsDisplayed()
            compose.runOnIdle { state.messages = state.messages.map { if(it.kind == "thinking") it.copy(done = true) else it } + ChatItem("answer", "assistant", "正在输出正文", done = false, streamed = true) }
            compose.onNodeWithText("模型尚未返回", substring = true).assertDoesNotExist()
        } finally { models.clear() }
    }

    @Test fun completedProcessHasOneSummaryAndCanBeReopened() {
        val item = ChatItem("run", "run-summary", "", durationMs = 5000, children = listOf(ChatItem("tool", "tool", "read", tool = JSONObject().put("tool", "read").put("args", JSONObject().put("path", "/workspace/file.txt")))))
        compose.setContent { KKCodeTheme(dark = true) { RunSummaryRow(item) } }
        compose.onNodeWithText("已浏览 file.txt").assertDoesNotExist()
        compose.onNodeWithText("已运行 5 秒 · 1 次工具调用").performClick()
        compose.onNodeWithText("已浏览 file.txt").assertIsDisplayed()
        compose.onNodeWithContentDescription("收起运行过程").performClick()
        compose.onNodeWithText("已浏览 file.txt").assertDoesNotExist()
    }

    @Test fun switchingDevicesClearsForeignModelSettingsAndNewChatUsesOneValidatedRequest() = runBlocking {
        val server = MockWebServer()
        val calls = java.util.Collections.synchronizedList(mutableListOf<JSONObject>())
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if(request.method != "POST") return MockResponse().setResponseCode(404).setBody("{}")
                val body = JSONObject(request.body.readUtf8()); calls += body
                val result: Any = when(body.optString("method")) {
                    "status" -> JSONObject().put("roots", JSONArray().put("/new-device"))
                    "sessions.list", "commands.list" -> JSONArray()
                    "sessions.create" -> JSONObject().put("id", "new-session").put("cwd", "/new-device").put("modeId", "agent").put("providerType", "new-device-provider").put("model", "new-model")
                    else -> JSONObject()
                }
                return MockResponse().setHeader("Content-Type", "application/json").setBody(JSONObject().put("result", result).toString())
            }
        }
        server.start()
        val state = RemoteState(ApplicationProvider.getApplicationContext<Application>(), false)
        val models = ViewModelStore(); models.put("state", state)
        state.api = DeviceApi(server.url("/").toString(), relay = true)
        state.provider = "foreign-local-vllm"; state.model = "foreign-model"; state.settings = JSONObject().put("old", true); state.catalogError = "stale"
        try {
            state.chooseDevice(JSONObject().put("id", "new-device").put("name", "新电脑"))
            assertEquals("", state.provider); assertEquals("", state.model); assertEquals(0, state.settings.length()); assertEquals("", state.catalogError)
            state.newChat().join()
            assertEquals("new-session", state.selected); assertEquals("new-device-provider", state.provider)
            val create = calls.single { it.optString("method") == "sessions.create" }.getJSONObject("params")
            assertEquals("/new-device", create.getString("cwd")); assertFalse(create.has("provider")); assertFalse(create.has("model"))
            assertFalse(calls.any { it.optString("method") == "sessions.configure" })
        } finally { models.clear(); server.shutdown() }
    }
}
