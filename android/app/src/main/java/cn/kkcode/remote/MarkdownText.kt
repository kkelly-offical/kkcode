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
import android.widget.TableLayout
import android.widget.TableRow
import android.view.Gravity
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.viewinterop.AndroidView
import io.noties.markwon.AbstractMarkwonPlugin
import io.noties.markwon.Markwon
import io.noties.markwon.MarkwonConfiguration
import org.commonmark.ext.gfm.tables.TablesExtension
import org.commonmark.ext.gfm.tables.TableBlock
import org.commonmark.ext.gfm.tables.TableCell
import org.commonmark.node.Node
import org.commonmark.node.Document
import org.commonmark.parser.Parser
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
    override fun configureParser(builder: Parser.Builder) { builder.extensions(listOf(TablesExtension.create())) }
}).build()

internal fun renderSourceMarkdown(view: TextView, text: String) {
    (view.tag as Markwon).setMarkdown(view, text)
    setSourceSpans(view, view.text)
}

internal fun setSourceSpans(view: TextView, rendered: CharSequence) {
    // Linkify removes existing URLSpan subclasses, including Markwon's links.
    // Discover plain URLs on a separate string and merge only non-overlapping
    // ranges, so titled Markdown sources keep their safe custom link resolver.
    val content = SpannableString(rendered)
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

internal data class MarkdownCell(val content: Spanned, val header: Boolean, val alignment: TableCell.Alignment?)
internal data class MarkdownBlock(val content: Spanned? = null, val rows: List<List<MarkdownCell>> = emptyList())
private fun Node.children(): List<Node> = generateSequence(firstChild) { it.next }.toList()

/** Parse with CommonMark so escaped pipes, code fences and inline links keep their meaning. */
internal fun markdownBlocks(markwon: Markwon, text: String): List<MarkdownBlock> {
    val result = mutableListOf<MarkdownBlock>()
    var prose = Document()
    fun flush() { if(prose.firstChild != null) { result += MarkdownBlock(content = markwon.render(prose)); prose = Document() } }
    fun tableRows(node: Node): List<List<MarkdownCell>> {
        val children = node.children()
        if(children.any { it is TableCell }) return listOf(children.filterIsInstance<TableCell>().map { cell ->
            val content = Document(); cell.children().forEach { content.appendChild(it) }
            MarkdownCell(markwon.render(content), cell.isHeader, cell.alignment)
        })
        return children.flatMap { tableRows(it) }
    }
    for(node in markwon.parse(text).children()) {
        if(node is TableBlock) { flush(); result += MarkdownBlock(rows = tableRows(node)) }
        else prose.appendChild(node)
    }
    flush()
    return result
}

@Composable internal fun MarkdownText(text: String, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val markwon = remember(context) { sourceMarkdown(context) }
    val blocks = remember(markwon, text) { markdownBlocks(markwon, text) }
    val color = MaterialTheme.colorScheme.onSurface.toArgb()
    val linkColor = kkcodeColors.link.toArgb()
    val border = MaterialTheme.colorScheme.outlineVariant.toArgb()
    val header = MaterialTheme.colorScheme.surfaceVariant.toArgb()
    Column(modifier) {
        blocks.forEach { block ->
            if(block.content != null) AndroidView(factory = { ctx -> TextView(ctx).apply {
                textSize = 15f; setLineSpacing(5f, 1.12f); setTextIsSelectable(true)
            } }, update = { view -> view.setTextColor(color); view.setLinkTextColor(linkColor); setSourceSpans(view, block.content) }, modifier = Modifier.fillMaxWidth())
            else AndroidView(factory = { ctx -> TableLayout(ctx) }, update = { table ->
                // Cells are real selectable TextViews, including their safe clickable spans.
                table.removeAllViews()
                val density = table.resources.displayMetrics.density
                block.rows.forEach { cells ->
                    val row = TableRow(table.context)
                    cells.forEach { cell ->
                        val view = TextView(table.context).apply {
                            textSize = 14f; setTextColor(color); setLinkTextColor(linkColor); setTextIsSelectable(true)
                            minWidth = (120 * density).toInt(); maxWidth = (280 * density).toInt()
                            setPadding((12 * density).toInt(), (10 * density).toInt(), (12 * density).toInt(), (10 * density).toInt())
                            gravity = Gravity.TOP or when(cell.alignment) { TableCell.Alignment.RIGHT -> Gravity.RIGHT; TableCell.Alignment.CENTER -> Gravity.CENTER_HORIZONTAL; else -> Gravity.LEFT }
                            if(cell.header) setTypeface(typeface, Typeface.BOLD)
                            background = GradientDrawable().apply { setColor(if(cell.header) header else android.graphics.Color.TRANSPARENT); setStroke(density.toInt().coerceAtLeast(1), border) }
                            setSourceSpans(this, cell.content)
                        }
                        row.addView(view, TableRow.LayoutParams(TableRow.LayoutParams.WRAP_CONTENT, TableRow.LayoutParams.MATCH_PARENT))
                    }
                    table.addView(row)
                }
                table.contentDescription = "Markdown 表格，可横向滚动"
            }, modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp).horizontalScroll(rememberScrollState()))
        }
    }
}
