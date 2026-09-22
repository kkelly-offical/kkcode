package cn.kkcode.remote

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.json.JSONArray
import org.json.JSONObject

@Composable internal fun BranchPicker(state: RemoteState) {
    val snapshot = state.branchSnapshot
    var name by remember { mutableStateOf("") }
    var base by remember { mutableStateOf("") }
    var baseMenu by remember { mutableStateOf(false) }
    var folder by remember { mutableStateOf("") }
    var parent by remember(snapshot.optString("suggestedParent")) { mutableStateOf(snapshot.optString("suggestedParent")) }
    var tab by remember { mutableStateOf("local") }
    var query by remember { mutableStateOf("") }
    var pending by remember { mutableStateOf<JSONObject?>(null) }
    var pendingMethod by remember { mutableStateOf("") }
    var pendingLabel by remember { mutableStateOf("") }
    var confirmationToken by remember { mutableStateOf("") }
    val available = !state.busy && !state.loading && state.selected.isNotBlank()
    val canChange = snapshot.optBoolean("clean") && available
    fun confirm(method: String, params: JSONObject, label: String) { pending = params; pendingMethod = method; pendingLabel = label; confirmationToken = snapshot.optString("stateToken") }
    Text("当前分支：${snapshot.optString("current", "分离 HEAD")}", fontSize = 14.sp, modifier = Modifier.padding(vertical = 12.dp))
    if(!snapshot.optBoolean("clean")) Text("工作区有未提交变更，不能切换分支；可以从已有提交创建独立 Worktree，原修改保持不变。", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 12.sp)
    if(state.busy) Text("任务执行期间不能切换分支。", color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
    if(state.selected.isBlank()) Text("先创建或打开会话，再切换分支。", fontSize = 12.sp)
    Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) { listOf("local" to "本地", "remote" to "远端缓存", "worktrees" to "Worktree").forEach { (id, label) -> FilterChip(selected = tab == id, onClick = { tab = id; pending = null }, label = { Text(label) }) } }
    OutlinedTextField(query, { query = it }, label = { Text("搜索分支或工作树") }, singleLine = true, modifier = Modifier.fillMaxWidth())
    if(tab == "worktrees") {
        snapshot.optJSONArray("worktrees").objects().filter { (it.optString("path") + it.optString("branch")).contains(query, true) }.forEach { item ->
            TextButton(enabled = available && !item.optBoolean("prunable"), onClick = { confirm("worktrees.open", JSONObject().put("path", item.getString("path")), "在 ${item.optString("path")} 中新建对话") }, modifier = Modifier.fillMaxWidth()) { Column(Modifier.weight(1f)) { Text(item.optString("branch", "游离 HEAD")); Text(item.optString("path") + if(item.optBoolean("locked")) " · 已锁定" else "", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant) } }
        }
        if(snapshot.optInt("unavailableWorktrees") > 0) Text("另有 ${snapshot.optInt("unavailableWorktrees")} 个工作树不在设备授权范围内。", fontSize = 11.sp)
    } else {
        if(tab == "remote") Text("本地缓存的远端引用，不会联网 fetch。选择后可据此创建分支或 Worktree。", fontSize = 11.sp, modifier = Modifier.padding(vertical = 8.dp))
        snapshot.optJSONArray(if(tab == "remote") "remoteBranches" else "branches").objects().filter { it.optString("name").contains(query, true) }.forEach { branch ->
            TextButton(enabled = if(tab == "remote") available else canChange && !branch.optBoolean("current") && !branch.optBoolean("checkedOut"), onClick = {
                if(tab == "remote") base = branch.getString("name") else confirm("branches.switch", JSONObject().put("name", branch.getString("name")), "切换到 ${branch.getString("name")}")
            }, modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.weight(1f)) {
                    Text("${if(branch.optBoolean("current")) "✓ " else ""}${branch.optString("name")}${if(branch.optBoolean("checkedOut") && !branch.optBoolean("current")) " · 其他工作树使用中" else ""}")
                    Text(listOf(branch.optString("commit").take(8), branch.optString("upstream"), if(branch.optInt("ahead") > 0) "↑${branch.optInt("ahead")}" else "", if(branch.optInt("behind") > 0) "↓${branch.optInt("behind")}" else "", branch.optString("subject")).filter { it.isNotBlank() }.joinToString(" · "), fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
    Box {
        TextButton(onClick = { baseMenu = true }) { Text("起点：${base.ifBlank { "当前 HEAD" }}") }
        DropdownMenu(expanded = baseMenu, onDismissRequest = { baseMenu = false }) {
            DropdownMenuItem(text = { Text("当前 HEAD") }, onClick = { base = ""; baseMenu = false })
            (snapshot.optJSONArray("branches").objects() + snapshot.optJSONArray("remoteBranches").objects()).forEach { branch -> DropdownMenuItem(text = { Text(branch.optString("name")) }, onClick = { base = branch.optString("name"); baseMenu = false }) }
        }
    }
    OutlinedTextField(name, { name = it }, label = { Text("新分支名称") }, singleLine = true, modifier = Modifier.fillMaxWidth())
    if(tab == "worktrees") { OutlinedTextField(parent, { parent = it }, label = { Text("Worktree 父目录") }, singleLine = true, modifier = Modifier.fillMaxWidth()); OutlinedTextField(folder, { folder = it }, label = { Text("新文件夹名称") }, singleLine = true, modifier = Modifier.fillMaxWidth()) }
    Row {
        TextButton(enabled = name.isNotBlank() && if(tab == "worktrees") available && parent.isNotBlank() && folder.isNotBlank() else canChange, onClick = {
            val params = JSONObject().put("name", name.trim()); if(base.isNotBlank()) params.put("startPoint", base)
            if(tab == "worktrees") { params.put("parent", parent).put("folderName", folder.trim()); confirm("worktrees.create", params, "创建独立工作树 $folder（分支 $name）") }
            else confirm("branches.create", params, "创建并切换到 $name")
        }) { Text(if(tab == "worktrees") "创建 Worktree" else "创建新分支") }
        TextButton(enabled = !state.loading, onClick = { state.loadBranches() }) { Text("刷新状态") }
    }
    Text("只操作本地分支；不会自动 stash、强制覆盖、推送或删除分支。确认后服务器会重新检查 Git 状态，过期确认无效。", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 12.dp))
    pending?.let { params -> AlertDialog(onDismissRequest = { pending = null }, title = { Text("确认 Git 操作？") }, text = { Text(pendingLabel + if(pendingMethod.startsWith("worktrees.")) "\n原对话与工作目录保持不变。" else "\n其他客户端也会看到分支变化。") }, confirmButton = { TextButton(onClick = { state.gitOperation(pendingMethod, params, confirmationToken); pending = null }) { Text("确认操作") } }, dismissButton = { TextButton(onClick = { pending = null }) { Text("取消") } }) }
}

@Composable internal fun PreferencesForm(state: RemoteState) {
    val source = state.profilePreferences
    var beginner by remember(source) { mutableStateOf(source.optBoolean("beginner")) }
    fun listText(key: String): String = source.optJSONArray(key)?.let { list -> (0 until list.length()).joinToString(", ") { list.optString(it) } } ?: ""
    var languages by remember(source) { mutableStateOf(listText("languages")) }
    var stack by remember(source) { mutableStateOf(listText("tech_stack")) }
    var style by remember(source) { mutableStateOf(source.optString("design_style")) }
    var notes by remember(source) { mutableStateOf(source.optString("extra_notes")) }
    Text("这些是被控电脑的工作偏好，不会修改你的企业 SSO 身份。", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 12.dp))
    Row { Text("需要新手引导", Modifier.weight(1f)); Switch(beginner, { beginner = it }) }
    OutlinedTextField(languages, { languages = it }, label = { Text("编程语言（逗号分隔）") }, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(stack, { stack = it }, label = { Text("技术栈（逗号分隔）") }, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(style, { style = it }, label = { Text("设计风格") }, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(notes, { notes = it }, label = { Text("其他偏好") }, modifier = Modifier.fillMaxWidth(), maxLines = 6)
    Button(onClick = {
        fun split(value: String): JSONArray = JSONArray(value.split(',', '，').map { it.trim() }.filter { it.isNotBlank() })
        state.savePreferences(JSONObject().put("beginner", beginner).put("languages", split(languages)).put("tech_stack", split(stack)).put("design_style", style).put("extra_notes", notes))
    }, modifier = Modifier.fillMaxWidth().padding(top = 12.dp)) { Text("保存偏好") }
}

@Composable internal fun DeviceOwnership(deviceId: String) {
    Text("为防止远程接管，解绑和账号转移必须在被控电脑的终端确认。退出本 App 登录不会解绑设备，也不会断开其他客户端。", fontSize = 14.sp, lineHeight = 23.sp, modifier = Modifier.padding(vertical = 12.dp))
    val id = deviceId.ifBlank { "<设备 ID>" }
    SelectionContainer { Text("解绑：\nkkcode remote unbind --confirm $id\n\n转移并明确携带本地历史：\nkkcode remote transfer --gateway <新网关 URL> --confirm $id --include-history", fontSize = 12.sp, modifier = Modifier.padding(vertical = 12.dp)) }
    Text("解绑会撤销原网关绑定、设备凭据和所有分享。本地历史保留；转移后历史归新登录账号所有，务必先核对账号和组织。", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
}
