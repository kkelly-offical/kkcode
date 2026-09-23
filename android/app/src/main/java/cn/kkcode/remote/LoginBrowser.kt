package cn.kkcode.remote

import android.content.Context
import android.content.Intent
import android.content.ActivityNotFoundException
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent

internal fun openLoginBrowser(context: Context, url: String) {
    // A Custom Tab retains the user's browser SSO session, never an embedded
    // WebView. Browsers without Custom Tabs still handle its ACTION_VIEW intent.
    val tab = CustomTabsIntent.Builder().setShowTitle(true).build()
    tab.intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try { tab.launchUrl(context, Uri.parse(url)) }
    catch(_: ActivityNotFoundException) { throw IllegalStateException("未找到可用浏览器，请安装浏览器后点击重新打开浏览器") }
}
