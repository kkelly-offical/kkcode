package cn.kkcode.remote

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.json.JSONObject
import java.text.NumberFormat

internal fun contextSummary(value: JSONObject): String? {
    val used = value.optDouble("tokens", Double.NaN)
    val limit = value.optDouble("limit", Double.NaN)
    if(!used.isFinite() || !limit.isFinite() || used <= 0 || limit <= 0) return null
    val number = NumberFormat.getIntegerInstance()
    val percent = (used * 100 / limit).toInt().coerceIn(0, 100)
    val suffix = when(value.optString("source", "estimated")) {
        "strict-upper-bound" -> " · 保守上界"
        "count-api", "provider-usage" -> ""
        else -> " · 估算"
    }
    return "上下文 ${number.format(used.toLong())} / ${number.format(limit.toLong())} · $percent%" + suffix
}

internal fun contextExplanation(value: JSONObject): String = "这是当前上下文占用，不是累计用量。" + when(value.optString("source", "estimated")) {
    "strict-upper-bound" -> "完整请求的保守上界，用于严格模式的窗口检查和自动压缩；不是模型实际 token 计数或计费值。分项仍是估算，不要求相加等于上界。"
    "count-api" -> "根据模型端对当前请求的计数更新。"
    "provider-usage" -> "根据最近一次响应的输入 usage 更新，不代表下一次请求的精确计数。"
    else -> "估算包含系统提示、工具声明、历史及媒体；与模型计费值可能不同。"
}

@Composable internal fun ContextUsageView(value: JSONObject) {
    val summary = contextSummary(value) ?: return
    var expanded by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().clickable { expanded = true }.padding(horizontal = 18.dp, vertical = 6.dp)) {
        Text(summary, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        LinearProgressIndicator(progress = { (value.optDouble("tokens") / value.optDouble("limit")).toFloat().coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth().padding(top = 4.dp).height(2.dp))
    }
    if(expanded) AlertDialog(onDismissRequest = { expanded = false }, title = { Text("上下文使用情况") }, text = { Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(summary)
        Text(contextExplanation(value))
        Text("输出预留：${value.optLong("outputReserved")} tokens。接近预算时自动压缩，也可输入 /compact 手动整理。")
    } }, confirmButton = { TextButton(onClick = { expanded = false }) { Text("知道了") } })
}
