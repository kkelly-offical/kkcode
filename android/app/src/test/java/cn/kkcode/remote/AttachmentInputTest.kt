package cn.kkcode.remote

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.InputStream

class AttachmentInputTest {
    @Test fun readsExactLimitWithoutTruncating() {
        val bytes = ByteArray(16384) { (it % 256).toByte() }
        assertArrayEquals(bytes, readBoundedAttachment(ByteArrayInputStream(bytes), bytes.size))
    }
    @Test(expected = IllegalArgumentException::class) fun rejectsUnknownLengthOversizeStream() {
        readBoundedAttachment(ByteArrayInputStream(ByteArray(1025)), 1024)
    }
    @Test fun handlesProvidersReturningZeroWithoutAnInfiniteLoop() {
        val input = object : InputStream() {
            var remaining = 2
            override fun read(): Int = if(remaining-- > 0) 65 else -1
            override fun read(bytes: ByteArray, offset: Int, length: Int): Int = if(remaining > 0) 0 else -1
        }
        assertArrayEquals(byteArrayOf(65, 65), readBoundedAttachment(input, 2))
    }
    @Test(expected = IllegalArgumentException::class) fun zeroLengthReadsCannotBypassTheLimit() {
        val input = object : InputStream() {
            override fun read(): Int = 65
            override fun read(bytes: ByteArray, offset: Int, length: Int): Int = 0
        }
        readBoundedAttachment(input, 2)
    }
    @Test fun previewSamplingBoundsTheDecodedDimensions() {
        assertEquals(1, attachmentPreviewSampleSize(128, 128))
        assertEquals(2, attachmentPreviewSampleSize(256, 128))
        assertEquals(32, attachmentPreviewSampleSize(4096, 2048))
        assertEquals(1, attachmentPreviewSampleSize(0, 4096))
    }
    @Test fun previewMetadataNeverFallsBackToTheOriginalBase64Payload() {
        val oversized = "x".repeat(ATTACHMENT_PREVIEW_MAX_BASE64_CHARS + 1)
        val result = JSONObject().put("preview", oversized)
        bindAttachmentPreview(result, "image/png", "bounded-thumbnail")
        assertEquals("bounded-thumbnail", result.optString("preview"))
        bindAttachmentPreview(result, "image/png", oversized)
        assertFalse(result.has("preview"))
        bindAttachmentPreview(result, "text/plain", "bounded-thumbnail")
        assertFalse(result.has("preview"))
    }
}
