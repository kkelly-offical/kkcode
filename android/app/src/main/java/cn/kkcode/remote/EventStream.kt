package cn.kkcode.remote

data class SseFrame(val id: String, val event: String, val data: String)

internal class SseParser(private val onFrame: (SseFrame) -> Unit) {
    private var event = "message"
    private var id = ""
    private val data = StringBuilder()
    fun line(raw: String) {
        val line = raw.removeSuffix("\r")
        when {
            line.isEmpty() -> dispatch()
            line.startsWith(":") -> Unit
            else -> {
                val colon = line.indexOf(':')
                val field = if(colon < 0) line else line.substring(0, colon)
                var value = if(colon < 0) "" else line.substring(colon + 1)
                if(value.startsWith(" ")) value = value.substring(1)
                when(field) {
                    "event" -> event = value
                    "data" -> { if(data.isNotEmpty()) data.append('\n'); data.append(value) }
                    "id" -> if(!value.contains('\u0000')) id = value
                }
            }
        }
    }
    private fun dispatch() {
        if(data.isNotEmpty()) onFrame(SseFrame(id, event, data.toString()))
        event = "message"; data.clear()
    }
}
