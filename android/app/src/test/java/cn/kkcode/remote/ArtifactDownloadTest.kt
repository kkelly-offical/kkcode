package cn.kkcode.remote

import kotlinx.coroutines.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
import java.security.MessageDigest
import java.util.Base64

class ArtifactDownloadTest {
    private val id = "art_00000000-0000-0000-0000-000000000001"
    private fun hash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private fun item(bytes: ByteArray) = ArtifactItem(id, bytes.size.toLong(), hash(bytes), "text/plain", false, false)
    private fun page(item: ArtifactItem, bytes: ByteArray, offset: Int, next: String? = null) = JSONObject()
        .put("id", item.id).put("sha256", item.sha256).put("size", item.size).put("offset", offset)
        .put("encoding", "base64").put("data", Base64.getEncoder().encodeToString(bytes)).put("nextCursor", next ?: JSONObject.NULL)

    @Test fun downloadsPagesToFileAndChecksExactBytesWithoutTrustingServerFilenameOrMime() = runBlocking {
        val bytes = ByteArray(ARTIFACT_PAGE_BYTES * 3 + 7) { (it % 251).toByte() }
        val item = item(bytes); val directory = Files.createTempDirectory("kk-artifact-download-").toFile()
        var offset = 0; var calls = 0
        try {
            val progress = mutableListOf<Long>()
            val file = downloadArtifactToCache(item, "session", directory, { method, params ->
                assertEquals("artifacts.download", method); assertEquals("session", params.getString("sessionId"))
                assertEquals(ARTIFACT_PAGE_BYTES, params.getInt("limit")); assertEquals(item.id, params.getString("id"))
                val end = minOf(offset + ARTIFACT_PAGE_BYTES, bytes.size)
                val response = page(item, bytes.copyOfRange(offset, end), offset, if(end < bytes.size) "cursor${++calls}" else null)
                    .put("filename", "../../unsafe.html").put("mime", "text/html")
                offset = end; response
            }) { count, _ -> progress += count }
            assertTrue(file.parentFile!!.canonicalFile == directory.canonicalFile)
            assertTrue(file.name.endsWith(".verified")); assertFalse(file.name.contains("unsafe"))
            assertArrayEquals(bytes, file.readBytes()); assertEquals(bytes.size.toLong(), progress.last())
            assertEquals(1, directory.listFiles()!!.size)
        } finally { directory.deleteRecursively() }
        Unit
    }

    @Test fun wrongHashAndMalformedPagesNeverLeaveDownloadFiles() = runBlocking {
        val bytes = "fixture".toByteArray(); val item = item(bytes)
        val mutators: List<(JSONObject) -> JSONObject> = listOf(
            { it.put("sha256", "0".repeat(64)) }, { it.put("offset", 1) }, { it.put("size", item.size + 1) },
            { it.put("id", "art_00000000-0000-0000-0000-000000000002") }, { it.put("encoding", "utf8") },
            { it.put("data", "%%%") }, { it.put("data", "Zg==\n") }, { it.put("data", "Zg==") },
            { it.put("nextCursor", "extra") }, { it.put("nextCursor", 1) }, { it.remove("nextCursor"); it },
            { it.put("data", Base64.getEncoder().encodeToString("xxxxxxx".toByteArray())) }
        )
        for(mutate in mutators) {
            val directory = Files.createTempDirectory("kk-artifact-invalid-").toFile()
            try {
                assertThrows(IllegalArgumentException::class.java) { runBlocking { downloadArtifactToCache(item, "session", directory, { _, _ -> mutate(page(item, bytes, 0)) }) } }
                assertTrue(directory.listFiles()!!.isEmpty())
            } finally { directory.deleteRecursively() }
        }
    }

    @Test fun cursorCyclesAndEmptyNonFinalPagesAreRejected() = runBlocking {
        val bytes = "abcdefghijkl".toByteArray(); val item = item(bytes)
        val directory = Files.createTempDirectory("kk-artifact-cursor-").toFile()
        try {
            var offset = 0
            assertThrows(IllegalArgumentException::class.java) { runBlocking {
                downloadArtifactToCache(item, "session", directory, { _, _ -> page(item, bytes.copyOfRange(offset, offset + 4), offset, "same").also { offset += 4 } })
            } }
            assertTrue(directory.listFiles()!!.isEmpty())
            assertThrows(IllegalArgumentException::class.java) { decodeArtifactChunk(page(item, byteArrayOf(), 0, "next"), item, 0) }
        } finally { directory.deleteRecursively() }
        Unit
    }

    @Test fun cancellationOfStalledNextPageClosesAndDeletesPartialCache() = runBlocking {
        val bytes = "abcdefgh".toByteArray(); val item = item(bytes)
        val directory = Files.createTempDirectory("kk-artifact-cancel-").toFile()
        val waiting = CompletableDeferred<Unit>()
        try {
            var calls = 0
            val task = launch {
                downloadArtifactToCache(item, "session", directory, { _, _ ->
                    if(calls++ == 0) page(item, bytes.copyOfRange(0, 4), 0, "next")
                    else { waiting.complete(Unit); awaitCancellation() }
                })
            }
            withTimeout(3000) { waiting.await(); task.cancelAndJoin() }
            assertTrue(directory.listFiles()!!.isEmpty())
        } finally { directory.deleteRecursively() }
    }

    @Test fun validatesMetadataLimitsAndAcceptsVerifiedEmptyFile() = runBlocking {
        val empty = byteArrayOf(); val item = item(empty)
        val directory = Files.createTempDirectory("kk-artifact-empty-").toFile()
        try {
            val file = downloadArtifactToCache(item, "session", directory, { _, _ -> page(item, empty, 0) })
            assertEquals(0L, file.length()); file.delete()
            for(size in listOf(-1L, ARTIFACT_MAX_BYTES + 1)) assertThrows(IllegalArgumentException::class.java) {
                ArtifactItem.parse(JSONObject().put("id", id).put("size", size).put("sha256", item.sha256))
            }
            assertThrows(IllegalArgumentException::class.java) { ArtifactItem.parse(JSONObject().put("id", id).put("size", 1.2).put("sha256", item.sha256)) }
        } finally { directory.deleteRecursively() }
        Unit
    }
}
