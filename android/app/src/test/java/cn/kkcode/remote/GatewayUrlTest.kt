package cn.kkcode.remote

import org.junit.Assert.*
import org.junit.Test

class GatewayUrlTest {
    @Test fun loginNavigationIsPinnedToTheGatewayAndAValidatedCode() {
        assertEquals("https://10.0.0.2:18472/login?code=12345678", deviceLoginUrl("https://10.0.0.2:18472", "12345678", false))
        for(code in listOf("12345678\n", "javascript:alert(1)", "12345678&next=//evil.invalid", "１２３４５６７８")) {
            assertThrows(IllegalArgumentException::class.java) { deviceLoginUrl("https://gateway.invalid", code, false) }
        }
    }
    @Test fun supportsHttpsIncludingWireGuard() {
        assertTrue(validGatewayUrl("https://10.0.0.2:18472", false))
        assertTrue(validGatewayUrl("https://remote.example.com", false))
    }
    @Test fun cleartextIsLoopbackOnlyOutsideDebug() {
        assertTrue(validGatewayUrl("http://127.0.0.1:18476", false))
        assertTrue(validGatewayUrl("http://10.0.2.2:18476", true))
        assertFalse(validGatewayUrl("http://10.0.2.2:18476", false))
        assertFalse(validGatewayUrl("http://10.0.0.2:18476", false))
    }
    @Test fun rejectsUserInfoAndMisleadingLoopbackPrefixes() {
        assertFalse(validGatewayUrl("http://127.0.0.1:pass@evil.example:8080", true))
        assertFalse(validGatewayUrl("https://user:pass@remote.example.com", false))
        assertFalse(validGatewayUrl("https://remote.example.com#secret", false))
        assertFalse(validGatewayUrl("https://remote.example.com?token=secret", false))
    }
}
