package cn.kkcode.remote

import org.junit.Assert.*
import org.junit.Test

class ThinkingDotsTest {
    @Test fun matrixHasNineBoundedDotsAndLoopsWithoutChangingItsFootprint() {
        for(phase in 0..90) {
            val dots = thinkingDotAlphas(phase / 10f, true)
            assertEquals(9, dots.size)
            assertTrue(dots.all { it in .2f..1f })
        }
        assertEquals(thinkingDotAlphas(0f, true), thinkingDotAlphas(9f, true))
        assertNotEquals(thinkingDotAlphas(0f, true), thinkingDotAlphas(4f, true))
    }
    @Test fun disabledAnimationIsStaticAndStillVisible() {
        assertEquals(List(9) { .55f }, thinkingDotAlphas(0f, false))
        assertEquals(thinkingDotAlphas(0f, false), thinkingDotAlphas(8f, false))
    }
    @Test fun cancelledActivityIsNeverLabelledAsCompleted() {
        val rows = listOf(ChatItem("u", "user", "work"), ChatItem("t", "thinking", "partial"), ChatItem("a", "assistant", "partial"), ChatItem("c", "cancelled", "stopped"))
        assertEquals(rows, collapseCompletedRuns(rows, false))
    }
}
