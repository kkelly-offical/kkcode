package cn.kkcode.remote

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class CredentialVault(context: Context) {
    private val prefs = context.getSharedPreferences("kkcode.secure", Context.MODE_PRIVATE)
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey("kkcode.remote", null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("kkcode.remote", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    private fun encrypt(value: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val bytes = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(bytes, Base64.NO_WRAP)
    }
    fun put(name: String, value: String, durable: Boolean = false) {
        val edit = prefs.edit().putString(name, encrypt(value))
        if(durable) check(edit.commit()) { "无法安全保存登录进度" } else edit.apply()
    }
    fun completeLogin(gateway: String, credentials: String) {
        // Commit credentials and removal of the one-shot pending grant together.
        check(prefs.edit().putString("gateway", encrypt(gateway)).putString("credentials", encrypt(credentials))
            .remove(PENDING_LOGIN_KEY).commit()) { "无法安全保存登录凭据" }
    }
    fun get(name: String): String? = runCatching {
        val raw = prefs.getString(name, null) ?: return null
        val bytes = Base64.decode(raw, Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12))) }
        String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)
    }.getOrNull()
    fun clear(name: String, durable: Boolean = false) {
        val edit = prefs.edit().remove(name)
        if(durable) check(edit.commit()) { "无法清除登录进度" } else edit.apply()
    }
}
