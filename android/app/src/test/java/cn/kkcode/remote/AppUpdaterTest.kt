package cn.kkcode.remote

import android.content.Context
import kotlinx.coroutines.CompletableDeferred
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
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicInteger

private class UpdateRecoveryFixture {
    val versionCode = 20001L
    val bytes = "cached APK fixture".toByteArray()
    val application = RuntimeEnvironment.getApplication()
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
        val directory = File(application.cacheDir, "app-updates").apply { mkdirs() }
        File(directory, "update-$versionCode.apk").writeBytes(bytes)
    }

    fun newUpdater(scope: CoroutineScope, updateSource: GitHubUpdateSource = source) = AppUpdater(application, scope, updateSource) { _, file, update ->
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
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    try {
        runBlocking { block(UpdateRecoveryFixture(), scope) }
    } finally {
        scope.cancel()
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
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

    @Test fun foregroundDoesNotReplaceAnActiveDownload() = runUpdateRecoveryTest { fixture, scope ->
        File(fixture.application.cacheDir, "app-updates/update-${fixture.versionCode}.apk").delete()
        updateInstallPreferences(fixture.application).edit().putInt("session", 42)
            .putLong("versionCode", fixture.versionCode).putString("status", "confirmation").commit()
        val readStarted = CompletableDeferred<Unit>()
        val closed = CountDownLatch(1)
        val requests = AtomicInteger()
        val source = GitHubUpdateSource(transport = UpdateTransport {
            requests.incrementAndGet()
            object : UpdateBody {
                override val stream = object : InputStream() {
                    override fun read(): Int {
                        readStarted.complete(Unit)
                        closed.await()
                        throw IOException("closed")
                    }
                }
                override val length = fixture.bytes.size.toLong()
                override fun close() { closed.countDown() }
            }
        })
        val updater = fixture.newUpdater(scope, source)
        updater.download()
        withTimeout(5000) { readStarted.await() }
        try {
            updater.onForeground()
            assertEquals(UpdatePhase.DOWNLOADING, updater.phase)
            assertTrue(updater.working)
            assertEquals("正在下载并校验更新", updater.message)
            updater.download()
            assertEquals(1, requests.get())
            updater.cancel()
            assertEquals(UpdatePhase.AVAILABLE, updater.phase)
            withTimeout(5000) { while(closed.count > 0) delay(10) }
        } finally { closed.countDown() }
    }

    @Test fun foregroundDoesNotReplaceAnActiveCheck() = runUpdateRecoveryTest { fixture, scope ->
        File(fixture.application.cacheDir, "app-updates/update-${fixture.versionCode}.apk").delete()
        updateInstallPreferences(fixture.application).edit().putInt("session", 42)
            .putLong("versionCode", fixture.versionCode).putString("status", "installing").commit()
        val checkStarted = CompletableDeferred<Unit>()
        val finishCheck = CompletableDeferred<Unit>()
        val requests = AtomicInteger()
        val source = GitHubUpdateSource(transport = UpdateTransport {
            requests.incrementAndGet()
            checkStarted.complete(Unit)
            finishCheck.await()
            val bytes = "[]".toByteArray()
            object : UpdateBody {
                override val stream = ByteArrayInputStream(bytes)
                override val length = bytes.size.toLong()
                override fun close() { stream.close() }
            }
        })
        val updater = fixture.newUpdater(scope, source)
        updater.check(true)
        withTimeout(5000) { checkStarted.await() }
        try {
            updater.onForeground()
            assertEquals(UpdatePhase.CHECKING, updater.phase)
            assertTrue(updater.working)
            assertEquals(1, requests.get())
        } finally { finishCheck.complete(Unit) }
        awaitUpdatePhase(updater, UpdatePhase.CURRENT)
        assertEquals(1, requests.get())
    }
}
