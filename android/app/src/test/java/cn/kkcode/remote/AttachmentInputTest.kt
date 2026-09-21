package cn.kkcode.remote

import org.junit.Assert.assertArrayEquals
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
}
