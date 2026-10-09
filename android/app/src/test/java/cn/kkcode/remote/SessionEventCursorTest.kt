package cn.kkcode.remote

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class SessionEventCursorTest {
    @Test fun controlFramesAtTheCurrentCursorAreNotDuplicateJournalRows() = runBlocking {
        val cursor = SessionEventCursor(41)
        assertTrue(cursor.process(null) {}) // connected id:41, no journal seq
        assertTrue(cursor.process(42) {})
        assertTrue(cursor.process(null) {}) // session.state id:42
        assertTrue(cursor.process(null) {}) // replay.gap id:42
        assertFalse(cursor.process(42) { error("duplicate journal row") })
        assertFalse(cursor.process(40) { error("stale journal row") })
        assertEquals(42L, cursor.value)
        assertTrue(cursor.process(43) {})
    }

    @Test fun failedSseHandlerKeepsTheOldCursorForAnExactlyOnceRetry() = runBlocking {
        val cursor = SessionEventCursor(41)
        var attempts = 0
        try {
            cursor.process(42) { attempts++; throw IllegalStateException("fixture RPC failure") }
            fail("The fixture failure must reach the reconnect path")
        } catch(_: IllegalStateException) {}
        assertEquals(41L, cursor.value)
        assertTrue(cursor.process(42) { attempts++ })
        assertEquals(42L, cursor.value)
        assertFalse(cursor.process(42) { attempts++ })
        assertEquals(2, attempts)
    }

    @Test fun pollingRetrySkipsCommittedPrefixAndAppliesEachSuccessOnce() = runBlocking {
        val cursor = SessionEventCursor(41)
        val attempts = mutableListOf<Long>()
        val committed = mutableListOf<Long>()
        var failFirst = true
        try {
            for(sequence in listOf(42L, 43L, 44L)) cursor.process(sequence) {
                attempts += sequence
                if(sequence == 43L && failFirst) throw IllegalStateException("fixture RPC failure")
                committed += sequence
            }
        } catch(_: IllegalStateException) {}
        assertEquals(42L, cursor.value)
        assertEquals(listOf(42L), committed)
        failFirst = false
        for(sequence in listOf(42L, 43L, 44L)) cursor.process(sequence) {
            attempts += sequence
            committed += sequence
        }
        assertEquals(listOf(42L, 43L, 43L, 44L), attempts)
        assertEquals(listOf(42L, 43L, 44L), committed)
        assertEquals(44L, cursor.value)
    }

    @Test fun resyncAdoptsTheSnapshotCursorWithoutSkippingSubsequentEvents() = runBlocking {
        val cursor = SessionEventCursor(4)
        assertTrue(cursor.process(null) { cursor.reset(20) })
        assertFalse(cursor.process(19) { error("snapshot already contains this row") })
        assertTrue(cursor.process(21) {})
        assertEquals(21L, cursor.value)
    }
}
