package cn.kkcode.remote

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.Color
import androidx.core.view.WindowCompat

class MainActivity : ComponentActivity() {
    private val state: RemoteState by viewModels()
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            val dark = state.appearance == "dark" || state.appearance == "auto" && isSystemInDarkTheme()
            SideEffect { WindowCompat.getInsetsController(window, window.decorView).isAppearanceLightStatusBars = !dark }
            MaterialTheme(colorScheme = if(dark) darkColorScheme(primary = Color(0xFF83BDF5), background = Color.Black, surface = Color(0xFF1C1C1E), surfaceVariant = Color(0xFF27272A), onSurfaceVariant = Color(0xFF939397)) else lightColorScheme(primary = Color(0xFF286DB0), background = Color.White, surface = Color(0xFFF6F6F8), surfaceVariant = Color(0xFFE9E9ED))) {
                KKCodeApp(state)
            }
        }
    }
}
