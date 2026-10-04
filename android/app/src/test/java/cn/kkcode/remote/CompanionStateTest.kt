package cn.kkcode.remote

import org.junit.Assert.*
import org.junit.Test

class CompanionStateTest {
    private fun mood(connected: Boolean = true, busy: Boolean = false, phase: String = "", activity: String = "", approval: Boolean = false, stopping: Boolean = false, outcome: String = "", celebrate: Boolean = false) = companionMood(connected, stopping, approval, busy, phase, activity, false, outcome, celebrate)
    @Test fun companionDistinguishesActualRuntimeStatesAndNeverCelebratesErrorsOrCancellation() {
        assertEquals("thinking", mood(busy = true, activity = "thinking"))
        assertEquals("writing", mood(busy = true, activity = "assistant"))
        assertEquals("working", mood(busy = true, activity = "tool"))
        assertEquals("waiting", mood(busy = true, phase = "waiting_children"))
        assertEquals("approval", mood(busy = true, phase = "waiting_children", approval = true))
        assertEquals("stopping", mood(busy = true, stopping = true, approval = true))
        assertEquals("error", mood(outcome = "error", celebrate = true))
        assertEquals("stopped", mood(outcome = "cancelled", celebrate = true))
        assertEquals("offline", mood(connected = false, busy = true))
        assertEquals("complete", mood(celebrate = true))
        assertEquals("本轮已结束", companionLabel("complete"))
    }
}
