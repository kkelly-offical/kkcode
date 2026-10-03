package cn.kkcode.remote

import android.app.Application
import android.content.Context
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PixelStudioUiTest {
    @get:Rule val compose = createComposeRule()
    private fun show(shared: Boolean = false): RemoteState {
        val app = ApplicationProvider.getApplicationContext<Application>()
        app.getSharedPreferences("kkcode.studio", Context.MODE_PRIVATE).edit().clear().commit()
        val state = RemoteState(app, false).apply { selected = "studio-fixture"; connected = true; sharedDevice = shared }
        compose.setContent { KKCodeTheme(true) { KKCodeApp(state) } }
        return state
    }
    @Test fun companionPreservesDraftAndNeverSendsTheSuggestedPrompt() {
        val state = show()
        compose.runOnIdle { state.draft = "已有要求" }
        compose.onNodeWithContentDescription("像素伙伴").performClick()
        compose.onNodeWithText("了解项目").performClick()
        compose.runOnIdle {
            assertEquals("已有要求\n\n梳理项目结构，说明主要模块与入口。", state.draft)
            assertEquals(false, state.busy)
            assertEquals(0, state.messages.size)
        }
    }
    @Test fun sharedViewerCannotInsertPromptAndSeesReadOnlyStatus() {
        show(true)
        compose.onNodeWithText("只读陪伴").assertIsDisplayed()
        compose.onNodeWithContentDescription("像素伙伴").performClick()
        compose.onNodeWithText("了解项目").assertIsNotEnabled()
    }
    @Test fun palettePersistsAndStatusTracksStopping() {
        val state = show()
        compose.onNodeWithContentDescription("像素伙伴").performClick()
        compose.onNodeWithText("鸢尾").performClick()
        compose.onNodeWithText("继续创作").performClick()
        compose.runOnIdle { state.busy = true; state.stopping = true }
        compose.onNodeWithContentDescription("像素伙伴").assertTextContains("正在停止")
        compose.runOnIdle { assertEquals("iris", ApplicationProvider.getApplicationContext<Application>().getSharedPreferences("kkcode.studio", Context.MODE_PRIVATE).getString("palette", "")) }
    }
}
