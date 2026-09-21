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
    var pending by remember { mutableStateOf("") }
    var creating by remember { mutableStateOf(false) }
    var confirmationToken by remember { mutableStateOf("") }
    val canChange = snapshot.optBoolean("clean") && !state.busy && state.selected.isNotBlank()
    Text("当前分支：${snapshot.optString("current", "分离 HEAD")}", fontSize = 14.sp, modifier = Modifier.padding(vertical = 12.dp))
    if(!snapshot.optBoolean("clean")) Text("工作区有未提交变更，不能切换或创建分支。请先在电脑上处理变更，再刷新。", color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
    if(state.busy) Text("任务执行期间不能切换分支。", color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
    if(state.selected.isBlank()) Text("先创建或打开会话，再切换分支。", fontSize = 12.sp)
    snapshot.optJSONArray("branches").objects().forEach { branch ->
        TextButton(enabled = canChange && !branch.optBoolean("current") && !branch.optBoolean("checkedOut"), onClick = { pending = branch.getString("name"); creating = false; confirmationToken = snapshot.optString("stateToken") }, modifier = Modifier.fillMaxWidth()) { Text("${if(branch.optBoolean("current")) "✓ " else ""}${branch.optString("name")}${if(branch.optBoolean("checkedOut") && !branch.optBoolean("current")) " · 已在其他工作树打开" else ""}", modifier = Modifier.weight(1f)) }
    }
    OutlinedTextField(name, { name = it }, label = { Text("新分支名称") }, singleLine = true, modifier = Modifier.fillMaxWidth())
    Row {
        TextButton(enabled = canChange && name.isNotBlank(), onClick = { pending = name.trim(); creating = true; confirmationToken = snapshot.optString("stateToken") }) { Text("创建新分支") }
        TextButton(onClick = { state.loadBranches() }) { Text("刷新状态") }
    }
    Text("只操作本地分支；不会自动 stash、强制覆盖、推送或删除分支。确认后服务器会重新检查 Git 状态，过期确认无效。", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 12.dp))
    if(pending.isNotBlank()) AlertDialog(onDismissRequest = { pending = "" }, title = { Text(if(creating) "创建并切换分支？" else "切换分支？") }, text = { Text("${snapshot.optString("current")} → $pending\n这将改变该仓库所有会话使用的工作文件。") }, confirmButton = { TextButton(onClick = { state.changeBranch(pending, creating, confirmationToken); pending = "" }) { Text("确认切换") } }, dismissButton = { TextButton(onClick = { pending = "" }) { Text("取消") } })
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
