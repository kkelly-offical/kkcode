package cn.kkcode.remote

/** View-only grouping. Canonical messages and live rows are never discarded. */
internal fun collapseCompletedRuns(items: List<ChatItem>, busy: Boolean): List<ChatItem> {
    val result = mutableListOf<ChatItem>()
    var pending = mutableListOf<ChatItem>()
    var started = 0L
    fun flush(last: Boolean) {
        val answer = pending.indexOfLast { it.kind == "assistant" && it.text.isNotBlank() }
        val activity = pending.filterIndexed { index, item -> index != answer && item.kind in listOf("assistant", "tool", "thinking", "review") }
        if(answer >= 0 && pending[answer].done && activity.isNotEmpty() && !(busy && last) && pending.none { it.kind == "error" } && pending.drop(answer + 1).none { it.kind in listOf("tool", "thinking", "review") }) {
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
