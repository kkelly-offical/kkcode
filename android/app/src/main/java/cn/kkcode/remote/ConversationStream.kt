package cn.kkcode.remote

/** Only durable journal seq values advance replay. SSE control frames reuse
 * Last-Event-ID and must still apply at the same cursor (state, hello, gap). */
internal class SessionEventCursor(initial: Long) {
    var value: Long = initial
        private set
    fun accept(sequence: Long?): Boolean {
        if(sequence == null || sequence <= 0) return true
        if(sequence <= value) return false
        value = sequence
        return true
    }
    fun reset(sequence: Long) { value = sequence }
}

internal data class StreamDelta(val id: String, val kind: String, val text: String, val turnId: String, val step: Int?, val timestamp: Long)
internal fun streamStepKey(turnId: String, step: Int?): String? = if(turnId.isBlank() || step == null) null else "$turnId:$step"

internal fun beginStreamThinking(items: List<ChatItem>, event: StreamDelta, persisted: Set<String>): List<ChatItem> {
    if(streamStepKey(event.turnId, event.step) in persisted || items.any { it.streamed && !it.done && it.kind == "thinking" && it.turnId == event.turnId && it.step == event.step }) return items
    return items + ChatItem(event.id, "thinking", "", startedAt = event.timestamp, done = false, turnId = event.turnId, step = event.step, streamed = true)
}

internal fun appendStreamDelta(items: List<ChatItem>, event: StreamDelta, persisted: Set<String>): List<ChatItem> {
    if(streamStepKey(event.turnId, event.step) in persisted || event.text.isEmpty()) return items
    val index = items.indexOfLast { it.streamed && !it.done && it.kind == event.kind && it.turnId == event.turnId && it.step == event.step }
    if(index < 0) return items + ChatItem(event.id, event.kind, event.text, startedAt = event.timestamp, done = false, turnId = event.turnId, step = event.step, streamed = true)
    return items.mapIndexed { at, item -> if(at == index) item.copy(text = item.text + event.text) else item }
}

internal fun finishStreamStep(items: List<ChatItem>, turnId: String, step: Int?, timestamp: Long): List<ChatItem> = items.map { item ->
    if(item.streamed && !item.done && (turnId.isBlank() || item.turnId == turnId) && (step == null || item.step == step)) item.copy(done = true, durationMs = (timestamp - item.startedAt).coerceAtLeast(0)) else item
}

internal fun finishStreamReply(items: List<ChatItem>, id: String, turnId: String, step: Int?, reply: String, timestamp: Long): List<ChatItem> {
    val finished = finishStreamStep(items, turnId, null, timestamp)
    if(reply.isBlank()) return finished
    val index = finished.indexOfLast { it.kind == "assistant" && it.turnId == turnId && (step == null || it.step == step) }
    if(index >= 0 && finished[index].text == reply) return finished
    // The result may omit step. Never overwrite commentary before a tool call or
    // an unrelated turn merely because it is the last assistant message.
    val replace = index >= 0 && finished[index].streamed && finished.drop(index + 1).none { it.kind == "tool" || it.kind == "user" || it.kind == "assistant" }
    if(replace) return finished.mapIndexed { at, item -> if(at == index) item.copy(text = reply, done = true) else item }
    return finished + ChatItem(id, "assistant", reply, startedAt = timestamp, turnId = turnId, step = step)
}
