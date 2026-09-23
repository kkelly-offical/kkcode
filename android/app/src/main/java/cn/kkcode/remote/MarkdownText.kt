package cn.kkcode.remote

import android.content.Intent
import android.net.Uri
import android.text.SpannableString
import android.text.Spanned
import android.text.method.LinkMovementMethod
import android.text.style.ClickableSpan
import android.text.style.URLSpan
import android.text.util.Linkify
import android.view.View
import android.widget.TextView
import android.widget.Toast
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.viewinterop.AndroidView
import io.noties.markwon.AbstractMarkwonPlugin
import io.noties.markwon.Markwon
import io.noties.markwon.MarkwonConfiguration
import java.net.URI

internal fun browserLink(value: String): String? = runCatching {
    val url = URI(value.trim())
    value.trim().takeIf { url.scheme?.lowercase() in listOf("https", "http") && !url.host.isNullOrBlank() && url.rawUserInfo == null }
}.getOrNull()

internal fun openSourceLink(view: View, link: String) {
    val url = browserLink(link)
    if(url == null) { Toast.makeText(view.context, "仅支持在浏览器打开 HTTP/HTTPS 来源链接", Toast.LENGTH_SHORT).show(); return }
    try { view.context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    catch(_: android.content.ActivityNotFoundException) { Toast.makeText(view.context, "没有可用的浏览器，请先安装浏览器", Toast.LENGTH_SHORT).show() }
}

internal fun sourceMarkdown(context: android.content.Context): Markwon = Markwon.builder(context).usePlugin(object : AbstractMarkwonPlugin() {
    override fun configureConfiguration(builder: MarkwonConfiguration.Builder) { builder.linkResolver { view, link -> openSourceLink(view, link) } }
}).build()

internal fun renderSourceMarkdown(view: TextView, text: String) {
    (view.tag as Markwon).setMarkdown(view, text)
    // Linkify removes existing URLSpan subclasses, including Markwon's links.
    // Discover plain URLs on a separate string and merge only non-overlapping
    // ranges, so titled Markdown sources keep their safe custom link resolver.
    val content = SpannableString(view.text)
    val plain = SpannableString(content.toString())
    Linkify.addLinks(plain, Linkify.WEB_URLS)
    plain.getSpans(0, plain.length, URLSpan::class.java).forEach { span ->
        val start = plain.getSpanStart(span); val end = plain.getSpanEnd(span)
        if(browserLink(span.url) != null && content.getSpans(start, end, ClickableSpan::class.java).isEmpty()) content.setSpan(object : ClickableSpan() {
            override fun onClick(widget: View) { openSourceLink(widget, span.url) }
        }, start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
    view.text = content
    view.linksClickable = true
    view.movementMethod = LinkMovementMethod.getInstance()
}

@Composable internal fun MarkdownText(text: String, modifier: Modifier = Modifier) {
    val color = MaterialTheme.colorScheme.onSurface.toArgb()
    val linkColor = kkcodeColors.link.toArgb()
    AndroidView(factory = { context -> TextView(context).apply {
        textSize = 15f; setLineSpacing(5f, 1.12f); setTextIsSelectable(true); tag = sourceMarkdown(context)
    } }, update = { view -> view.setTextColor(color); view.setLinkTextColor(linkColor); renderSourceMarkdown(view, text) }, modifier = modifier)
}
