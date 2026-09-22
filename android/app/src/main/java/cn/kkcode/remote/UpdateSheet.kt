package cn.kkcode.remote

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.text.DateFormat
import java.util.Date

@Composable internal fun UpdateSheet(updater: AppUpdater) {
    val context = LocalContext.current
    Text("KK Code ${updater.currentVersion}", fontSize = 20.sp, modifier = Modifier.padding(vertical = 12.dp))
    Text("更新源：官方 GitHub · kkelly-offical/kkcode", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 12.sp)
    Row(Modifier.fillMaxWidth().padding(vertical = 12.dp)) {
        UpdateChannel.entries.forEach { channel ->
            FilterChip(selected = updater.channel == channel, onClick = { updater.selectChannel(channel) }, label = { Text(channel.label) }, enabled = !updater.working, modifier = Modifier.padding(end = 10.dp))
        }
    }
    Text("稳定版只接收正式发布；预览版也会接收更新的稳定版。仅检查此 Android App，不会更新网关或被控电脑。", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    if(updater.checkedAt > 0) Text("上次检查：${DateFormat.getDateTimeInstance().format(Date(updater.checkedAt))}", fontSize = 11.sp, modifier = Modifier.padding(top = 10.dp))
    if(updater.message.isNotBlank()) Text(updater.message, fontSize = 14.sp, modifier = Modifier.padding(vertical = 12.dp), color = if(updater.phase == UpdatePhase.ERROR) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface)
    if(updater.phase == UpdatePhase.CHECKING) LinearProgressIndicator(Modifier.fillMaxWidth())
    if(updater.phase == UpdatePhase.DOWNLOADING) { LinearProgressIndicator(progress = { updater.progress / 100f }, modifier = Modifier.fillMaxWidth()); Text("${updater.progress}%", fontSize = 12.sp) }
    updater.candidate?.takeIf { updater.hasUpdate }?.let { update ->
        Text("${update.versionName} · ${"%.1f".format(update.size / 1048576.0)} MiB", modifier = Modifier.padding(top = 16.dp), fontSize = 16.sp)
        Text(update.notes.ifBlank { "此版本未附更新说明。" }, fontSize = 13.sp, lineHeight = 21.sp, modifier = Modifier.padding(vertical = 12.dp))
    }
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(vertical = 12.dp)) {
        when(updater.phase) {
            UpdatePhase.DOWNLOADING, UpdatePhase.CHECKING -> OutlinedButton(onClick = { updater.cancel() }) { Text("取消") }
            UpdatePhase.READY, UpdatePhase.PERMISSION -> Button(onClick = { updater.install(context) }) { Text("安装更新") }
            UpdatePhase.INSTALLING -> Button(onClick = {}, enabled = false) { Text("等待系统安装") }
            else -> {
                OutlinedButton(onClick = { updater.check(true) }) { Text("检查更新") }
                if(updater.hasUpdate) Button(onClick = { updater.download() }) { Text("下载更新") }
            }
        }
    }
    Text("下载后会核对包名、版本和正式签名。安装需系统授权与确认，正常覆盖升级不清除连接配置。检查失败不会阻止继续使用。", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
}
