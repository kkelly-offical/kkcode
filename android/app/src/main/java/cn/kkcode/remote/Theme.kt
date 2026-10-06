package cn.kkcode.remote

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.material3.Shapes
import androidx.compose.foundation.shape.RoundedCornerShape
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
    primary = Color(0xFFE6BB75),
    onPrimary = Color(0xFF292719),
    background = Color(0xFF0D1311),
    onBackground = Color(0xFFECEFE6),
    surface = Color(0xFF121A16),
    onSurface = Color(0xFFECEFE6),
    surfaceVariant = Color(0xFF18221D),
    onSurfaceVariant = Color(0xFFA6B3A8),
    outline = Color(0xFF425649),
    outlineVariant = Color(0xFF2C3B34),
    primaryContainer = Color(0xFF223229), onPrimaryContainer = Color(0xFFECEFE6),
    secondary = Color(0xFFA4D8B5), onSecondary = Color(0xFF161F1A),
    secondaryContainer = Color(0xFF2D3E30), onSecondaryContainer = Color(0xFFE8EBE1),
    tertiary = Color(0xFFC5BADB), onTertiary = Color(0xFF161F1A),
    tertiaryContainer = Color(0xFF3B3546), onTertiaryContainer = Color(0xFFE8EBE1),
    inverseSurface = Color(0xFFE9E4D3), inverseOnSurface = Color(0xFF29382E), inversePrimary = Color(0xFF416D4E),
    surfaceTint = Color(0xFFECEFE6),
    error = Color(0xFFE48282),
)

private val LightScheme: ColorScheme = lightColorScheme(
    primary = Color(0xFF345B46),
    onPrimary = Color(0xFFFFFCF3),
    background = Color(0xFFF6F3EA),
    onBackground = Color(0xFF29382E),
    surface = Color(0xFFFFFCF3),
    onSurface = Color(0xFF29382E),
    surfaceVariant = Color(0xFFEAE6D9),
    onSurfaceVariant = Color(0xFF637063),
    outline = Color(0xFFB8BCA5),
    outlineVariant = Color(0xFFDFDCCB),
    primaryContainer = Color(0xFFE8DEC3), onPrimaryContainer = Color(0xFF29382E),
    secondary = Color(0xFF54755C), onSecondary = Color(0xFFFFFCF3),
    secondaryContainer = Color(0xFFDADDD3), onSecondaryContainer = Color(0xFF252823),
    tertiary = Color(0xFF756587), onTertiary = Color(0xFFFFFCF3),
    tertiaryContainer = Color(0xFFE1E4D9), onTertiaryContainer = Color(0xFF252823),
    inverseSurface = Color(0xFF171A16), inverseOnSurface = Color(0xFFFFFCF3), inversePrimary = Color(0xFFA8D9AF),
    surfaceTint = Color(0xFF29382E),
    error = Color(0xFFC63B3B),
)

private val DarkExtras = KKCodeColors(
    success = Color(0xFF4FCB8A),
    warning = Color(0xFFE4B18B),
    danger = Color(0xFFE48282),
    link = Color(0xFFA8D9AF),
    diffAdd = Color(0xFF75B68D),
    diffRemove = Color(0xFFD47E89),
    activityMuted = Color(0xFFA6B6A4),
    avatar = Color(0xFF33442D),
    switchTrackOff = Color(0xFF626269),
)

private val LightExtras = KKCodeColors(
    success = Color(0xFF1B9E57),
    warning = Color(0xFF9A5B24),
    danger = Color(0xFFC63B3B),
    link = Color(0xFF416D4E),
    diffAdd = Color(0xFF2E7D4F),
    diffRemove = Color(0xFFB1344E),
    activityMuted = Color(0xFF637063),
    avatar = Color(0xFFE7DEC5),
    switchTrackOff = Color(0xFFC4C4CB),
)

val LocalKKCodeColors = staticCompositionLocalOf { DarkExtras }
val kkcodeColors: KKCodeColors @Composable get() = LocalKKCodeColors.current

@Composable fun KKCodeTheme(dark: Boolean, content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalKKCodeColors provides if(dark) DarkExtras else LightExtras) {
        MaterialTheme(colorScheme = if(dark) DarkScheme else LightScheme, shapes = Shapes(extraSmall = RoundedCornerShape(4.dp), small = RoundedCornerShape(8.dp), medium = RoundedCornerShape(12.dp), large = RoundedCornerShape(16.dp), extraLarge = RoundedCornerShape(24.dp)), content = content)
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
