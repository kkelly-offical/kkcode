package cn.kkcode.remote

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.CloudQueue
import androidx.compose.material.icons.outlined.Hub
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.json.JSONObject

internal fun catalogSourceLabel(source: String, stale: Boolean): String = when(source) {
    "network" -> "自动发现 · 实时目录"
    "cache" -> if(stale) "自动发现 · 缓存（已过期）" else "自动发现 · 缓存"
    "config" -> "本地配置列表"
    else -> ""
}

internal fun configuredProviderNames(providers: JSONObject): List<String> = providers.keys().asSequence()
    .filter { providers.opt(it) is JSONObject && it !in setOf("default", "model_context", "model_thinking", "model_capabilities") }.toList()

internal fun modelCapabilityLabel(entry: JSONObject?): String {
    val capabilities = entry?.optJSONObject("capabilities") ?: return ""
    val sources = entry.optJSONObject("capabilitySources")
    return listOf("image" to "图像", "audio" to "音频", "video" to "视频", "tools" to "工具", "reasoning" to "思考")
        .filter { capabilities.opt(it.first) == true }
        .joinToString(" · ") { it.second + if(sources?.optString(it.first) == "heuristic") "?" else "" }
}

@Composable internal fun ModelPicker(state: RemoteState) {
    val providers = state.settings.optJSONObject("provider") ?: JSONObject()
    val names = configuredProviderNames(providers)
    Text("当前：${state.modelLabel}${if(state.provider.isNotBlank()) " · ${state.provider}" else ""}", fontSize = 13.sp, color = kkcodeColors.activityMuted, modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp))
    if(state.busy) Text("任务执行期间不能切换模型，完成后即可切换。", fontSize = 12.sp, color = kkcodeColors.warning, modifier = Modifier.padding(horizontal = 12.dp))
    if(names.isEmpty()) {
        Text("电脑上还没有配置模型渠道。", fontSize = 13.sp, modifier = Modifier.padding(12.dp))
        TextButton(onClick = { state.editingProvider = ""; state.sheet = "provider" }) { Text("添加渠道", color = kkcodeColors.link) }
    }
    names.forEach { name ->
        val profile = providers.getJSONObject(name)
        val defaultModel = profile.optString("default_model")
        Group {
            SettingsRow(Icons.Outlined.Hub, name, defaultModel) { state.discoverModels(name) }
            if(state.catalogProvider == name) {
                catalogSourceLabel(state.catalogSource, state.catalogStale).takeIf { it.isNotBlank() }?.let { Text(it, fontSize = 10.sp, color = if(state.catalogStale) kkcodeColors.warning else kkcodeColors.activityMuted, modifier = Modifier.padding(horizontal = 16.dp, vertical = 2.dp)) }
                if(state.catalogError.isNotBlank()) ManualModelEntry(state, name)
                val discovered = state.modelOptions.map { it.getString("id") }
                val merged = (listOf(defaultModel) + discovered + listOf(if(state.provider == name) state.model else "")).filter { it.isNotBlank() }.distinct()
                merged.forEach { id ->
                    val entry = state.modelOptions.find { it.optString("id") == id }
                    val origin = entry?.optString("origin") ?: ""
                    val tag = listOf(if(id == defaultModel) "默认" else if(origin == "manual") "手动" else "", modelCapabilityLabel(entry)).filter { it.isNotBlank() }.joinToString(" · ")
                    ModelOption(enabled = !state.busy, current = state.provider == name && state.model == id, id = id, tag = tag) { state.selectModel(name, id) }
                }
            }
        }
    }
    Group { SettingsRow(Icons.Outlined.Tune, "管理模型渠道", "添加、编辑或删除电脑上的渠道") { state.sheet = "models" } }
    Text("模型目录自动从电脑渠道读取并标记来源；读取失败时才手动输入。选择后立即写入当前会话，并同步到其他客户端。", fontSize = 11.sp, color = kkcodeColors.activityMuted, modifier = Modifier.padding(12.dp))
}

@Composable private fun ManualModelEntry(state: RemoteState, provider: String) {
    var manual by remember { mutableStateOf("") }
    Column(Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) {
        Text("无法自动读取模型列表：${state.catalogError}", fontSize = 11.sp, color = kkcodeColors.warning, lineHeight = 16.sp)
        OutlinedTextField(manual, { manual = it }, label = { Text("手动输入模型 ID") }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 6.dp))
        TextButton(enabled = manual.isNotBlank() && !state.busy, onClick = { state.selectModel(provider, manual.trim()) }, modifier = Modifier.align(Alignment.End)) { Text("使用此模型", color = kkcodeColors.link, fontSize = 12.sp) }
    }
}

@Composable private fun ModelOption(enabled: Boolean, current: Boolean, id: String, tag: String = "", onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(enabled = enabled, onClick = onClick).padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(if(current) Icons.Outlined.Check else Icons.Outlined.CloudQueue, null, Modifier.size(18.dp), tint = if(current) kkcodeColors.success else kkcodeColors.activityMuted)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(id, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if(tag.isNotBlank()) Text(tag, fontSize = 10.sp, color = kkcodeColors.activityMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}
