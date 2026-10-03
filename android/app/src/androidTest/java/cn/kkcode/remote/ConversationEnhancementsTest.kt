package cn.kkcode.remote

import android.app.Application
import android.content.ContextWrapper
import android.content.Intent
import android.text.Spanned
import android.text.style.ClickableSpan
import android.widget.TextView
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.lifecycle.ViewModelStore
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.delay
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.commonmark.ext.gfm.tables.TableCell
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class ConversationEnhancementsTest {
    @get:Rule val compose = createComposeRule()

    @Test fun compactAcknowledgesOnceCanStopAndDoesNotEraseAnEditedDraft() = runBlocking {
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        val calls = java.util.Collections.synchronizedList(mutableListOf<JSONObject>())
        val server = MockWebServer(); var execution = ""
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val body = JSONObject(request.body.readUtf8()); calls += body
                val params = body.optJSONObject("params") ?: JSONObject()
                val result = when(body.optString("method")) {
                    "commands.run" -> { execution = params.getString("executionId"); entered.countDown(); assertTrue(release.await(10, TimeUnit.SECONDS)); JSONObject().put("accepted", true).put("executionId", execution).put("operation", "compact") }
                    "turns.cancel" -> JSONObject().put("cancelled", true).put("running", true).put("turnState", JSONObject().put("executionId", execution).put("phase", "stopping").put("operation", "compact"))
                    "sessions.get" -> JSONObject().put("id", "compact-fixture").put("running", false).put("context", JSONObject().put("tokens", 100000).put("limit", 200000))
                    "sessions.list" -> JSONArray()
                    else -> JSONObject()
                }
                return MockResponse().setHeader("Content-Type", "application/json").setBody(JSONObject().put("result", result).toString())
            }
        }
        server.start()
        val state = RemoteState(ApplicationProvider.getApplicationContext<Application>(), false)
        val models = ViewModelStore(); models.put("state", state)
        state.api = DeviceApi(server.url("/").toString(), relay = false); state.connected = true; state.selected = "compact-fixture"; state.draft = "/compact"
        try {
            compose.setContent { KKCodeTheme(dark = true) { KKCodeApp(state) } }
            val send = state.send("/compact")
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            compose.onNodeWithText("正在提交压缩…").assertIsDisplayed()
            compose.onNodeWithContentDescription("停止").assertIsEnabled()
            state.send("/compact").join()
            assertEquals(1, calls.count { it.optString("method") == "commands.run" })
            release.countDown(); send.join()
            compose.waitUntil(5000) { state.draft.isEmpty() && state.turnPhase == "compacting" }
            compose.runOnIdle { state.draft = "保留我刚写的新要求" }
            state.stop()
            withTimeout(5000) { while(calls.none { it.optString("method") == "turns.cancel" }) delay(20) }
            assertEquals(execution, calls.first { it.optString("method") == "turns.cancel" }.getJSONObject("params").getString("executionId"))
            state.handleJournalEvent(JSONObject().put("id", "cancelled-compact").put("type", "turn.cancelled").put("turnId", execution).put("payload", JSONObject().put("executionId", execution).put("operation", "compact")))
            assertFalse(state.busy); assertEquals("保留我刚写的新要求", state.draft)
            assertEquals(100000, state.contextUsage.getInt("tokens"))
        } finally { release.countDown(); models.clear(); server.shutdown() }
    }

    @Test fun compactFoldsAvailableHistoryAndShowsImmediateArrow() {
        val state = RemoteState(ApplicationProvider.getApplicationContext<Application>(), false)
        val models = ViewModelStore(); models.put("state", state)
        try {
            state.selected = "fold"; state.connected = true
            state.messages = listOf(ChatItem("old", "user", "这是一条旧提问"), ChatItem("compact", "compacted", compactionLabel(JSONObject().put("beforeTokens", 100000).put("afterTokens", 11000))))
            state.contextUsage = JSONObject().put("tokens", 11000).put("limit", 200000).put("source", "estimated")
            compose.setContent { KKCodeTheme(dark = true) { KKCodeApp(state) } }
            compose.onNodeWithText("已压缩 · ≈ 100k → 11k").assertIsDisplayed()
            compose.onNodeWithText("这是一条旧提问").assertDoesNotExist()
            compose.runOnIdle {
                state.messages = state.messages + ChatItem("middle", "user", "两次压缩之间的提问", startedAt = 200)
                state.applySnapshot(JSONObject().put("messages", JSONArray().put(JSONObject().put("id", "second-compact").put("role", "user").put("content", "<compaction-summary>summary</compaction-summary>")
                    .put("compaction", JSONObject().put("compactedAt", 300).put("beforeTokens", 100000).put("afterTokens", 11000)))))
                assertTrue(state.messages.any { it.id == "old" })
                assertTrue(state.messages.any { it.id == "middle" })
            }
            compose.onNodeWithText("压缩前的记录 · 点击展开").performClick()
            compose.onNodeWithText("这是一条旧提问").assertIsDisplayed()
            compose.onNodeWithText("两次压缩之间的提问").assertIsDisplayed()
        } finally { models.clear() }
    }

    @Test fun longConversationOpensAtBottomAndOnlyFollowsWhenTheReaderReturns() {
        val state = RemoteState(ApplicationProvider.getApplicationContext<Application>(), false)
        val models = ViewModelStore(); models.put("state", state)
        try {
            state.selected = "scroll"; state.connected = true
            state.messages = (1..30).map { ChatItem("old-$it", "user", "历史消息 $it\n".repeat(6)) } + ChatItem("long", "user", "长消息底部\n".repeat(60))
            compose.setContent { KKCodeTheme(dark = true) { KKCodeApp(state) } }
            compose.onNodeWithTag("conversation-bottom").assertIsDisplayed()
            compose.onNodeWithTag("conversation-list").performTouchInput { swipeDown() }
            compose.onNodeWithText("回到最新").assertIsDisplayed()
            compose.runOnIdle { state.messages = state.messages + ChatItem("new", "user", "新来的消息，阅读时不跳动") }
            compose.onNodeWithText("新来的消息，阅读时不跳动").assertIsNotDisplayed()
            compose.onNodeWithText("回到最新").performClick()
            compose.onNodeWithText("新来的消息，阅读时不跳动").assertIsDisplayed()
            compose.onNodeWithTag("conversation-bottom").assertIsDisplayed()
        } finally { models.clear() }
    }

    @Test fun markdownTableKeepsEscapedPipesFormattingAlignmentAndSafeSelectableLinks() {
        val opened = mutableListOf<Intent>()
        val context = object : ContextWrapper(ApplicationProvider.getApplicationContext<Application>()) { override fun startActivity(intent: Intent) { opened += intent } }
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            val markwon = sourceMarkdown(context)
            val blocks = markdownBlocks(markwon, "正文\n\n| 项目 | 来源 | 数量 |\n| :--- | :---: | ---: |\n| **A\\|B** | [文档](https://example.org/docs) | `42` |\n\n结尾")
            assertEquals(3, blocks.size)
            val rows = blocks[1].rows
            assertEquals(2, rows.size); assertEquals(3, rows[1].size)
            assertTrue(rows[0].all { it.header }); assertEquals(TableCell.Alignment.RIGHT, rows[1][2].alignment)
            assertEquals("A|B", rows[1][0].content.toString())
            val paint = android.text.TextPaint()
            rows[1][0].content.getSpans(0, rows[1][0].content.length, android.text.style.MetricAffectingSpan::class.java).forEach { it.updateMeasureState(paint) }
            assertTrue(paint.isFakeBoldText || paint.typeface?.isBold == true)
            val view = TextView(context).apply { setTextIsSelectable(true) }
            setSourceSpans(view, rows[1][1].content)
            assertTrue(view.isTextSelectable); assertTrue(opened.isEmpty())
            val text = view.text as Spanned
            text.getSpans(0, text.length, ClickableSpan::class.java).single().onClick(view)
            assertEquals("https://example.org/docs", opened.single().dataString)
            assertTrue(markdownBlocks(markwon, "```\n| A | B |\n| - | - |\n```").all { it.rows.isEmpty() })
        }
    }

    @Test fun connectionNoticeFollowsRecoveryAndClearsWithoutManualDismissal() = runBlocking {
        val state = RemoteState(ApplicationProvider.getApplicationContext<Application>(), false)
        val models = ViewModelStore(); models.put("state", state)
        try {
            state.connectionLost("网络中断")
            compose.setContent { KKCodeTheme(dark = true) { KKCodeApp(state) } }
            compose.onNodeWithText("正在重连 · 网络中断").assertIsDisplayed()
            compose.runOnIdle { state.connectionRestored() }
            compose.onNodeWithText("连接已恢复").assertIsDisplayed()
            withTimeout(5000) { while(state.connectionNotice.isNotEmpty()) delay(50) }
            compose.onNodeWithText("连接已恢复").assertDoesNotExist()
        } finally { models.clear() }
    }

    @Test fun modelPickerRefreshesOnEveryOpenAndRejectsLateProviderResponses() = runBlocking {
        val server = MockWebServer(); var refreshes = 0
        val slowEntered = CountDownLatch(1); val slowRelease = CountDownLatch(1)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val body = JSONObject(request.body.readUtf8()); val params = body.optJSONObject("params") ?: JSONObject()
                val result = if(body.optString("method") == "settings.get") JSONObject().put("provider", JSONObject().put("default", "fixture").put("fixture", JSONObject().put("default_model", "first")))
                else {
                    assertTrue(params.getBoolean("refresh"))
                    val provider = params.optString("provider")
                    if(provider == "slow") { slowEntered.countDown(); assertTrue(slowRelease.await(10, TimeUnit.SECONDS)) }
                    JSONObject().put("models", JSONArray().put(JSONObject().put("id", "$provider-${++refreshes}"))).put("source", "network")
                }
                return MockResponse().setHeader("Content-Type", "application/json").setBody(JSONObject().put("result", result).toString())
            }
        }
        server.start()
        val state = RemoteState(ApplicationProvider.getApplicationContext<Application>(), false)
        val models = ViewModelStore(); models.put("state", state)
        state.api = DeviceApi(server.url("/").toString(), relay = false); state.connected = true
        try {
            state.openModelPicker().join(); assertEquals("fixture-1", state.modelOptions.single().getString("id"))
            state.sheet = ""; state.openModelPicker().join(); assertEquals("fixture-2", state.modelOptions.single().getString("id"))
            val slow = state.discoverModels("slow"); assertTrue(slowEntered.await(5, TimeUnit.SECONDS))
            state.discoverModels("fast").join(); assertEquals("fast", state.catalogProvider)
            slowRelease.countDown(); slow.join()
            assertEquals("fast", state.catalogProvider); assertEquals("fast-3", state.modelOptions.single().getString("id"))
        } finally { slowRelease.countDown(); models.clear(); server.shutdown() }
    }

    @Test fun nativeTableRendersWideCellsAndStreamingUpdates() {
        val text = androidx.compose.runtime.mutableStateOf("| 功能 | 状态 | 说明 |\n| :--- | :---: | ---: |\n| **Compact** | 已完成 | [文档](https://example.org/docs) |")
        compose.setContent { KKCodeTheme(dark = true) { androidx.compose.material3.Surface { MarkdownText(text.value) } } }
        compose.waitForIdle()
        compose.runOnIdle { text.value += "\n| 上下文 | 100k → 11k | 支持横向查看长表格单元格与流式更新 |" }
        compose.waitForIdle()
        val context = ApplicationProvider.getApplicationContext<Application>()
        val file = java.io.File(context.getExternalFilesDir(null), "markdown-109.png")
        file.outputStream().use { InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot().compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
        assertTrue(file.length() > 1000)
    }
}
