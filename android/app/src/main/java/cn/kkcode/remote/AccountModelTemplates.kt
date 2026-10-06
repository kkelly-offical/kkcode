package cn.kkcode.remote

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.json.JSONObject

@Composable internal fun AccountModelTemplates(state: RemoteState) {
    var expanded by remember { mutableStateOf(false) }
    var data by remember { mutableStateOf(JSONObject()) }
    var draft by remember { mutableStateOf<JSONObject?>(null) }
    var busy by remember { mutableStateOf(false) }
    fun run(work: suspend () -> Unit) { if(!busy) state.action { busy = true; try { work() } finally { busy = false } } }
    Column(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        OutlinedButton(onClick = { expanded = !expanded; if(expanded) run { data = state.accountModels() } }, enabled = state.accountTemplatesAvailable && !busy, modifier = Modifier.fillMaxWidth()) { Text(if(expanded) "收起账号模板" else "从账号模板复制") }
        if(!state.accountTemplatesAvailable) Text("登录账号网关后，可跨端复用模型模板。", fontSize = 12.sp)
        if(expanded) {
            Text("复制后各设备独立修改，后续不会互相覆盖。", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            val form = draft
            if(form != null) {
                fun set(key: String, value: String) { draft = JSONObject(form.toString()).put(key, value) }
                OutlinedTextField(form.optString("name"), { set("name", it) }, enabled = !form.optBoolean("existing"), label = { Text("模板名称") }, modifier = Modifier.fillMaxWidth())
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { listOf("openai" to "OpenAI", "anthropic" to "Anthropic").forEach { (id, label) -> FilterChip(form.optString("type") == id, { set("type", id) }, label = { Text(label) }) } }
                OutlinedTextField(form.optString("base_url"), { set("base_url", it) }, label = { Text("Base URL") }, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(form.optString("api_key"), { set("api_key", it) }, label = { Text("API Key；留空保留已保存值") }, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
                OutlinedTextField(form.optString("default_model"), { set("default_model", it) }, label = { Text("默认模型") }, modifier = Modifier.fillMaxWidth())
                Button(onClick = { run {
                    val entry = JSONObject(form.toString())
                    val name = entry.getString("name")
                    entry.remove("name"); entry.remove("existing")
                    if(form.optBoolean("existing") && entry.optString("api_key").isBlank()) entry.remove("api_key")
                    data = state.accountModels(body = JSONObject().put("revision", data.optInt("revision")).put("provider", JSONObject().put(name, entry)))
                    draft = null
                } }, enabled = !busy && form.optString("name").isNotBlank()) { Text("保存到账号") }
                TextButton(onClick = { draft = null }) { Text("取消") }
            } else {
                TextButton(onClick = { draft = JSONObject().put("name", "").put("type", "openai").put("base_url", "").put("api_key", "").put("api_key_env", "").put("default_model", "") }) { Text("＋ 添加账号模板") }
                val provider = data.optJSONObject("provider") ?: JSONObject()
                provider.keys().asSequence().toList().forEach { name ->
                    val entry = provider.optJSONObject(name)
                    if(entry != null && (entry.has("type") || entry.has("base_url"))) Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(14.dp)) {
                            Text(name, style = MaterialTheme.typography.titleSmall); Text(entry.optString("default_model"), fontSize = 12.sp)
                            Row {
                                TextButton(onClick = { draft = JSONObject(entry.toString()).put("name", name).put("api_key", "").put("existing", true) }) { Text("编辑") }
                                TextButton(onClick = { run {
                                    val settings = state.rpc("settings.get") as JSONObject
                                    var targetName = name
                                    var suffix = 1
                                    while(settings.optJSONObject("provider")?.has(targetName) == true) { targetName = "$name-copy-$suffix"; suffix++ }
                                    val resolved = state.accountModels("/resolve", JSONObject()).getJSONObject("provider").getJSONObject(name)
                                    val result = state.rpc("settings.update", JSONObject().put("config", JSONObject().put("provider", JSONObject().put(targetName, resolved)))) as JSONObject
                                    state.settings = result.getJSONObject("config"); state.notice = "$targetName 已复制到设备，后续独立修改"
                                } }, enabled = !busy) { Text("复制到设备") }
                            }
                        }
                    }
                }
            }
        }
    }
}
