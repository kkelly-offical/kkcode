package cn.kkcode.remote

import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Explicit, public-endpoint probe: no credentials and no TLS bypass. */
class GatewayTlsTest {
    @Test fun gatewayHealthUsesNormalCertificateValidation() = runBlocking {
        val gateway = InstrumentationRegistry.getArguments().getString("gateway") ?: ""
        assumeTrue(gateway.startsWith("https://"))
        val api = DeviceApi(gateway, relay = false)
        assertTrue(api.call("/health").getBoolean("ok"))
    }
}
