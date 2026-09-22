package cn.kkcode.remote

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.material3.Shapes
import androidx.compose.foundation.shape.CutCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind

@Immutable
class KKCodeColors(
    val success: Color,
    val warning: Color,
    val danger: Color,
    val link: Color,
    val diffAdd: Color,
    val diffRemove: Color,
    val activityMuted: Color,
    val avatar: Color,
    val switchTrackOff: Color,
)

private val DarkScheme: ColorScheme = darkColorScheme(
    primary = Color(0xFFEFEFEA),
    onPrimary = Color(0xFF080808),
    background = Color(0xFF050505),
    onBackground = Color(0xFFF5F5F5),
    surface = Color(0xFF0B0B0B),
    onSurface = Color(0xFFF5F5F5),
    surfaceVariant = Color(0xFF151515),
    onSurfaceVariant = Color(0xFFA0A09A),
    outline = Color(0xFF3D3D3A),
    outlineVariant = Color(0xFF262626),
    primaryContainer = Color(0xFF242424), onPrimaryContainer = Color(0xFFF5F5F5),
    secondary = Color(0xFFB4B4AC), onSecondary = Color(0xFF0B0B0B),
    secondaryContainer = Color(0xFF242720), onSecondaryContainer = Color(0xFFE8EBE1),
    tertiary = Color(0xFFC0C4BC), onTertiary = Color(0xFF0B0B0B),
    tertiaryContainer = Color(0xFF272A24), onTertiaryContainer = Color(0xFFE8EBE1),
    inverseSurface = Color(0xFFEEEEEA), inverseOnSurface = Color(0xFF121212), inversePrimary = Color(0xFF303B32),
    surfaceTint = Color(0xFFF5F5F5),
    error = Color(0xFFE48282),
)

private val LightScheme: ColorScheme = lightColorScheme(
    primary = Color(0xFF161616),
    onPrimary = Color(0xFFFAFAF8),
    background = Color(0xFFF0F0EE),
    onBackground = Color(0xFF121212),
    surface = Color(0xFFFAFAF8),
    onSurface = Color(0xFF121212),
    surfaceVariant = Color(0xFFE6E7E2),
    onSurfaceVariant = Color(0xFF5C5C58),
    outline = Color(0xFFB5B8AE),
    outlineVariant = Color(0xFFDCDDD8),
    primaryContainer = Color(0xFFE4E5DF), onPrimaryContainer = Color(0xFF121212),
    secondary = Color(0xFF565952), onSecondary = Color(0xFFFAFAF8),
    secondaryContainer = Color(0xFFDADDD3), onSecondaryContainer = Color(0xFF252823),
    tertiary = Color(0xFF62685A), onTertiary = Color(0xFFFAFAF8),
    tertiaryContainer = Color(0xFFE1E4D9), onTertiaryContainer = Color(0xFF252823),
    inverseSurface = Color(0xFF171A16), inverseOnSurface = Color(0xFFFAFAF8), inversePrimary = Color(0xFFD6DFD2),
    surfaceTint = Color(0xFF121212),
    error = Color(0xFFC63B3B),
)

private val DarkExtras = KKCodeColors(
    success = Color(0xFF31C977),
    warning = Color(0xFFE4B18B),
    danger = Color(0xFFE48282),
    link = Color(0xFFD6DFD2),
    diffAdd = Color(0xFF75B68D),
    diffRemove = Color(0xFFD47E89),
    activityMuted = Color(0xFFA0A09A),
    avatar = Color(0xFF252723),
    switchTrackOff = Color(0xFF626269),
)

private val LightExtras = KKCodeColors(
    success = Color(0xFF1B9E57),
    warning = Color(0xFF9A5B24),
    danger = Color(0xFFC63B3B),
    link = Color(0xFF303B32),
    diffAdd = Color(0xFF2E7D4F),
    diffRemove = Color(0xFFB1344E),
    activityMuted = Color(0xFF62665D),
    avatar = Color(0xFFDEDFD8),
    switchTrackOff = Color(0xFFC4C4CB),
)

val LocalKKCodeColors = staticCompositionLocalOf { DarkExtras }
val kkcodeColors: KKCodeColors @Composable get() = LocalKKCodeColors.current

@Composable fun KKCodeTheme(dark: Boolean, content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalKKCodeColors provides if(dark) DarkExtras else LightExtras) {
        MaterialTheme(colorScheme = if(dark) DarkScheme else LightScheme, shapes = Shapes(extraSmall = CutCornerShape(2.dp), small = CutCornerShape(3.dp), medium = CutCornerShape(4.dp), large = CutCornerShape(6.dp), extraLarge = CutCornerShape(8.dp)), content = content)
    }
}

/** Stair-step corners are drawing only: all existing layout/hit target sizes stay. */
internal data class PixelShape(val corner: Dp = 6.dp, val bottomCorners: Boolean = true) : Shape {
    override fun createOutline(size: Size, layoutDirection: LayoutDirection, density: Density): Outline {
        val cut = with(density) { corner.toPx() }.coerceAtMost(minOf(size.width, size.height) / 4)
        val bottom = if(bottomCorners) cut else 0f
        val path = Path().apply {
            moveTo(cut, 0f); lineTo(size.width - cut, 0f); lineTo(size.width - cut, cut / 2); lineTo(size.width - cut / 2, cut / 2); lineTo(size.width - cut / 2, cut); lineTo(size.width, cut)
            lineTo(size.width, size.height - bottom); lineTo(size.width - bottom / 2, size.height - bottom); lineTo(size.width - bottom / 2, size.height - bottom / 2); lineTo(size.width - bottom, size.height - bottom / 2); lineTo(size.width - bottom, size.height)
            lineTo(bottom, size.height); lineTo(bottom, size.height - bottom / 2); lineTo(bottom / 2, size.height - bottom / 2); lineTo(bottom / 2, size.height - bottom); lineTo(0f, size.height - bottom)
            lineTo(0f, cut); lineTo(cut / 2, cut); lineTo(cut / 2, cut / 2); lineTo(cut, cut / 2); close()
        }
        return Outline.Generic(path)
    }
}

@Composable internal fun Modifier.pixelBackground(): Modifier {
    val ink = MaterialTheme.colorScheme.onBackground.copy(alpha = .035f)
    return drawBehind {
        val gap = 28.dp.toPx(); val pixel = 1.dp.toPx()
        var y = 0f
        while(y < size.height) { var x = 0f; while(x < size.width) { drawRect(ink, Offset(x, y), Size(pixel, pixel)); x += gap }; y += gap }
    }
}
