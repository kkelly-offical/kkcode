package cn.kkcode.remote

import android.animation.ValueAnimator
import androidx.compose.animation.core.*
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp

internal fun thinkingDotAlphas(phase: Float, animated: Boolean): List<Float> = (0..8).map { index ->
    if(!animated) .55f else when((phase.coerceIn(0f, 9f) - index + 9f) % 9f) {
        in 0f..1f -> .95f
        in 1f..3f -> .55f
        else -> .22f
    }
}

@Composable internal fun ThinkingDots(modifier: Modifier = Modifier, animated: Boolean = ValueAnimator.areAnimatorsEnabled()) {
    val color = kkcodeColors.activityMuted
    val phase = if(animated) {
        val transition = rememberInfiniteTransition(label = "thinking-matrix")
        val value by transition.animateFloat(0f, 9f, infiniteRepeatable(tween(1100, easing = LinearEasing), RepeatMode.Restart), label = "thinking-wave")
        value
    } else 0f
    val alphas = thinkingDotAlphas(phase, animated)
    Canvas(modifier.size(16.dp).testTag("thinking-dot-matrix")) {
        val cell = 3.dp.toPx(); val gap = 2.dp.toPx()
        val left = (size.width - cell * 3 - gap * 2) / 2
        val top = (size.height - cell * 3 - gap * 2) / 2
        alphas.forEachIndexed { index, alpha -> drawRect(color.copy(alpha = alpha), Offset(left + (index % 3) * (cell + gap), top + (index / 3) * (cell + gap)), Size(cell, cell)) }
    }
}
