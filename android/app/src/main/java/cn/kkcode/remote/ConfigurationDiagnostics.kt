package cn.kkcode.remote

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.json.JSONObject

internal fun configurationDiagnosticLines(settings: JSONObject): List<String> {
    val diagnostics = settings.optJSONObject("_diagnostics") ?: return emptyList()
    val lines = mutableListOf<String>()
    if(diagnostics.optInt("errorCount") > 0) {
        lines += if(diagnostics.optBoolean("toolsBlocked")) "权限配置需要修正，工具执行已暂停" else "电脑上的配置需要修正"
        val errors = diagnostics.optJSONArray("errors")
        for(i in 0 until minOf(errors?.length() ?: 0, 16)) {
            val item = errors?.optJSONObject(i) ?: continue
            val label = listOf(item.optString("source"), item.optString("field")).filter { it.isNotBlank() }.joinToString(" · ")
            lines += safeErrorDetail("$label：${item.optString("message")}".take(900))
        }
    }
    if(diagnostics.optInt("warningCount") > 0) lines += safeErrorDetail(diagnostics.optString("warning").take(900))
    return lines.filter { it.isNotBlank() }
}

@Composable internal fun ConfigurationDiagnostics(settings: JSONObject) {
    val lines = configurationDiagnosticLines(settings)
    if(lines.isNotEmpty()) Column(Modifier.padding(12.dp)) {
        lines.forEach { Text(it, color = kkcodeColors.warning, fontSize = 12.sp, modifier = Modifier.padding(bottom = 6.dp)) }
    }
}
