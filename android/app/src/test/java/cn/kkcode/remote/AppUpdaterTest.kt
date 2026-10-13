package cn.kkcode.remote

import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicInteger

private fun updateTestUnsafe(): sun.misc.Unsafe {
    val field = sun.misc.Unsafe::class.java.getDeclaredField("theUnsafe").apply { isAccessible = true }
    return field.get(null) as sun.misc.Unsafe
}

private fun setUpdateTestSdk(value: Int) {
    val field = Build.VERSION::class.java.getDeclaredField("SDK_INT")
    val unsafe = updateTestUnsafe()
    unsafe.putInt(unsafe.staticFieldBase(field), unsafe.staticFieldOffset(field), value)
}

private class UpdateRecoveryApplication private constructor() : Application() {
    private var cacheDirectory: File? = null
    private var preferenceStores: MutableMap<String, MemorySharedPreferences>? = null
    override fun getCacheDir(): File = cacheDirectory!!
    override fun getPackageName(): String = BuildConfig.APPLICATION_ID
    override fun getSharedPreferences(name: String, mode: Int): SharedPreferences = preferenceStores!!.getOrPut(name) { MemorySharedPreferences() }

    companion object {
        fun create(cacheDirectory: File): UpdateRecoveryApplication {
            val application = updateTestUnsafe().allocateInstance(UpdateRecoveryApplication::class.java) as UpdateRecoveryApplication
            application.cacheDirectory = cacheDirectory
            application.preferenceStores = mutableMapOf()
            return application
        }
    }
}

private class UpdateRecoveryFixture(root: File) {
    val versionCode = 20001L
    val bytes = "cached APK fixture".toByteArray()
    val application = UpdateRecoveryApplication.create(root)
    val requests = AtomicInteger()
    val verifications = AtomicInteger()
    private val source = GitHubUpdateSource(transport = UpdateTransport {
        requests.incrementAndGet()
        throw IOException("unexpected update request")
    })

    init {
        val hash = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        val manifest = updateTestManifest("1.0.999", versionCode, bytes.size.toLong(), hash)
            .put("applicationId", BuildConfig.APPLICATION_ID).put("notes", "Cached release")
        manifest.getJSONObject("apk").put("certificateSha256", BuildConfig.UPDATE_CERT_SHA256)
        application.getSharedPreferences("kkcode.updates", Context.MODE_PRIVATE).edit()
            .putString("candidate-STABLE", manifest.toString()).putLong("checked-STABLE", System.currentTimeMillis()).commit()
        val directory = File(root, "app-updates").apply { mkdirs() }
        File(directory, "update-$versionCode.apk").writeBytes(bytes)
    }

    fun newUpdater(scope: CoroutineScope) = AppUpdater(application, scope, source) { _, file, update ->
        assertEquals(versionCode, update.versionCode)
        assertArrayEquals(bytes, file.readBytes())
        verifications.incrementAndGet()
    }
}

private suspend fun awaitUpdatePhase(updater: AppUpdater, expected: UpdatePhase) {
    withTimeout(5000) {
        while(updater.phase != expected) {
            if(updater.phase == UpdatePhase.ERROR) throw AssertionError(updater.message)
            delay(10)
        }
    }
}

private fun runUpdateRecoveryTest(block: suspend (UpdateRecoveryFixture, CoroutineScope) -> Unit) {
    val previousSdk = Build.VERSION.SDK_INT
    val root = Files.createTempDirectory("kkcode-update-recovery-").toFile()
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    try {
        setUpdateTestSdk(35)
        runBlocking { block(UpdateRecoveryFixture(root), scope) }
    } finally {
        scope.cancel()
        root.deleteRecursively()
        setUpdateTestSdk(previousSdk)
    }
}

class AppUpdaterTest {
    @Test fun readyDownloadIsReverifiedAfterProcessRecreation() = runUpdateRecoveryTest { fixture, scope ->
        val restored = fixture.newUpdater(scope)
        awaitUpdatePhase(restored, UpdatePhase.READY)
        restored.onForeground()
        assertEquals(UpdatePhase.READY, restored.phase)
        assertEquals(fixture.versionCode, restored.candidate?.versionCode)
        assertEquals(1, fixture.verifications.get())
        assertEquals(0, fixture.requests.get())
    }

    @Test fun confirmationStateSurvivesProcessRecreation() = runUpdateRecoveryTest { fixture, scope ->
        updateInstallPreferences(fixture.application).edit().putInt("session", 42)
            .putLong("versionCode", fixture.versionCode).putString("status", "confirmation").commit()
        val restored = fixture.newUpdater(scope)
        restored.onForeground()
        awaitUpdatePhase(restored, UpdatePhase.READY)
        restored.onForeground()
        assertEquals(UpdatePhase.READY, restored.phase)
        assertTrue(restored.message.contains("安装尚未完成"))
        assertEquals("confirmation", updateInstallPreferences(fixture.application).getString("status", ""))
        assertEquals(1, fixture.verifications.get())
        assertEquals(0, fixture.requests.get())
    }
}
