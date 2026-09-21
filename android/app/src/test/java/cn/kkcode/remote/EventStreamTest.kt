package cn.kkcode.remote

import org.junit.Assert.*
import org.junit.Test

class EventStreamTest {
    private fun parse(text: String): List<SseFrame> {
        val frames = mutableListOf<SseFrame>()
        val parser = SseParser { frames += it }
        text.split("\n").forEach { parser.line(it) }
        return frames
    }

    @Test fun standardFrameCarriesEventIdAndData() {
        val frames = parse("retry: 2000\nid: 41\nevent: stream.text.delta\ndata: {\"seq\":41,\"type\":\"stream.text.delta\"}\n\n")
        assertEquals(1, frames.size)
        assertEquals("41", frames[0].id)
        assertEquals("stream.text.delta", frames[0].event)
        assertEquals("{\"seq\":41,\"type\":\"stream.text.delta\"}", frames[0].data)
    }

    @Test fun keepaliveCommentsAndBlankRetriesProduceNoFrames() {
        val frames = parse(": keepalive\n\n: another\n\n")
        assertTrue(frames.isEmpty())
    }

    @Test fun multiLineDataJoinsWithNewline() {
        val frames = parse("data: first\ndata: second\n\n")
        assertEquals("first\nsecond", frames.single().data)
        assertEquals("message", frames.single().event)
    }

    @Test fun crlfEndingsAreAccepted() {
        val frames = parse("event: connected\r\ndata: {\"type\":\"connected\"}\r\n\r\n")
        assertEquals("connected", frames.single().event)
        assertEquals("{\"type\":\"connected\"}", frames.single().data)
    }

    @Test fun eventNameResetsAfterDispatch() {
        val frames = parse("event: a\ndata: one\n\ndata: two\n\n")
        assertEquals(listOf("a", "message"), frames.map { it.event })
    }

    @Test fun fieldWithoutColonMeansEmptyValue() {
        val frames = parse("data\nevent: x\n\n")
        assertEquals(0, frames.size)
        val rest = parse("event: x\ndata\n\n")
        assertEquals(0, rest.size)
    }

    @Test fun idPersistsAcrossFramesUntilReplaced() {
        val frames = parse("id: 7\ndata: a\n\ndata: b\n\nid: 9\ndata: c\n\n")
        assertEquals(listOf("7", "7", "9"), frames.map { it.id })
    }
}
