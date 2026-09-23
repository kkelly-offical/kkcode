package cn.kkcode.remote

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@Composable internal fun DeviceStrip(state: RemoteState) {
    if(state.devices.size + state.sshProfiles.size < 2) return
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        state.devices.forEach { device -> FilterChip(selected = state.selectedSsh.isBlank() && state.api?.device == device.optString("id"), onClick = { state.action { state.chooseDevice(device) } }, enabled = device.optBoolean("online") && !state.loading, label = { Text(device.optString("name") + " · 网关") }) }
        state.sshProfiles.forEach { device -> FilterChip(selected = state.selectedSsh == device.optString("id"), onClick = { state.chooseSsh(device) }, enabled = !state.loading, label = { Text(device.optString("name") + " · SSH") }) }
    }
}
