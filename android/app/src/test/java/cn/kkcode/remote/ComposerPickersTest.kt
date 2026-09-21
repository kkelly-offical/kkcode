package cn.kkcode.remote

import org.junit.Assert.*
import org.junit.Test

class ComposerPickersTest {
    @Test fun catalogSourceLabelsReflectOriginAndStaleness() {
        assertEquals("自动发现 · 实时目录", catalogSourceLabel("network", false))
        assertEquals("自动发现 · 缓存", catalogSourceLabel("cache", false))
        assertEquals("自动发现 · 缓存（已过期）", catalogSourceLabel("cache", true))
        assertEquals("本地配置列表", catalogSourceLabel("config", false))
        assertEquals("", catalogSourceLabel("", false))
        assertEquals("", catalogSourceLabel("unknown", false))
    }

    @Test fun approvalLevelsAreTheCanonicalFour() {
        assertEquals(listOf("readonly", "manual", "accept-edits", "yolo"), APPROVAL_LEVELS.map { it.first })
        assertTrue(APPROVAL_LEVELS.all { it.second.isNotBlank() && it.third.isNotBlank() })
    }
}
