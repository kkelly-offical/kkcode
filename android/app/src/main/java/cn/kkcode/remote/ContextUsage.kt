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
    if(!used.isFinite() || !limit.isFinite() || used < 0 || limit <= 0) return null
    val number = NumberFormat.getIntegerInstance()
    val percent = (used * 100 / limit).toInt().coerceIn(0, 100)
    return "上下文 ${number.format(used.toLong())} / ${number.format(limit.toLong())} · $percent%" + if(value.optString("source", "estimated") == "estimated") " · 估算" else ""
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
        Text("这是当前上下文占用，不是累计用量。估算包含系统提示、工具声明、历史及媒体；模型端返回计数后更新。")
        Text("输出预留：${value.optLong("outputReserved")} tokens。接近预算时自动压缩，也可输入 /compact 手动整理。")
    } }, confirmButton = { TextButton(onClick = { expanded = false }) { Text("知道了") } })
}
