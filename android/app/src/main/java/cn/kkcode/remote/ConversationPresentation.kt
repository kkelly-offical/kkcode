package cn.kkcode.remote

import org.json.JSONObject
import java.util.Locale

internal fun compactionLabel(value: JSONObject?): String {
    if(value == null || !value.has("beforeTokens") || !value.has("afterTokens")) return "已精简上下文"
    fun count(number: Double): String = if(number >= 1000) String.format(Locale.ROOT, "%.1f", number / 1000).removeSuffix(".0") + "k" else number.toLong().toString()
    return "已压缩 · ≈ ${count(value.optDouble("beforeTokens"))} → ${count(value.optDouble("afterTokens"))}"
}

internal fun collapseCompactedHistory(items: List<ChatItem>): List<ChatItem> {
    val boundary = items.indexOfLast { it.kind == "compacted" }
    if(boundary < 0) return items
    val history = items.take(boundary).filter { it.kind != "compacted" }
    return (if(history.isEmpty()) emptyList() else listOf(ChatItem("history-${items[boundary].id}", "compacted-history", "压缩前的记录 · 点击展开", children = history))) + items.drop(boundary)
}

/** View-only grouping. Canonical messages and live rows are never discarded. */
internal fun collapseCompletedRuns(items: List<ChatItem>, busy: Boolean): List<ChatItem> {
    val result = mutableListOf<ChatItem>()
    var pending = mutableListOf<ChatItem>()
    var started = 0L
    fun flush(last: Boolean) {
        val answer = pending.indexOfLast { it.kind == "assistant" && it.text.isNotBlank() }
        val activity = pending.filterIndexed { index, item -> index != answer && item.kind in listOf("assistant", "tool", "thinking", "review") }
        if(answer >= 0 && pending[answer].done && activity.isNotEmpty() && !(busy && last) && pending.none { it.kind in listOf("error", "cancelled") } && pending.drop(answer + 1).none { it.kind in listOf("tool", "thinking", "review") }) {
            val end = pending.maxOfOrNull { it.startedAt + (it.durationMs ?: 0) } ?: 0L
            val begin = started.takeIf { it > 0 } ?: pending.map { it.startedAt }.filter { it > 0 }.minOrNull() ?: 0L
            result += ChatItem("run-${pending.first().turnId.ifBlank { pending.first().id }}", "run-summary", "", startedAt = begin,
                durationMs = if(begin > 0 && end >= begin) end - begin else null, children = activity)
            result += pending.filterIndexed { index, item -> index == answer || item !in activity }
        } else result += pending
        pending = mutableListOf()
    }
    for(item in items) {
        if(item.kind in listOf("user", "compacted")) { flush(false); result += item; started = item.startedAt }
        else pending += item
    }
    flush(true)
    return result
}
