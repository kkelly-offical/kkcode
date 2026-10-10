package cn.kkcode.remote

import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

class RemoteStateDeviceEventsTest {
    @Test fun relayReconnectsBeyondTheLegacyAttemptLimitWithBoundedBackoff() {
        val delays = (1..12).map { deviceEventRetryDelay(true, it, IOException("offline")) }
        assertEquals(listOf(1000L, 2000L, 4000L, 8000L, 10000L), delays.take(5))
        assertTrue(delays.drop(5).all { it == 10000L })
    }

    @Test fun relayRetriesNonAuthorizationFailuresButStopsForPermanentAuthorization() {
        for(status in listOf(401, 403)) assertNull(deviceEventRetryDelay(true, 1, DeviceApiError("denied", status, "denied")))
        assertNotNull(deviceEventRetryDelay(true, 100, DeviceApiError("missing", 404, "missing")))
        assertNull(deviceEventRetryDelay(false, 6, IOException("offline")))
        assertNull(deviceEventRetryDelay(false, 1, DeviceApiError("missing", 404, "missing")))
    }

    @Test fun pollingRestartsADeadEventJobInsteadOfTrustingConnectedFlag() {
        assertTrue(deviceEventsNeedRestart(connected = true, eventsActive = false, manualDisconnect = false))
        assertFalse(deviceEventsNeedRestart(connected = true, eventsActive = true, manualDisconnect = false))
        assertFalse(deviceEventsNeedRestart(connected = false, eventsActive = false, manualDisconnect = false))
        assertFalse(deviceEventsNeedRestart(connected = true, eventsActive = false, manualDisconnect = true))
    }
}
