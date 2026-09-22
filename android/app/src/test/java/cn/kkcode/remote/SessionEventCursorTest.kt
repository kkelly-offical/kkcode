package cn.kkcode.remote

import org.junit.Assert.*
import org.junit.Test

class SessionEventCursorTest {
    @Test fun controlFramesAtTheCurrentCursorAreNotDuplicateJournalRows() {
        val cursor = SessionEventCursor(41)
        assertTrue(cursor.accept(null)) // connected id:41, no journal seq
        assertTrue(cursor.accept(42))
        assertTrue(cursor.accept(null)) // session.state id:42
        assertTrue(cursor.accept(null)) // replay.gap id:42
        assertFalse(cursor.accept(42))
        assertFalse(cursor.accept(40))
        assertEquals(42L, cursor.value)
        assertTrue(cursor.accept(43))
    }

    @Test fun resyncAdoptsTheSnapshotCursorWithoutSkippingSubsequentEvents() {
        val cursor = SessionEventCursor(4)
        cursor.reset(20)
        assertTrue(cursor.accept(null))
        assertFalse(cursor.accept(19))
        assertTrue(cursor.accept(21))
        assertEquals(21L, cursor.value)
    }
}
