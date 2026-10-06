@file:OptIn(androidx.compose.ui.text.ExperimentalTextApi::class)

package cn.kkcode.remote

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.unit.sp

internal val KKFontFamily = FontFamily(
    Font(R.font.kk_sans, weight = FontWeight.Normal, variationSettings = FontVariation.Settings(FontVariation.weight(400))),
    Font(R.font.kk_sans, weight = FontWeight.Medium, variationSettings = FontVariation.Settings(FontVariation.weight(500))),
    Font(R.font.kk_sans, weight = FontWeight.SemiBold, variationSettings = FontVariation.Settings(FontVariation.weight(600))),
    Font(R.font.kk_sans, weight = FontWeight.Bold, variationSettings = FontVariation.Settings(FontVariation.weight(700))),
)
private fun style(size: Int, line: Int, weight: FontWeight = FontWeight.Normal) = TextStyle(fontFamily = KKFontFamily, fontWeight = weight, fontSize = size.sp, lineHeight = line.sp, letterSpacing = 0.sp)
internal val KKTypography = Typography(
    displayLarge = style(48, 58, FontWeight.SemiBold), displayMedium = style(40, 50, FontWeight.SemiBold), displaySmall = style(34, 44, FontWeight.SemiBold),
    headlineLarge = style(30, 40, FontWeight.SemiBold), headlineMedium = style(26, 36, FontWeight.SemiBold), headlineSmall = style(23, 32, FontWeight.SemiBold),
    titleLarge = style(21, 30, FontWeight.SemiBold), titleMedium = style(17, 26, FontWeight.Medium), titleSmall = style(15, 23, FontWeight.Medium),
    bodyLarge = style(16, 26), bodyMedium = style(14, 23), bodySmall = style(12, 19),
    labelLarge = style(14, 21, FontWeight.Medium), labelMedium = style(12, 18, FontWeight.Medium), labelSmall = style(11, 17, FontWeight.Medium),
)

internal val KKMonoFamily = FontFamily(Font(R.font.kk_mono))
