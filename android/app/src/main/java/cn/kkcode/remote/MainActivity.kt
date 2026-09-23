package cn.kkcode.remote

import android.os.Bundle
import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.SideEffect
import androidx.core.view.WindowCompat

class MainActivity : ComponentActivity() {
    private val state: RemoteState by viewModels()
    override fun onResume() { super.onResume(); state.updater.onForeground(); state.resumeLogin(); state.resumeSshConnection() }
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        state.handleLoginReturn(intent.dataString)
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        state.handleLoginReturn(intent?.dataString)
        setContent {
            val dark = state.appearance == "dark" || state.appearance == "auto" && isSystemInDarkTheme()
            SideEffect { WindowCompat.getInsetsController(window, window.decorView).isAppearanceLightStatusBars = !dark }
            KKCodeTheme(dark = dark) {
                KKCodeApp(state)
            }
        }
    }
}
