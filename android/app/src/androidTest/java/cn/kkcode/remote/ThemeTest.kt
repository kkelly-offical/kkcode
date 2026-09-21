package cn.kkcode.remote

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ThemeTest {
    @get:Rule val compose = createComposeRule()

    private data class SchemeProbe(val background: Color, val surface: Color, val onSurface: Color, val primary: Color, val success: Color, val warning: Color, val diffAdd: Color, val diffRemove: Color, val link: Color)

    private fun probeBoth(): Pair<SchemeProbe, SchemeProbe> {
        var dark: SchemeProbe? = null
        var light: SchemeProbe? = null
        compose.setContent {
            Column {
                KKCodeTheme(dark = true) {
                    dark = SchemeProbe(MaterialTheme.colorScheme.background, MaterialTheme.colorScheme.surface, MaterialTheme.colorScheme.onSurface, MaterialTheme.colorScheme.primary, kkcodeColors.success, kkcodeColors.warning, kkcodeColors.diffAdd, kkcodeColors.diffRemove, kkcodeColors.link)
                }
                KKCodeTheme(dark = false) {
                    light = SchemeProbe(MaterialTheme.colorScheme.background, MaterialTheme.colorScheme.surface, MaterialTheme.colorScheme.onSurface, MaterialTheme.colorScheme.primary, kkcodeColors.success, kkcodeColors.warning, kkcodeColors.diffAdd, kkcodeColors.diffRemove, kkcodeColors.link)
                }
            }
        }
        compose.waitForIdle()
        return dark!! to light!!
    }

    @Test fun darkAndLightSchemesAreClearlyDistinct() {
        val (dark, light) = probeBoth()
        assertNotEquals(dark.background, light.background)
        assertNotEquals(dark.surface, light.surface)
        assertNotEquals(dark.onSurface, light.onSurface)
        assertNotEquals(dark.primary, light.primary)
        assertNotEquals(dark.success, light.success)
        assertNotEquals(dark.warning, light.warning)
        assertNotEquals(dark.diffAdd, light.diffAdd)
        assertNotEquals(dark.diffRemove, light.diffRemove)
        assertNotEquals(dark.link, light.link)
    }

    @Test fun bothSchemesKeepTextReadableOnBackground() {
        val (dark, light) = probeBoth()
        for (scheme in listOf(dark, light)) {
            assertTrue(contrast(scheme.onSurface, scheme.background) >= 7.0)
            assertTrue(contrast(scheme.primary, scheme.background) >= 3.0)
            assertTrue(contrast(scheme.success, scheme.background) >= 2.2)
            assertTrue(contrast(scheme.diffRemove, scheme.background) >= 2.2)
        }
    }

    private fun contrast(a: Color, b: Color): Double {
        fun channel(value: Float): Double = if (value <= 0.03928f) value / 12.92 else Math.pow((value + 0.055) / 1.055, 2.4)
        fun luminance(color: Color): Double = 0.2126 * channel(color.red) + 0.7152 * channel(color.green) + 0.0722 * channel(color.blue)
        val high = maxOf(luminance(a), luminance(b)); val low = minOf(luminance(a), luminance(b))
        return (high + 0.05) / (low + 0.05)
    }
}
