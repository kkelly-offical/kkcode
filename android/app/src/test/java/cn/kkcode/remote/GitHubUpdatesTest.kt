package cn.kkcode.remote

import kotlinx.coroutines.*
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.File
import java.io.InputStream
import java.nio.file.Files
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch

private fun updateBytesBody(bytes: ByteArray, length: Long = bytes.size.toLong()) = object : UpdateBody {
    override val stream = ByteArrayInputStream(bytes)
    override val length = length
    override fun close() { stream.close() }
}
class GitHubUpdatesTest {
    @Test fun selectsHighestCompatibleVersionCodeRatherThanListOrder() = runBlocking {
        val first = updateTestReleaseJson("1.0.2"); val later = updateTestReleaseJson("1.0.3")
        val manifests = mapOf("v1.0.2" to updateTestManifest("1.0.2", 10005), "v1.0.3" to updateTestManifest("1.0.3", 10006))
        val transport = UpdateTransport { url -> updateBytesBody((if(url.contains("api.github.com")) JSONArray().put(later).put(first).toString() else manifests.entries.first { url.contains(it.key) }.value.toString()).toByteArray()) }
        val source = GitHubUpdateSource(updateTestPolicy(), transport)
        assertEquals(10006L, source.check(UpdateChannel.STABLE, 35)?.versionCode)
        manifests.getValue("v1.0.3").put("minSdk", 36)
        assertEquals(10005L, source.check(UpdateChannel.STABLE, 35)?.versionCode)
    }
    @Test fun missingAndroidReleaseIsNotInventedAsAnUpdate() = runBlocking {
        assertNull(GitHubUpdateSource(updateTestPolicy(), UpdateTransport { updateBytesBody("[]".toByteArray()) }).check(UpdateChannel.STABLE, 35))
    }
    @Test fun downloadChecksExactSizeAndHashBeforeAtomicPromotion() = runBlocking {
        val bytes = "APK fixture".toByteArray(); val hash = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        val update = updateTestPolicy().manifest(updateTestManifest(size = bytes.size.toLong(), hash = hash).toString(), updateTestRelease(size = bytes.size.toLong()))
        val directory = Files.createTempDirectory("kkcode-update-test-").toFile()
        try {
            val source = GitHubUpdateSource(updateTestPolicy(), UpdateTransport { updateBytesBody(bytes) })
            val progress = mutableListOf<Long>()
            val file = source.download(update, directory) { count, _ -> progress += count }
            assertArrayEquals(bytes, file.readBytes()); assertEquals(bytes.size.toLong(), progress.last())
            assertFalse(File(directory, "update-10005.part").exists())
            for(candidate in listOf(update.copy(sha256 = "0".repeat(64)), update.copy(size = bytes.size + 1L), update.copy(size = bytes.size - 1L))) {
                assertThrows(IllegalArgumentException::class.java) { runBlocking { source.download(candidate, directory) } }
                assertArrayEquals(bytes, file.readBytes())
                assertFalse(File(directory, "update-10005.part").exists())
            }
        } finally { directory.deleteRecursively() }
    }
    @Test fun unknownLengthAndZeroByteReadsStillRespectLimits() = runBlocking {
        val input = object : InputStream() { override fun read(): Int = 1; override fun read(buffer: ByteArray, offset: Int, length: Int): Int = 0 }
        assertThrows(IllegalArgumentException::class.java) { runBlocking { copyUpdateBytes(input, 3) { _, _ -> } } }
        Unit
    }
    @Test fun cancellingAStalledBodyClosesItAndRemovesThePartialFile() = runBlocking {
        val readStarted = CompletableDeferred<Unit>(); val closed = CountDownLatch(1)
        val body = object : UpdateBody {
            override val length = 3L
            override val stream = object : InputStream() {
                override fun read(): Int { readStarted.complete(Unit); closed.await(); throw java.io.IOException("closed") }
            }
            override fun close() { closed.countDown() }
        }
        val directory = Files.createTempDirectory("kkcode-update-cancel-").toFile()
        try {
            val source = GitHubUpdateSource(updateTestPolicy(), UpdateTransport { body })
            val update = updateTestPolicy().manifest(updateTestManifest().toString(), updateTestRelease())
            val task = launch { source.download(update, directory) }
            withTimeout(3000) { readStarted.await(); task.cancelAndJoin() }
            assertEquals(0L, closed.count)
            assertTrue(directory.listFiles()!!.isEmpty())
        } finally { directory.deleteRecursively() }
    }
}
