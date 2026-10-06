package cn.kkcode.remote

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import org.json.JSONArray
import org.json.JSONObject

@Composable internal fun ExtensionsPanel(state: RemoteState) {
    var tab by remember { mutableStateOf("mcp") }
    var query by remember { mutableStateOf("") }
    var draft by remember { mutableStateOf<JSONObject?>(null) }
    var flow by remember { mutableStateOf<JSONObject?>(null) }
    var callback by remember { mutableStateOf("") }
    var saving by remember { mutableStateOf(false) }
    var review by remember { mutableStateOf<JSONObject?>(null) }
    fun run(work: suspend () -> Unit) { if(!saving) state.action { saving = true; try { work() } finally { saving = false } } }
    suspend fun refresh() { state.extensions = state.rpc("extensions.catalog") as JSONObject }
    fun set(key: String, value: Any) { draft = JSONObject(draft.toString()).put(key, value) }
    fun edit(item: JSONObject? = null) {
        draft = JSONObject().put("name", item?.optString("name") ?: "").put("transport", item?.optString("transport") ?: "streamable-http")
            .put("url", "").put("command", item?.optString("command") ?: "").put("argsText", "").put("auth", item?.optString("auth") ?: "none")
            .put("env", JSONArray()).put("headers", JSONArray()).put("existing", item != null)
        for(kind in listOf("env", "headers")) {
            val keys = item?.optJSONArray("${kind.dropLast(if(kind == "headers") 1 else 0)}Keys") ?: if(kind == "headers") item?.optJSONArray("headerKeys") else item?.optJSONArray("envKeys")
            val fields = JSONArray(); if(keys != null) for(i in 0 until keys.length()) fields.put(JSONObject().put("key", keys.getString(i)).put("value", ""))
            draft!!.put(kind, fields)
        }
    }
    LaunchedEffect(Unit) { state.action { refresh() } }
    LaunchedEffect(flow?.optString("id"), flow?.optString("status")) {
        val id = flow?.optString("id") ?: return@LaunchedEffect
        while(flow?.optString("status") == "pending") {
            delay(1000)
            try { flow = state.rpc("extensions.auth.status", JSONObject().put("id", id)) as JSONObject; if(flow?.optString("status") == "authorized") refresh() }
            catch(e: Exception) { state.notice = e.message ?: "登录状态不可用"; flow = null }
        }
    }
    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("当前设备 · ${state.deviceName}", style = MaterialTheme.typography.titleMedium)
        Text("凭据加密保存在该设备，不会加入聊天记录。", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { listOf("mcp" to "MCP", "plugins" to "Plugins", "skills" to "Skills").forEach { (id, label) -> FilterChip(tab == id, { tab = id; draft = null }, label = { Text(label) }) } }
        flow?.let { auth ->
            Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = MaterialTheme.shapes.large) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    val status = auth.optString("status")
                    Text(when(status) { "authorized" -> "连接成功"; "failed" -> "登录未完成，请重试"; "cancelled" -> "登录已取消"; else -> "在浏览器中完成授权" })
                    if(status == "pending") {
                        val url = auth.optString("url").takeUnless { it == "null" }.orEmpty()
                        if(url.isNotBlank()) Button(onClick = { openLoginBrowser(state.getApplication(), url) }) { Text("打开系统浏览器") } else LinearProgressIndicator(Modifier.fillMaxWidth())
                        Text("若浏览器最终地址无法打开，请粘贴该完整地址完成登录。", fontSize = 12.sp)
                        OutlinedTextField(callback, { callback = it }, label = { Text("回调地址") }, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
                        Button(onClick = { run { state.rpc("extensions.auth.complete", JSONObject().put("id", auth.getString("id")).put("url", callback)); callback = "" } }, enabled = !saving && callback.isNotBlank()) { Text("完成登录") }
                        TextButton(onClick = { run { flow = state.rpc("extensions.auth.cancel", JSONObject().put("id", auth.getString("id"))) as JSONObject; callback = "" } }) { Text("取消登录") }
                    }
                }
            }
        }
        review?.let { item ->
            Text("检查插件能力 · ${item.optString("name")}", style = MaterialTheme.typography.titleMedium)
            Text("来源：" + item.optString("source").ifBlank { item.optJSONObject("lock")?.optString("source") ?: "本机已安装插件" }, fontSize = 12.sp)
            val capabilities = item.optJSONArray("capabilities") ?: item.optJSONArray("addedCapabilities") ?: JSONArray()
            for(i in 0 until capabilities.length()) Text("• ${capabilities.getString(i)}", fontSize = 13.sp)
            Text("确认来源后，此插件将在当前电脑启用以上能力。", fontSize = 12.sp)
            Button(onClick = { run { state.rpc("extensions.manage", JSONObject().put("action", "plugin.manage").put("name", item.getString("name")).put("operation", "approve").put("confirmHash", item.getString("contentHash"))); review = null; refresh() } }, enabled = !saving) { Text("确认来源并启用") }
            TextButton(onClick = { review = null }) { Text("暂不启用") }
        }
        if(draft != null) {
            val form = draft!!
            OutlinedTextField(form.optString("name"), { set("name", it) }, enabled = !form.optBoolean("existing"), label = { Text("名称") }, modifier = Modifier.fillMaxWidth())
            if(tab == "mcp") {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) { listOf("streamable-http" to "HTTP", "legacy-sse" to "SSE", "stdio" to "本机").forEach { (id, label) -> FilterChip(form.optString("transport") == id, { set("transport", id) }, label = { Text(label) }) } }
                val local = form.optString("transport") == "stdio"
                if(local) {
                    OutlinedTextField(form.optString("command"), { set("command", it) }, label = { Text("可执行程序") }, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(form.optString("argsText"), { set("argsText", it) }, label = { Text("每行一个程序参数；留空保留已存参数") }, modifier = Modifier.fillMaxWidth())
                } else {
                    OutlinedTextField(form.optString("url"), { set("url", it) }, label = { Text(if(form.optBoolean("existing")) "服务地址（留空保留）" else "服务地址") }, modifier = Modifier.fillMaxWidth())
                    Row { Checkbox(form.optString("auth") == "oauth", { set("auth", if(it) "oauth" else "none") }); Text("浏览器授权 OAuth", modifier = Modifier.padding(top = 12.dp)) }
                }
                val kind = if(local) "env" else "headers"
                val values = form.optJSONArray(kind) ?: JSONArray()
                Text(if(local) "环境变量" else "请求头", style = MaterialTheme.typography.titleSmall)
                for(i in 0 until values.length()) {
                    val item = values.getJSONObject(i)
                    OutlinedTextField(item.optString("key"), { val next = JSONArray(values.toString()); next.getJSONObject(i).put("key", it); set(kind, next) }, label = { Text("字段名称 ${i + 1}") }, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(item.optString("value"), { val next = JSONArray(values.toString()); next.getJSONObject(i).put("value", it); set(kind, next) }, label = { Text("私密值；留空保留已保存值") }, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
                    TextButton(onClick = { val next = JSONArray(values.toString()); next.remove(i); set(kind, next) }) { Text("移除此字段") }
                }
                TextButton(onClick = { set(kind, JSONArray(values.toString()).put(JSONObject().put("key", "").put("value", ""))) }) { Text("＋ 添加字段") }
            } else if(tab == "plugins") {
                OutlinedTextField(form.optString("source"), { set("source", it) }, label = { Text("npm:包名@版本 或 HTTPS Git 仓库") }, modifier = Modifier.fillMaxWidth())
                if(form.optString("source").startsWith("https://")) OutlinedTextField(form.optString("revision"), { set("revision", it) }, label = { Text("完整提交编号") }, modifier = Modifier.fillMaxWidth())
            } else OutlinedTextField(form.optString("content"), { set("content", it) }, label = { Text("完整 SKILL.md 内容") }, minLines = 6, modifier = Modifier.fillMaxWidth())
            Button(onClick = { run {
                val params = JSONObject(form.toString()).put("action", when(tab) { "mcp" -> "mcp.save"; "plugins" -> "plugin.install"; else -> "skill.save" })
                params.put("args", JSONArray(form.optString("argsText").lines().filter { it.isNotBlank() }))
                val result = state.rpc("extensions.manage", params) as JSONObject
                draft = null; if(result.optBoolean("pendingApproval")) review = result; refresh()
            } }, enabled = !saving && form.optString("name").isNotBlank(), modifier = Modifier.fillMaxWidth()) { Text(if(saving) "正在保存…" else "保存到当前设备") }
            TextButton(onClick = { draft = null }, enabled = !saving) { Text("取消") }
        } else {
            OutlinedTextField(query, { query = it }, label = { Text("搜索扩展") }, modifier = Modifier.fillMaxWidth())
            Button(onClick = { edit() }, modifier = Modifier.fillMaxWidth()) { Text("＋ 添加") }
            state.extensions.optJSONArray(tab).objects().filter { (it.optString("name") + it.optString("description")).contains(query, true) }.forEach { item ->
                Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surfaceVariant, modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(item.optString("name"), style = MaterialTheme.typography.titleSmall)
                        Text(item.optString("description").ifBlank { if(item.optBoolean("ok")) "已连接" else if(!item.optBoolean("enabled", true)) "已停用" else "等待连接" }, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            if(tab == "mcp") {
                                if(item.optString("transport") != "stdio") TextButton(onClick = { run { flow = state.rpc("extensions.auth.start", JSONObject().put("name", item.getString("name"))) as JSONObject } }, enabled = !saving) { Text("登录") }
                                if(item.optString("transport") != "stdio" && item.optBoolean("ok")) TextButton(onClick = { run { state.rpc("extensions.auth.logout", JSONObject().put("name", item.getString("name"))); refresh() } }, enabled = !saving) { Text("退出登录") }
                                if(item.optBoolean("configurable")) TextButton(onClick = { edit(item) }) { Text("配置") }
                                if(item.optBoolean("managed")) { Switch(item.optBoolean("enabled", true), { value -> run { state.rpc("extensions.manage", JSONObject().put("action", "mcp.toggle").put("name", item.getString("name")).put("enabled", value)); refresh() } }, enabled = !saving) }
                            } else if(tab == "plugins") TextButton(onClick = { run { review = state.rpc("extensions.manage", JSONObject().put("action", "plugin.manage").put("name", item.getString("name")).put("operation", "inspect")) as JSONObject } }, enabled = !saving) { Text("管理") }
                            else Text("对话中可用", fontSize = 12.sp)
                        }
                    }
                }
            }
        }
    }
}
