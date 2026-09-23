package cn.kkcode.remote

import android.widget.TextView
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import io.noties.markwon.Markwon
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.time.LocalDate

private val muted: Color @Composable get() = MaterialTheme.colorScheme.onSurfaceVariant
private val card: Color @Composable get() = MaterialTheme.colorScheme.surfaceVariant
private val connectedGreen: Color @Composable get() = kkcodeColors.success

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun KKCodeApp(state: RemoteState) {
    var menu by remember { mutableStateOf(false) }
    var search by remember { mutableStateOf("") }
    var sort by remember { mutableStateOf("priority") }
    var archived by remember { mutableStateOf(false) }
    val updateNotices = remember { SnackbarHostState() }
    LaunchedEffect(state.updater.candidate?.versionCode, state.busy) {
        val update = state.updater.candidate
        if(update != null && state.updater.hasUpdate && !state.busy && update.versionCode != state.updater.dismissedCode) {
            state.updater.dismissNotice()
            if(updateNotices.showSnackbar("KK Code ${update.versionName} 可更新", "查看", withDismissAction = true, duration = SnackbarDuration.Short) == SnackbarResult.ActionPerformed) state.sheet = "updates"
        }
    }
    val inChat = state.selected.isNotBlank()
    BackHandler(enabled = inChat && state.sheet.isBlank()) { state.leaveChat() }
    Scaffold(containerColor = MaterialTheme.colorScheme.background, snackbarHost = { SnackbarHost(updateNotices) }, topBar = {
        Row(Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            CircleButton(if(inChat) Icons.Outlined.ArrowBack else Icons.Outlined.Menu, if(inChat) "返回会话列表" else "设备与连接") { if(inChat) state.leaveChat() else state.sheet = "connections" }
            Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(if(inChat) state.sessions.find { it.optString("id") == state.selected }?.optString("title")?.takeIf { it.isNotBlank() } ?: "新对话" else "远程", fontSize = 16.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.clickable { state.sheet = "connections" }.padding(top = 3.dp)) {
                    Box(Modifier.size(6.dp).background(if(state.connected) connectedGreen else muted, CircleShape))
                    Spacer(Modifier.width(6.dp)); Icon(Icons.Outlined.Terminal, null, Modifier.size(12.dp), tint = muted)
                    Spacer(Modifier.width(4.dp)); Text(if(inChat) "${state.cwd.split('/', '\\').lastOrNull()} · ${state.deviceName}" else state.deviceName, color = muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            Box {
                CircleButton(Icons.Outlined.MoreHoriz, "更多") { menu = true }
                DropdownMenu(menu, { menu = false }, containerColor = card, shape = PixelShape()) {
                    if(inChat && !state.sharedDevice) {
                        DropdownMenuItem(text = { Text("管理当前对话") }, leadingIcon = { Icon(Icons.Outlined.Edit, null) }, onClick = { state.managedSession = state.sessions.find { it.optString("id") == state.selected } ?: JSONObject().put("id", state.selected); menu = false })
                        HorizontalDivider()
                    }
                    listOf("priority" to "优先级", "project" to "按项目", "time" to "按时间倒序排列").forEach { (value, label) ->
                        DropdownMenuItem(text = { Text(label, fontSize = 14.sp) }, leadingIcon = { Icon(if(sort == value) Icons.Outlined.Check else Icons.Outlined.Sort, null) }, onClick = { sort = value; menu = false })
                    }
                    HorizontalDivider(color = MaterialTheme.colorScheme.onSurface.copy(alpha = .09f))
                    DropdownMenuItem(text = { Text(if(archived) "所有对话" else "已归档对话") }, leadingIcon = { Icon(Icons.Outlined.Archive, null) }, onClick = { archived = !archived; menu = false })
                    DropdownMenuItem(text = { Text("添加连接") }, leadingIcon = { Icon(Icons.Outlined.Link, null) }, onClick = { state.sheet = "add"; menu = false })
                    DropdownMenuItem(text = { Text("设置") }, leadingIcon = { Icon(Icons.Outlined.Settings, null) }, onClick = { state.openSettings(); menu = false })
                }
            }
        }
    }, bottomBar = {
        if(!inChat) Row(Modifier.fillMaxWidth().navigationBarsPadding().padding(16.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Row(Modifier.weight(1f).height(46.dp).background(card, PixelShape()).border(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = .5f), PixelShape()).padding(horizontal = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.Search, null, Modifier.size(19.dp), tint = muted)
                androidx.compose.foundation.text.BasicTextField(search, { search = it }, modifier = Modifier.weight(1f).padding(start = 8.dp), singleLine = true, textStyle = androidx.compose.ui.text.TextStyle(color = MaterialTheme.colorScheme.onSurface, fontSize = 14.sp), decorationBox = { field -> if(search.isBlank()) Text("搜索聊天", color = muted, fontSize = 14.sp); field() })
            }
            Button(onClick = { if(state.connected) state.sheet = "new" else state.sheet = "connections" }, enabled = !state.sharedDevice, colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.onSurface, contentColor = MaterialTheme.colorScheme.background), shape = PixelShape(), contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp)) {
                Icon(Icons.Outlined.EditNote, null, Modifier.size(22.dp)); Spacer(Modifier.width(6.dp)); Text("聊天", fontSize = 14.sp, fontWeight = FontWeight.Medium)
            }
        }
    }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).pixelBackground()) {
            if(state.notice.isNotBlank()) Row(Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(state.notice, modifier = Modifier.weight(1f), color = kkcodeColors.warning, fontSize = 12.sp, maxLines = 3)
                IconButton(onClick = { state.notice = "" }, modifier = Modifier.size(28.dp)) { Icon(Icons.Outlined.Close, null, Modifier.size(16.dp)) }
            }
            if(inChat) ChatScreen(state) else SessionHome(state, search, sort, archived)
        }
    }
    if(state.sheet.isNotBlank()) ModalBottomSheet(onDismissRequest = { state.sheet = "" }, containerColor = MaterialTheme.colorScheme.surface, shape = PixelShape(8.dp, bottomCorners = false), dragHandle = null, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().heightIn(max = (LocalConfiguration.current.screenHeightDp * .9f).dp).padding(horizontal = 16.dp).navigationBarsPadding()) {
            Row(Modifier.fillMaxWidth().padding(vertical = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                if(state.canGoBack) TextButton(onClick = { state.backSheet() }) { Text("返回", color = MaterialTheme.colorScheme.onSurface) } else Spacer(Modifier.width(56.dp))
                Text(when(state.sheet) { "connections" -> "远程控制"; "settings" -> "设置"; "profile" -> "个人资料"; "preferences" -> "工作偏好"; "add" -> "添加连接"; "relay" -> "中继网关"; "ssh" -> "SSH 连接"; "folders" -> "工作目录"; "extensions" -> "扩展"; "models" -> "模型渠道"; "model-picker" -> "选择模型"; "approval" -> "权限"; "provider" -> if(state.editingProvider.isBlank()) "添加渠道" else "编辑渠道"; "new" -> "新对话"; "mode" -> "执行模式"; "branches" -> "Git 分支"; "sessions" -> "选择会话"; "permission" -> "权限"; "keys" -> "操作指南"; "theme" -> "外观"; "command-result" -> "命令结果"; "device-ownership" -> "设备归属"; "updates" -> "应用更新"; else -> "高级配置" }, modifier = Modifier.weight(1f), fontSize = 16.sp, textAlign = androidx.compose.ui.text.style.TextAlign.Center, fontWeight = FontWeight.Medium)
                CircleButton(Icons.Outlined.Close, "关闭") { state.sheet = "" }
            }
            SheetContent(state)
        }
    }
    SessionManagementDialogs(state)
}

@Composable private fun SettingsSwitch(checked: Boolean, onCheckedChange: (Boolean) -> Unit, enabled: Boolean = true) {
    Switch(checked = checked, onCheckedChange = onCheckedChange, enabled = enabled, colors = SwitchDefaults.colors(checkedThumbColor = MaterialTheme.colorScheme.onSurface, checkedTrackColor = kkcodeColors.success, uncheckedThumbColor = MaterialTheme.colorScheme.onSurface, uncheckedTrackColor = kkcodeColors.switchTrackOff, uncheckedBorderColor = Color.Transparent))
}
@Composable private fun CircleButton(icon: ImageVector, label: String, onClick: () -> Unit) {
    IconButton(onClick, modifier = Modifier.size(42.dp).background(MaterialTheme.colorScheme.surfaceVariant, PixelShape(4.dp)).border(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = .6f), PixelShape(4.dp))) { Icon(icon, label, Modifier.size(22.dp)) }
}
@Composable private fun ComposerChip(icon: ImageVector, label: String, description: String, maxWidth: androidx.compose.ui.unit.Dp = 96.dp, onClick: () -> Unit) {
    Row(Modifier.padding(start = 6.dp).height(30.dp).background(MaterialTheme.colorScheme.onSurface.copy(alpha = .05f), PixelShape(3.dp)).border(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = .5f), PixelShape(3.dp)).clickable(onClick = onClick).padding(horizontal = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, description, Modifier.size(13.dp), tint = muted)
        Spacer(Modifier.width(5.dp))
        Text(label, color = MaterialTheme.colorScheme.onSurface, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = maxWidth))
    }
}
@Composable private fun SessionHome(state: RemoteState, search: String, sort: String, archived: Boolean) {
    var collapsed by remember { mutableStateOf(emptySet<String>()) }
    val filtered = state.sessions.filter { it.optBoolean("archived") == archived && (it.optString("title") + it.optString("cwd")).contains(search, true) }.sortedWith(compareByDescending<JSONObject> { sort == "priority" && it.optString("status").startsWith("running") }.thenByDescending { it.optLong("updatedAt", it.optLong("createdAt")) })
    val grouped = filtered.groupBy { item ->
        if(sort == "project") item.optString("cwd").split('/', '\\').lastOrNull().orEmpty().ifBlank { "其他项目" }
        else if(sort == "priority" && item.optString("status").startsWith("running")) "优先级"
        else {
            val date = Instant.ofEpochMilli(item.optLong("updatedAt")).atZone(ZoneId.systemDefault()).toLocalDate()
            val days = java.time.temporal.ChronoUnit.DAYS.between(date, LocalDate.now())
            when { days <= 0 -> "今天"; days == 1L -> "昨天"; days < 7 -> "过去 7 天"; days < 30 -> "过去 30 天"; else -> "更早" }
        }
    }
    if(filtered.isEmpty()) Box(Modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(Icons.Outlined.Forum, null, Modifier.size(30.dp), tint = kkcodeColors.activityMuted)
            Spacer(Modifier.height(16.dp)); Text(if(search.isNotBlank()) "没有找到相关对话" else if(archived) "没有已归档的对话" else if(state.connected) "还没有对话" else "你的对话，在这里继续", fontSize = 17.sp)
            Spacer(Modifier.height(8.dp)); Text(if(search.isNotBlank()) "试试其他关键词或项目名称。" else if(state.connected) "选择工作目录，开始新的聊天。" else "添加一台电脑，随时回到你的工作区。", color = muted, fontSize = 13.sp)
            if(!state.connected) TextButton(onClick = { state.sheet = "add" }, modifier = Modifier.padding(top = 12.dp)) { Text("添加连接", color = kkcodeColors.link, fontSize = 14.sp) }
        }
    } else LazyColumn(contentPadding = PaddingValues(horizontal = 20.dp, vertical = 16.dp)) {
        grouped.forEach { (group, list) ->
            item { TextButton(onClick = { collapsed = if(group in collapsed) collapsed - group else collapsed + group }, contentPadding = PaddingValues(0.dp)) { Text(group, color = MaterialTheme.colorScheme.onSurface, fontSize = 14.sp, fontWeight = FontWeight.Medium); Spacer(Modifier.width(7.dp)); Icon(if(group in collapsed) Icons.Outlined.ChevronRight else Icons.Outlined.ExpandMore, if(group in collapsed) "展开分组" else "收起分组", Modifier.size(14.dp), tint = muted) } }
            items(if(group in collapsed) emptyList() else list, key = { it.getString("id") }) { session ->
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f).clickable { state.openSession(session) }.padding(vertical = 14.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(session.optString("title").ifBlank { "新对话" }, modifier = Modifier.weight(1f), fontSize = 16.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if(session.optString("status").startsWith("running")) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 1.5.dp, color = muted)
                    }
                    Row(Modifier.padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Outlined.FolderOpen, null, Modifier.size(14.dp), tint = muted); Spacer(Modifier.width(5.dp))
                        Text(session.optString("cwd").split('/', '\\').lastOrNull() ?: "", modifier = Modifier.weight(1f), color = muted, fontSize = 12.sp, maxLines = 1)
                        val added = session.optInt("addedLines"); val removed = session.optInt("removedLines")
                        if(added + removed > 0) { Text("+$added ", color = kkcodeColors.diffAdd, fontSize = 11.sp); Text("−$removed", color = kkcodeColors.diffRemove, fontSize = 11.sp) }
                    }
                }
                if(!state.sharedDevice) IconButton(onClick = { state.managedSession = session }) { Icon(Icons.Outlined.MoreHoriz, "管理对话 ${session.optString("title", "新对话")}", tint = muted) }
                }
            }
        }
    }
}

@Composable internal fun Group(title: String = "", content: @Composable ColumnScope.() -> Unit) {
    if(title.isNotBlank()) Text(title, color = muted, fontSize = 13.sp, modifier = Modifier.padding(start = 12.dp, top = 26.dp, bottom = 9.dp))
    Column(Modifier.fillMaxWidth().background(card, PixelShape()).border(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = .45f), PixelShape()), content = content)
}
@Composable internal fun SettingsRow(icon: ImageVector, title: String, subtitle: String = "", onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 16.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, Modifier.size(21.dp)); Spacer(Modifier.width(12.dp)); Column(Modifier.weight(1f)) { Text(title, fontSize = 15.sp); if(subtitle.isNotBlank()) Text(subtitle, fontSize = 11.sp, color = muted, maxLines = 2) }; Icon(Icons.Outlined.ChevronRight, null, Modifier.size(18.dp), tint = muted)
    }
}
@Composable private fun SheetContent(state: RemoteState) {
    var sshHost by remember { mutableStateOf("") }; var sshPort by remember { mutableStateOf("22") }; var sshUser by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }; var privateKey by remember { mutableStateOf("") }; var keyMode by remember { mutableStateOf(true) }
    var providerName by remember { mutableStateOf("") }; var baseUrl by remember { mutableStateOf("") }; var apiKey by remember { mutableStateOf("") }; var providerModel by remember { mutableStateOf("") }
    var providerType by remember { mutableStateOf("openai") }
    LaunchedEffect(state.sheet, state.editingProvider) {
        if(state.sheet == "provider") {
            val source = state.settings.optJSONObject("provider")?.optJSONObject(state.editingProvider)
            providerName = state.editingProvider; baseUrl = source?.optString("base_url") ?: ""; apiKey = source?.optString("api_key") ?: ""; providerModel = source?.optString("default_model") ?: ""; providerType = source?.optString("type", "openai") ?: "openai"
        }
    }
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(bottom = 30.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        when(state.sheet) {
            "settings", "connections" -> {
                Group { SettingsRow(Icons.Outlined.AccountCircle, state.profile.optString("name", "个人资料"), state.profile.optString("organization")) { state.sheet = "profile" } }
                Group("连接") {
                    if(state.devices.isEmpty() && state.connected) SettingsRow(Icons.Outlined.Terminal, state.deviceName, "已连接 · SSH") { state.disconnect() }
                    state.devices.forEach { d -> Row(Modifier.padding(horizontal = 16.dp, vertical = 9.dp), verticalAlignment = Alignment.CenterVertically) { Icon(Icons.Outlined.Terminal, null, tint = muted); Spacer(Modifier.width(12.dp)); Column(Modifier.weight(1f)) { Text(d.optString("name"), fontSize = 15.sp); Text(if(d.optBoolean("online")) "● 在线" else "● 离线", fontSize = 11.sp, color = if(d.optBoolean("online")) connectedGreen else muted) }; SettingsSwitch(checked = state.api?.device == d.optString("id") && state.connected, onCheckedChange = { checked -> if(checked) state.action { state.chooseDevice(d) } else state.disconnect() }, enabled = d.optBoolean("online")) } }
                    SettingsRow(Icons.Outlined.Add, "添加连接") { state.sheet = "add" }
                }
                Group("启动") { Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) { Text("自动恢复远程连接", Modifier.weight(1f), fontSize = 15.sp); SettingsSwitch(state.autoConnect, { state.preference("autoConnect", it) }) } }
                Text("启动后恢复上次连接，配置保持收起。", color = muted, fontSize = 11.sp, modifier = Modifier.padding(12.dp))
                if(state.connected && !state.sharedDevice) Group("工作区") {
                    SettingsRow(Icons.Outlined.FolderOpen, "工作目录", state.cwd) { state.browse() }
                    SettingsRow(Icons.Outlined.Tune, "模型与渠道") { state.sheet = "models" }
                    SettingsRow(Icons.Outlined.Extension, "MCP、Skills 与插件") { state.loadExtensions() }
                    SettingsRow(Icons.Outlined.Shield, "执行模式", modeLabel(state.mode)) { state.sheet = "mode" }
                }
                Group("编写器") { Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) { Text("显示模式与模型", Modifier.weight(1f), fontSize = 15.sp); SettingsSwitch(state.showContext, { state.preference("showContext", it) }) } }
                Group("外观") { SettingsRow(Icons.Outlined.Palette, "主题", state.appearance) { state.sheet = "theme" } }
            }
            "profile" -> {
                Column(Modifier.fillMaxWidth().padding(vertical = 24.dp), horizontalAlignment = Alignment.CenterHorizontally) { Box(Modifier.size(64.dp).background(kkcodeColors.avatar, CircleShape), contentAlignment = Alignment.Center) { Text(state.profile.optString("name", "K").take(1).uppercase(), fontSize = 27.sp) }; Spacer(Modifier.height(12.dp)); Text(state.profile.optString("name", "尚未登录"), fontSize = 19.sp, fontWeight = FontWeight.Medium); Text(state.profile.optString("organization"), color = muted, fontSize = 12.sp) }
                Group("账户") { SettingsRow(Icons.Outlined.Email, "电子邮件", state.profile.optString("email", "—")) {}; SettingsRow(Icons.Outlined.Business, "组织", state.profile.optString("organization", "个人")) {}; SettingsRow(Icons.Outlined.Link, "远程网关", state.gateway.ifBlank { "未配置" }) { state.sheet = "relay" } }
                if(!state.sharedDevice) Group("设备配置") { SettingsRow(Icons.Outlined.Extension, "扩展") { if(state.connected) state.loadExtensions() else state.sheet = "connections" }; SettingsRow(Icons.Outlined.Tune, "模型与渠道") { if(state.connected) state.sheet = "models" else state.sheet = "connections" } }
                if(state.connected && !state.sharedDevice) Group { SettingsRow(Icons.Outlined.ManageAccounts, "设备解绑与账号转移", "需要在被控电脑的终端确认") { state.sheet = "device-ownership" }; SettingsRow(Icons.Outlined.PersonOutline, "工作偏好") { state.action { state.profilePreferences = state.rpc("profile.get") as JSONObject; state.sheet = "preferences" } } }
                TextButton(onClick = { state.logout() }, modifier = Modifier.fillMaxWidth().padding(top = 24.dp)) { Text("退出登录", color = kkcodeColors.danger) }
                Text("KK Code ${BuildConfig.VERSION_NAME} · 检查更新", color = muted, fontSize = 11.sp, modifier = Modifier.align(Alignment.CenterHorizontally).clickable { state.sheet = "updates" }.padding(12.dp))
            }
            "add" -> {
                Text("选择连接方式", color = muted, fontSize = 13.sp, modifier = Modifier.padding(12.dp))
                Group { SettingsRow(Icons.Outlined.CloudQueue, "Remote 中继", "通过组织网关登录，无需开放电脑端口") { state.sheet = "relay" }; SettingsRow(Icons.Outlined.Terminal, "SSH", "使用电脑的 SSH 服务建立加密连接") { state.sheet = "ssh" } }
            }
            "relay" -> {
                Text("填写网关地址即可。统一身份登录由网关引导。", color = muted, fontSize = 13.sp, modifier = Modifier.padding(vertical = 12.dp))
                OutlinedTextField(state.gateway, { state.gateway = it }, enabled = !state.loading && state.loginCode.isBlank(), label = { Text("网关地址") }, placeholder = { Text("https://remote.example.com") }, singleLine = true, modifier = Modifier.fillMaxWidth(), shape = PixelShape(4.dp))
                Button(onClick = { state.login() }, enabled = !state.loading && state.gateway.isNotBlank(), modifier = Modifier.fillMaxWidth().padding(top = 14.dp)) { Text(if(state.loading) "等待浏览器确认…" else "继续登录") }
                if(state.loginCode.isNotBlank()) {
                    Text("登录码 ${state.loginCode} · 授权后返回本 App 即可", color = muted, fontSize = 13.sp, modifier = Modifier.padding(12.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        TextButton(onClick = { state.reopenLoginBrowser() }) { Text("重新打开浏览器") }
                        TextButton(onClick = { state.cancelLogin() }) { Text("取消登录") }
                    }
                }
            }
            "ssh" -> {
                Text("电脑需已安装支持远程协议的 KK Code（建议 ${BuildConfig.VERSION_NAME}）。连接过程中会核对主机指纹。", color = muted, fontSize = 12.sp, modifier = Modifier.padding(vertical = 12.dp))
                OutlinedTextField(sshHost, { sshHost = it }, label = { Text("主机地址") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { OutlinedTextField(sshUser, { sshUser = it }, label = { Text("用户名") }, modifier = Modifier.weight(2f), singleLine = true); OutlinedTextField(sshPort, { sshPort = it }, label = { Text("端口") }, modifier = Modifier.weight(1f), singleLine = true) }
                Row(verticalAlignment = Alignment.CenterVertically) { Text("使用私钥", Modifier.weight(1f), fontSize = 14.sp); SettingsSwitch(keyMode, { keyMode = it }) }
                if(keyMode) OutlinedTextField(privateKey, { privateKey = it }, label = { Text("私钥") }, maxLines = 4, modifier = Modifier.fillMaxWidth(), visualTransformation = PasswordVisualTransformation())
                OutlinedTextField(password, { password = it }, label = { Text(if(keyMode) "私钥口令（可选）" else "密码") }, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(), singleLine = true)
                if(state.fingerprint.isNotBlank()) Group("核对主机指纹") { Text(state.fingerprint, fontSize = 11.sp, modifier = Modifier.padding(14.dp)); TextButton(onClick = { state.vault.put("ssh:$sshHost:$sshPort", state.fingerprint); state.fingerprint = "" }) { Text("确认并信任此指纹") } }
                Button(onClick = { state.connectSsh(sshHost, sshPort, sshUser, password, if(keyMode) privateKey else "") }, enabled = !state.loading, modifier = Modifier.fillMaxWidth().padding(top = 12.dp)) { Text(if(state.loading) "连接中…" else "连接电脑") }
            }
            "new" -> { Group { SettingsRow(Icons.Outlined.Terminal, state.deviceName) { state.sheet = "connections" }; SettingsRow(Icons.Outlined.FolderOpen, "工作目录", state.cwd) { state.browse() }; SettingsRow(Icons.Outlined.Tune, "模式", state.mode) { state.sheet = "mode" } }; Button(onClick = { state.newChat() }, modifier = Modifier.fillMaxWidth().padding(top = 20.dp)) { Text("开始对话") } }
            "folders" -> {
                Text(state.cwd, color = muted, fontSize = 12.sp, modifier = Modifier.padding(12.dp))
                Row { TextButton(onClick = { state.browse(state.cwd.substringBeforeLast('/').ifBlank { state.cwd }) }) { Text("上一级") }; TextButton(onClick = { state.sheet = "new" }) { Text("选择此目录") } }
                Group { state.folders.filter { it.optBoolean("directory") }.forEach { folder -> SettingsRow(Icons.Outlined.FolderOpen, folder.optString("name")) { state.browse(folder.getString("path")) } } }
            }
            "mode", "permission", "approval" -> {
                Text("模式同时决定执行与审批。Auto 审查不确定时交给你确认；所有模式遵守设备和组织的硬性安全边界。", color = muted, fontSize = 12.sp, modifier = Modifier.padding(12.dp))
                Group { MODE_CHOICES.forEach { choice -> SettingsRow(if(state.mode == choice.id) Icons.Outlined.Check else Icons.Outlined.Tune, choice.label, choice.description) { state.selectMode(choice.id) } } }
            }
            "models" -> {
                val providers = state.settings.optJSONObject("provider") ?: JSONObject()
                Group("已配置渠道") { configuredProviderNames(providers).forEach { name -> val p = providers.getJSONObject(name); SettingsRow(Icons.Outlined.Hub, name, p.optString("default_model")) { state.discoverModels(name) }; TextButton(onClick = { state.editingProvider = name; state.sheet = "provider" }) { Text("编辑 $name", fontSize = 11.sp) } } }
                if(state.modelOptions.isNotEmpty()) Group("${state.catalogProvider} · 模型目录") { state.modelOptions.forEach { model -> SettingsRow(Icons.Outlined.CloudQueue, model.getString("id")) { state.selectModel(state.catalogProvider, model.getString("id")) } } }
                if(state.catalogError.isNotBlank() && state.catalogProvider.isNotBlank()) Text("无法读取 ${state.catalogProvider} 的模型目录：${state.catalogError}", color = kkcodeColors.warning, fontSize = 12.sp, modifier = Modifier.padding(12.dp))
                Group { SettingsRow(Icons.Outlined.Add, "添加渠道") { state.editingProvider = ""; state.sheet = "provider" } }
                Text("API Key 不在列表中展示，模型配置保存在电脑上。", color = muted, fontSize = 12.sp, modifier = Modifier.padding(12.dp))
            }
            "model-picker" -> ModelPicker(state)
            "provider" -> {
                Text("选择协议，使用 Base URL 读取可用模型。", color = muted, fontSize = 13.sp, modifier = Modifier.padding(top = 12.dp, bottom = 8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { listOf("openai" to "OpenAI", "anthropic" to "Anthropic").forEach { (value, label) -> FilterChip(selected = providerType == value, onClick = { providerType = value }, label = { Text(label) }) } }
                OutlinedTextField(providerName, { providerName = it }, label = { Text("名称") }, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(baseUrl, { baseUrl = it }, label = { Text("Base URL") }, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(apiKey, { apiKey = it }, label = { Text("API Key") }, modifier = Modifier.fillMaxWidth(), visualTransformation = PasswordVisualTransformation())
                OutlinedTextField(providerModel, { providerModel = it }, label = { Text("模型") }, modifier = Modifier.fillMaxWidth())
                TextButton(onClick = { state.action { val result = state.rpc("models.discover", JSONObject().put("connection", JSONObject().put("type", providerType).put("base_url", baseUrl).put("api_key", apiKey))) as JSONObject; state.modelOptions = result.optJSONArray("models").objects(); if(providerModel.isBlank()) providerModel = state.modelOptions.firstOrNull()?.optString("id") ?: "" } }) { Text("读取模型列表") }
                state.modelOptions.forEach { model -> TextButton(onClick = { providerModel = model.getString("id") }) { Text(model.getString("id"), fontSize = 12.sp) } }
                Button(onClick = { state.saveProvider(providerName, providerType, baseUrl, apiKey, providerModel) }, modifier = Modifier.fillMaxWidth()) { Text("保存到电脑") }
            }
            "extensions" -> { TextButton(onClick = { state.action { state.extensions = state.rpc("extensions.reload") as JSONObject } }) { Text("刷新目录") }; listOf("skills", "plugins", "mcp").forEach { kind -> Group(kind) { state.extensions.optJSONArray(kind).objects().forEach { item -> var expanded by remember { mutableStateOf(false) }; SettingsRow(Icons.Outlined.Extension, item.optString("name", item.optString("server"))) { expanded = !expanded }; if(expanded) Text(item.optString("description", item.optString("error", "可用")), color = muted, fontSize = 12.sp, modifier = Modifier.padding(16.dp)) } } } }
            "branches" -> BranchPicker(state)
            "preferences" -> PreferencesForm(state)
            "sessions" -> Group { state.sessions.forEach { session -> SettingsRow(Icons.Outlined.ChatBubbleOutline, session.optString("title", "新对话"), session.optString("cwd")) { state.openSession(session) } } }
            "theme" -> Group { listOf("dark" to "深色", "light" to "浅色", "auto" to "跟随系统").forEach { (id, label) -> SettingsRow(if(state.appearance == id) Icons.Outlined.Check else Icons.Outlined.Palette, label) { state.updateAppearance(id) } } }
            "command-result" -> state.commandPanels.forEach { panel -> Group(panel.optString("title")) { androidx.compose.foundation.text.selection.SelectionContainer { Text(panel.optString("text"), modifier = Modifier.padding(14.dp)) } } }
            "device-ownership" -> DeviceOwnership(state.api?.device ?: "")
            "updates" -> UpdateSheet(state.updater)
        }
        if(state.notice.isNotBlank()) Text(state.notice, color = kkcodeColors.warning, fontSize = 12.sp, modifier = Modifier.padding(12.dp))
    }
}

@Composable private fun ChatScreen(state: RemoteState) {
    val text = state.draft
    val messageColor = MaterialTheme.colorScheme.onSurface.toArgb()
    var actions by remember { mutableStateOf(false) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> if(uri != null) state.attach(uri) }
    LaunchedEffect(state.attachmentPickerRequest) { if(state.attachmentPickerRequest > 0) picker.launch(arrayOf("image/png", "image/jpeg", "image/gif", "image/webp", "audio/wav", "audio/mpeg", "video/mp4", "video/quicktime", "video/webm", "video/mpeg", "text/*", "application/json", "application/xml", "application/yaml")) }
    val listState = rememberLazyListState()
    LaunchedEffect(state.messages.size, state.messages.lastOrNull()?.text?.length) {
        if(state.messages.isNotEmpty() && (listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0) >= state.messages.size - 3) listState.animateScrollToItem(state.messages.lastIndex)
    }
    Column(Modifier.fillMaxSize().imePadding()) {
        LazyColumn(Modifier.weight(1f), state = listState, contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp)) {
            if(state.historyHasMore) item(key = "load-earlier") { TextButton(onClick = { state.loadEarlier() }, enabled = !state.loadingHistory, modifier = Modifier.fillMaxWidth()) { Text(if(state.loadingHistory) "正在加载…" else "加载更早的消息", fontSize = 12.sp) } }
            items(state.messages, key = { it.id }) { item ->
                Column(Modifier.fillMaxWidth().padding(vertical = if(item.kind in listOf("tool", "thinking")) 0.dp else 10.dp), horizontalAlignment = if(item.kind == "user") Alignment.End else Alignment.Start) {
                    when(item.kind) {
                        "user" -> {
                            Text(item.text, modifier = Modifier.widthIn(max = 310.dp).background(card, PixelShape()).padding(14.dp), fontSize = 15.sp, lineHeight = 23.sp)
                            if(item.messageId.isNotBlank() && !state.sharedDevice && !state.busy && !state.sessionArchived) TextButton(onClick = { state.rewindTarget = item }, contentPadding = PaddingValues(horizontal = 6.dp)) { Icon(Icons.Outlined.Undo, null, Modifier.size(13.dp), tint = muted); Text("回退", color = muted, fontSize = 11.sp) }
                        }
                        "media" -> MediaPreview(item, state)
                        "assistant" -> AndroidView(factory = { context -> TextView(context).apply { textSize = 15f; setLineSpacing(5f, 1.12f); setTextIsSelectable(true); tag = Markwon.create(context) } }, update = { view -> view.setTextColor(messageColor); (view.tag as Markwon).setMarkdown(view, item.text) }, modifier = Modifier.fillMaxWidth())
                        "compacted" -> Row(Modifier.fillMaxWidth().padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) { HorizontalDivider(Modifier.weight(1f), color = card); Text("已精简上下文", fontSize = 10.sp, color = muted); HorizontalDivider(Modifier.weight(1f), color = card) }
                        else -> ActivityRow(item)
                    }
                }
            }
            if(state.busy && state.messages.none { it.kind == "thinking" && !it.done }) item { Row(verticalAlignment = Alignment.CenterVertically) { CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 1.5.dp, color = muted); Text("  Thinking…", color = muted, fontSize = 12.sp) } }
            items(state.approvals, key = { it.getString("id") }) { a ->
                Group("需要你的确认") {
                    val request = a.optJSONObject("request") ?: JSONObject()
                    val source = request.optString("sourceLabel", request.optString("sourceSessionId", request.optString("originSessionId")))
                    if(source.isNotBlank() && source != state.selected) Text("子代理 · $source", color = muted, fontSize = 11.sp, modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp))
                    Text(a.optJSONObject("request")?.optString("tool", "问题") ?: "问题", fontSize = 14.sp, modifier = Modifier.padding(14.dp))
                    if(!state.canControl) Text("正在等待有控制权限的用户确认", color = muted, modifier = Modifier.padding(12.dp))
                    else if(a.optString("kind") == "permission") Row { TextButton(onClick = { state.answer(a.getString("id"), "allow_once") }) { Text("允许本次") }; TextButton(onClick = { state.answer(a.getString("id"), "deny") }) { Text("拒绝") } }
                    else QuestionForm(a.getString("id"), a.optJSONObject("request") ?: JSONObject()) { state.answer(a.getString("id"), it) }
                }
            }
        }
        if(state.controlElsewhere) Row(Modifier.padding(horizontal = 20.dp), verticalAlignment = Alignment.CenterVertically) { Text("另一客户端正在控制", fontSize = 11.sp, color = muted, modifier = Modifier.weight(1f)); if(!state.sharedDevice) TextButton(onClick = { state.takeControl() }) { Text("接管控制", fontSize = 11.sp) } }
        ChangeSummary(state.messages)
        if(text.startsWith('/') && !text.contains(' ')) {
            val query = text.removePrefix("/")
            val suggestions = state.commands.filter { (it.optString("name") + " " + it.optString("description")).contains(query, ignoreCase = true) }.sortedBy { if(it.optString("name").startsWith(query, ignoreCase = true)) 0 else 1 }.take(12)
            if(suggestions.isNotEmpty()) Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp).heightIn(max = 190.dp).background(card, PixelShape()).verticalScroll(rememberScrollState()).padding(6.dp)) {
                suggestions.forEach { command -> Row(Modifier.fillMaxWidth().clickable { state.draft = "/${command.getString("name")} " }.padding(horizontal = 12.dp, vertical = 9.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.Terminal, null, Modifier.size(18.dp), tint = muted); Spacer(Modifier.width(10.dp)); Column(Modifier.weight(1f)) { Text("/${command.getString("name")}", fontSize = 14.sp); Text(command.optString("description"), color = muted, fontSize = 10.sp, maxLines = 1, overflow = TextOverflow.Ellipsis) }; Text("命令", color = muted, fontSize = 10.sp)
                } }
            }
        }
        Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp).navigationBarsPadding().background(card, PixelShape()).border(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = .6f), PixelShape()).padding(12.dp)) {
            if(state.attachments.isNotEmpty()) Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) { state.attachments.forEach { attachment -> InputChip(selected = true, onClick = { state.removeAttachment(attachment.getString("id")) }, label = { Text(attachment.optString("name"), maxLines = 1) }, trailingIcon = { Icon(Icons.Outlined.Close, "移除附件 ${attachment.optString("name")}", Modifier.size(14.dp)) }) } }
            if(state.uploading) Text("正在上传附件…", color = muted, fontSize = 11.sp)
            androidx.compose.foundation.text.BasicTextField(text, { state.draft = it }, enabled = state.canControl && !state.sessionArchived, modifier = Modifier.fillMaxWidth().heightIn(min = 38.dp, max = 130.dp).padding(4.dp), textStyle = androidx.compose.ui.text.TextStyle(color = MaterialTheme.colorScheme.onSurface, fontSize = 15.sp), decorationBox = { inner -> if(text.isBlank()) Text(if(state.sessionArchived) "恢复归档后继续对话" else if(state.canControl) "发消息，或输入 / 命令" else "只读共享会话", color = muted, fontSize = 14.sp); inner() })
            Row(verticalAlignment = Alignment.CenterVertically) {
                if(!state.sharedDevice) Box {
                    IconButton(onClick = { actions = !actions }, Modifier.size(36.dp)) { Icon(Icons.Outlined.Add, "添加与工具", Modifier.size(22.dp)) }
                    DropdownMenu(actions, { actions = false }, containerColor = card, shape = PixelShape()) {
                        DropdownMenuItem(text = { Text("文件或图片", fontSize = 14.sp) }, leadingIcon = { Icon(Icons.Outlined.AttachFile, null) }, enabled = !state.uploading && state.attachments.size < 8, onClick = { actions = false; state.attachmentPickerRequest++ })
                        DropdownMenuItem(text = { Text("Git 分支", fontSize = 14.sp) }, leadingIcon = { Icon(Icons.Outlined.AccountTree, null) }, onClick = { actions = false; state.loadBranches() })
                        DropdownMenuItem(text = { Text("执行模式", fontSize = 14.sp) }, leadingIcon = { Icon(Icons.Outlined.Shield, null) }, onClick = { actions = false; state.sheet = "mode" })
                        DropdownMenuItem(text = { Text("工作目录", fontSize = 14.sp) }, leadingIcon = { Icon(Icons.Outlined.FolderOpen, null) }, onClick = { actions = false; state.browse() })
                        DropdownMenuItem(text = { Text("模型与渠道", fontSize = 14.sp) }, leadingIcon = { Icon(Icons.Outlined.CloudQueue, null) }, onClick = { actions = false; state.action { state.settings = state.rpc("settings.get") as JSONObject; state.sheet = "models" } })
                        DropdownMenuItem(text = { Text("MCP、Skills 与插件", fontSize = 14.sp) }, leadingIcon = { Icon(Icons.Outlined.Extension, null) }, onClick = { actions = false; state.loadExtensions() })
                    }
                }
                if(state.showContext && !state.sharedDevice) {
                    ComposerChip(Icons.Outlined.Shield, modeLabel(state.mode), "执行模式") { state.sheet = "mode" }
                    ComposerChip(Icons.Outlined.CloudQueue, state.modelLabel, "模型", maxWidth = 120.dp) { state.openModelPicker() }
                }
                Spacer(Modifier.weight(1f))
                IconButton(onClick = { if(state.busy) state.stop() else if(text.isNotBlank() || state.attachments.isNotEmpty()) state.send(text) }, enabled = state.canControl && !state.uploading && !state.sessionArchived, modifier = Modifier.size(34.dp).background(MaterialTheme.colorScheme.onSurface, PixelShape(3.dp))) { Icon(if(state.busy) Icons.Outlined.Stop else Icons.Outlined.ArrowUpward, if(state.busy) "停止" else "发送", Modifier.size(21.dp), tint = MaterialTheme.colorScheme.background) }
            }
        }
    }
}

@Composable internal fun QuestionForm(approvalId: String, request: JSONObject, onAnswer: (JSONObject) -> Unit) {
    var answers by remember(approvalId) { mutableStateOf(mapOf<String, String>()) }
    val questions = request.optJSONArray("questions").objects()
    Column(Modifier.padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        questions.forEach { question ->
            val id = question.getString("id")
            Text(question.optString("text", question.optString("header", id)), fontSize = 14.sp)
            val options = question.optJSONArray("options").objects()
            options.forEach { option ->
                val value = option.optString("value", option.optString("label"))
                val multi = question.optBoolean("multi")
                val selected = if(multi) (answers[id] ?: "").split(", ").contains(value) else answers[id] == value
                val select = {
                    val next = if(multi) (answers[id] ?: "").split(", ").filter { it.isNotBlank() }.toMutableSet().apply { if(selected) remove(value) else add(value) }.joinToString(", ") else value
                    answers = answers + (id to next)
                }
                Row(Modifier.fillMaxWidth().clickable(onClick = select), verticalAlignment = Alignment.CenterVertically) {
                    if(multi) Checkbox(selected, { select() }) else RadioButton(selected, select)
                    Column { Text(option.optString("label", value), fontSize = 13.sp); if(option.optString("description").isNotBlank()) Text(option.getString("description"), fontSize = 11.sp, color = muted) }
                }
            }
            if(options.isEmpty() || question.optBoolean("allowCustom")) OutlinedTextField(answers[id] ?: "", { answers = answers + (id to it) }, label = { Text("自定义回答") }, modifier = Modifier.fillMaxWidth())
        }
        TextButton(enabled = questions.isNotEmpty() && questions.all { !answers[it.getString("id")].isNullOrBlank() }, onClick = { onAnswer(JSONObject(answers)) }) { Text("提交回答") }
    }
}
