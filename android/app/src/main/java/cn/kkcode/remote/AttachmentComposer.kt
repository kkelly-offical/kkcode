package cn.kkcode.remote

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.Image
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.content.ReceiveContentListener
import androidx.compose.foundation.content.contentReceiver
import androidx.compose.foundation.content.consume
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.input.rememberTextFieldState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AttachFile
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

@OptIn(ExperimentalFoundationApi::class)
@Composable internal fun AttachmentMessageInput(state: RemoteState) {
    val input = rememberTextFieldState(state.draft)
    LaunchedEffect(state.draft) {
        if(input.text.toString() != state.draft) input.edit { replace(0, length, state.draft) }
    }
    LaunchedEffect(input) { snapshotFlow { input.text.toString() }.collect { state.draft = it } }
    val receiver = remember(state) { ReceiveContentListener { content ->
        content.consume { item ->
            val uri = item.uri
            if(uri?.scheme == "content" && state.canControl && !state.sessionArchived) { state.attach(uri); true } else false
        }
    } }
    BasicTextField(state = input, enabled = state.canControl && !state.sessionArchived,
        modifier = Modifier.contentReceiver(receiver).fillMaxWidth().heightIn(min = 38.dp, max = 130.dp).padding(4.dp),
        textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
        decorator = { inner ->
            Box { if(input.text.isEmpty()) Text(if(state.sessionArchived) "恢复归档后继续对话" else if(state.canControl) "发消息，或粘贴图片与文件" else "只读共享会话", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 15.sp); inner() }
        })
}

@Composable internal fun AttachmentDrafts(state: RemoteState) {
    if(state.attachments.isEmpty()) return
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(bottom = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        state.attachments.forEach { attachment ->
            val preview = attachment.optString("preview")
            val bitmap by produceState<androidx.compose.ui.graphics.ImageBitmap?>(null, attachment.optString("id")) {
                if(preview.isNotEmpty()) value = withContext(Dispatchers.IO) {
                    runCatching {
                        val bytes = Base64.decode(preview, Base64.NO_WRAP)
                        val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
                        options.inSampleSize = (maxOf(options.outWidth, options.outHeight) / 128).coerceAtLeast(1)
                        options.inJustDecodeBounds = false
                        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)?.asImageBitmap()
                    }.getOrNull()
                }
            }
            Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.width(245.dp)) {
                Row(Modifier.padding(10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if(bitmap != null) Image(bitmap!!, attachment.optString("name"), Modifier.size(44.dp)) else Icon(Icons.Outlined.AttachFile, null, Modifier.size(24.dp))
                    Column(Modifier.weight(1f)) {
                        Text(attachment.optString("name"), maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 13.sp)
                        Text("${(attachment.optLong("size") / 1024).coerceAtLeast(1)} KB · 待发送", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    IconButton(onClick = { state.removeAttachment(attachment.getString("id")) }, enabled = !state.uploading && state.canControl, modifier = Modifier.size(28.dp)) { Icon(Icons.Outlined.Close, "移除附件 ${attachment.optString("name")}", Modifier.size(16.dp)) }
                }
            }
        }
    }
}
