package cn.kkcode.remote

import org.json.JSONObject

internal fun mcpLoadNotice(event: JSONObject): String {
    if(event.optString("type") != "mcp.loaded" || event.optInt("configured") == 0) return ""
    val failed = event.optJSONArray("failed")
    val names = (0 until minOf(failed?.length() ?: 0, 3)).map { failed!!.optJSONObject(it)?.optString("name") ?: "" }.joinToString("、")
    val suffix = if(event.optInt("failedCount") > 0) " · ${event.optInt("failedCount")} 项失败（$names）" else ""
    return "MCP ${event.optInt("connected")}/${event.optInt("configured")} 已连接 · ${event.optInt("toolCount")} 个工具$suffix"
}
