package cn.kkcode.remote

import android.app.Application
import android.content.SharedPreferences
import kotlinx.coroutines.Job

internal class MemorySharedPreferences : SharedPreferences {
    private val values = mutableMapOf<String, Any?>()
    override fun getAll(): MutableMap<String, *> = values
    override fun getString(key: String?, defValue: String?): String? = values[key] as? String ?: defValue
    @Suppress("UNCHECKED_CAST")
    override fun getStringSet(key: String?, defValues: MutableSet<String>?): MutableSet<String>? = (values[key] as? MutableSet<String>) ?: defValues
    override fun getInt(key: String?, defValue: Int): Int = (values[key] as? Number)?.toInt() ?: defValue
    override fun getLong(key: String?, defValue: Long): Long = (values[key] as? Number)?.toLong() ?: defValue
    override fun getFloat(key: String?, defValue: Float): Float = (values[key] as? Number)?.toFloat() ?: defValue
    override fun getBoolean(key: String?, defValue: Boolean): Boolean = values[key] as? Boolean ?: defValue
    override fun contains(key: String?): Boolean = values.containsKey(key)
    override fun edit(): SharedPreferences.Editor = Editor()
    override fun registerOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit
    override fun unregisterOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit

    private inner class Editor : SharedPreferences.Editor {
        private val updates = mutableMapOf<String, Any?>()
        private val removals = mutableSetOf<String?>()
        private var clearAll = false
        override fun putString(key: String?, value: String?): SharedPreferences.Editor = apply { updates[key] = value }
        override fun putStringSet(key: String?, values: MutableSet<String>?): SharedPreferences.Editor = apply { updates[key] = values?.toMutableSet() }
        override fun putInt(key: String?, value: Int): SharedPreferences.Editor = apply { updates[key] = value }
        override fun putLong(key: String?, value: Long): SharedPreferences.Editor = apply { updates[key] = value }
        override fun putFloat(key: String?, value: Float): SharedPreferences.Editor = apply { updates[key] = value }
        override fun putBoolean(key: String?, value: Boolean): SharedPreferences.Editor = apply { updates[key] = value }
        override fun remove(key: String?): SharedPreferences.Editor = apply { updates.remove(key); removals += key }
        override fun clear(): SharedPreferences.Editor = apply { clearAll = true }
        override fun commit(): Boolean {
            if(clearAll) values.clear()
            removals.forEach { values.remove(it) }
            values.putAll(updates)
            clearAll = false; removals.clear(); updates.clear()
            return true
        }
        override fun apply() { commit() }
    }
}

internal class RemoteStateTestApplication private constructor() : Application() {
    private var preferences: MemorySharedPreferences? = null
    override fun getSharedPreferences(name: String, mode: Int): SharedPreferences = preferences ?: MemorySharedPreferences().also { preferences = it }

    companion object {
        fun create(): RemoteStateTestApplication {
            val field = sun.misc.Unsafe::class.java.getDeclaredField("theUnsafe").apply { isAccessible = true }
            val unsafe = field.get(null) as sun.misc.Unsafe
            return unsafe.allocateInstance(RemoteStateTestApplication::class.java) as RemoteStateTestApplication
        }
    }
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
