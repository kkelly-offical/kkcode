package cn.kkcode.remote

import org.junit.Assert.*
import org.junit.Test

class ConversationStreamTest {
    @Test fun snapshotPrefixAndNewTailMergeIntoOneIdentifiedRow() {
        val first = appendStreamDelta(emptyList(), StreamDelta("snapshot-prefix", "assistant", "Hello ", "turn-a", 1, 100), emptySet())
        val next = appendStreamDelta(first, StreamDelta("new-tail", "assistant", "world", "turn-a", 1, 200), emptySet())
        assertEquals(1, next.size); assertEquals("Hello world", next.single().text); assertEquals("snapshot-prefix", next.single().id)
    }
    @Test fun canonicalStepSuppressesLateJournalDeltas() {
        val canonical = listOf(ChatItem("stored", "assistant", "Already complete", turnId = "turn-a", step = 1))
        assertEquals(canonical, appendStreamDelta(canonical, StreamDelta("late", "assistant", "complete", "turn-a", 1, 200), setOf("turn-a:1")))
        assertEquals(canonical, appendStreamDelta(canonical, StreamDelta("late-thinking", "thinking", "reason", "turn-a", 1, 200), setOf("turn-a:1")))
    }
    @Test fun differentTurnsAndStepsNeverShareTheLastAssistantRow() {
        val old = listOf(ChatItem("old", "assistant", "old reply", turnId = "old-turn", step = 1))
        val next = appendStreamDelta(old, StreamDelta("new", "assistant", "new reply", "new-turn", 1, 200), emptySet())
        val step = appendStreamDelta(next, StreamDelta("step", "assistant", "next step", "new-turn", 2, 300), emptySet())
        assertEquals(listOf("old reply", "new reply", "next step"), step.map { it.text })
    }
    @Test fun terminalResultDoesNotDuplicateTheCompletedStreamOrCanonicalReply() {
        val stream = appendStreamDelta(emptyList(), StreamDelta("stream", "assistant", "answer", "turn", 2, 100), emptySet())
        val ended = finishStreamStep(stream, "turn", 2, 200)
        val finish = finishStreamReply(ended, "finish", "turn", 2, "answer", 210)
        val result = finishStreamReply(finish, "result", "turn", null, "answer", 220)
        assertEquals(1, result.size); assertEquals("answer", result.single().text)
        val stored = listOf(ChatItem("stored", "assistant", "answer", turnId = "turn", step = 2))
        assertEquals(stored, finishStreamReply(stored, "result", "turn", null, "answer", 220))
    }
    @Test fun finalReplyPreservesEarlierCommentaryBeforeTools() {
        val before = listOf(ChatItem("comment", "assistant", "Reading files", turnId = "turn", step = 1, streamed = true), ChatItem("tool", "tool", "read", turnId = "turn", step = 1))
        val result = finishStreamReply(before, "finish", "turn", null, "Final answer", 220)
        assertEquals(3, result.size); assertEquals("Reading files", result.first().text); assertEquals("Final answer", result.last().text)
    }
    @Test fun partialCanonicalStepAllowsASeparateContinuation() {
        val partial = listOf(ChatItem("partial", "assistant", "First part", turnId = "turn", step = 1))
        val result = appendStreamDelta(partial, StreamDelta("continuation", "assistant", "Second part", "turn", 1, 200), emptySet())
        assertEquals(2, result.size); assertEquals("Second part", result.last().text)
    }
    @Test fun thinkingPrefixRetainsTimerAndClosesOnce() {
        val prefix = appendStreamDelta(emptyList(), StreamDelta("thinking", "thinking", "reason", "turn", 1, 1000), emptySet())
        val tail = appendStreamDelta(prefix, StreamDelta("tail", "thinking", "ing", "turn", 1, 2500), emptySet())
        val done = finishStreamStep(tail, "turn", 1, 3000)
        assertEquals("reasoning", done.single().text); assertEquals(2000L, done.single().durationMs); assertTrue(done.single().done)
        assertEquals(done, finishStreamStep(done, "turn", 1, 4000))
    }
}
