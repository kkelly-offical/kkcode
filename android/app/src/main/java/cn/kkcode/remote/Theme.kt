package cn.kkcode.remote

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

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
    primary = Color(0xFF83BDF5),
    onPrimary = Color(0xFF0B1B29),
    background = Color(0xFF000000),
    onBackground = Color(0xFFF2F2F5),
    surface = Color(0xFF1C1C1E),
    onSurface = Color(0xFFF2F2F5),
    surfaceVariant = Color(0xFF27272A),
    onSurfaceVariant = Color(0xFF939397),
    outline = Color(0xFF3A3A3F),
    error = Color(0xFFE48282),
)

private val LightScheme: ColorScheme = lightColorScheme(
    primary = Color(0xFF286DB0),
    onPrimary = Color(0xFFFFFFFF),
    background = Color(0xFFFFFFFF),
    onBackground = Color(0xFF1B1B1F),
    surface = Color(0xFFF6F6F8),
    onSurface = Color(0xFF1B1B1F),
    surfaceVariant = Color(0xFFE9E9ED),
    onSurfaceVariant = Color(0xFF5F5F66),
    outline = Color(0xFFD4D4DA),
    error = Color(0xFFC63B3B),
)

private val DarkExtras = KKCodeColors(
    success = Color(0xFF31C977),
    warning = Color(0xFFE4B18B),
    danger = Color(0xFFE48282),
    link = Color(0xFF71B8FF),
    diffAdd = Color(0xFF75B68D),
    diffRemove = Color(0xFFD47E89),
    activityMuted = Color(0xFF99999F),
    avatar = Color(0xFF44443F),
    switchTrackOff = Color(0xFF626269),
)

private val LightExtras = KKCodeColors(
    success = Color(0xFF1B9E57),
    warning = Color(0xFF9A5B24),
    danger = Color(0xFFC63B3B),
    link = Color(0xFF1B66C9),
    diffAdd = Color(0xFF2E7D4F),
    diffRemove = Color(0xFFB1344E),
    activityMuted = Color(0xFF6E6E75),
    avatar = Color(0xFFDDDDE3),
    switchTrackOff = Color(0xFFC4C4CB),
)

val LocalKKCodeColors = staticCompositionLocalOf { DarkExtras }
val kkcodeColors: KKCodeColors @Composable get() = LocalKKCodeColors.current

@Composable fun KKCodeTheme(dark: Boolean, content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalKKCodeColors provides if(dark) DarkExtras else LightExtras) {
        MaterialTheme(colorScheme = if(dark) DarkScheme else LightScheme, content = content)
    }
}
