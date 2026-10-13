package cn.kkcode.remote

import android.app.Application
import kotlinx.coroutines.Job

internal object RemoteStateTestApplication {
    fun create(): Application = org.robolectric.RuntimeEnvironment.getApplication()
}

internal class MemoryRemoteStateVault : RemoteStateVault {
    val values = mutableMapOf<String, String>()
    override fun put(name: String, value: String, durable: Boolean) { values[name] = value }
    override fun get(name: String): String? = values[name]
    override fun clear(name: String, durable: Boolean) { values.remove(name) }
    override fun completeLogin(gateway: String, credentials: String) {
        values["gateway"] = gateway; values["credentials"] = credentials; values.remove(PENDING_LOGIN_KEY)
    }
}

internal fun RemoteState.jobIsActiveForTest(name: String): Boolean {
    val field = RemoteState::class.java.getDeclaredField(name).apply { isAccessible = true }
    return (field.get(this) as? Job)?.isActive == true
}

internal fun RemoteState.manualDisconnectForTest(): Boolean {
    val field = RemoteState::class.java.getDeclaredField("manualDisconnect").apply { isAccessible = true }
    return field.getBoolean(this)
}
