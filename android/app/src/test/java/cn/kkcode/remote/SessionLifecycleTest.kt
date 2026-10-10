package cn.kkcode.remote

import org.junit.Assert.assertEquals
import org.junit.Test

class SessionLifecycleTest {
    @Test fun manualSessionSwitchClearsComposerBeforeTheSnapshotCanSuspend() {
        var clears = 0
        prepareSessionComposer(preserveComposer = false) { clears++ }
        assertEquals(1, clears)
    }

    @Test fun automaticRecoveryOfTheSameSshSessionSkipsTheComposerReset() {
        var clears = 0
        prepareSessionComposer(preserveComposer = true) { clears++ }
        assertEquals(0, clears)
    }
}
