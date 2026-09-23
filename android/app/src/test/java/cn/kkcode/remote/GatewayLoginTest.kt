package cn.kkcode.remote

import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class GatewayLoginTest {
    private fun pending(native: Boolean = true) = PendingGatewayLogin("https://gateway.example", "d".repeat(43), "12345678", "s".repeat(43), "v".repeat(43), native, 1000000, 5000, 5000)
    @Test fun pkceUsesTheRfc7636S256Vector() {
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", loginChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
    }
    @Test fun pendingRoundTripKeepsSecretsAndRateLimitState() {
        assertEquals(pending(), PendingGatewayLogin.read(pending().json(), false))
        for(change in listOf<(JSONObject) -> Unit>(
            { it.put("gateway", "https://user:password@evil.example") }, { it.put("state", "short") },
            { it.put("verifier", "short") }, { it.put("userCode", "12345678&next=evil") }, { it.put("intervalMs", 0) }
        )) {
            val data = JSONObject(pending().json()); change(data)
            assertThrows(IllegalArgumentException::class.java) { PendingGatewayLogin.read(data.toString(), false) }
        }
    }
    @Test fun callbacksOnlyWakeTheExactPendingNativeTransaction() {
        val target = "$LOGIN_RETURN_URI?state=${pending().state}"
        assertTrue(pending().acceptsReturn(target))
        assertFalse(pending(false).acceptsReturn(target))
        for(value in listOf(null, "", target + "&gateway=https://evil.example", target + "&state=${pending().state}",
            target + "#ignored", target.replace("auth/", "evil/"), target.replace("auth/", "auth:80/"),
            target.replace("auth/", "user@auth/"), target.replace("complete?", "complete/extra?"),
            target.replace("cn.kkcode.remote:", "https:"), "$LOGIN_RETURN_URI?state=${"x".repeat(43)}")) {
            assertFalse(value, pending().acceptsReturn(value))
        }
    }
    @Test fun nativeProofIsSentToTheGatewayNotTheReturnLink() {
        assertEquals("v".repeat(43), pending().proof().getString("code_verifier"))
        assertFalse(pending(false).proof().has("code_verifier"))
    }
    @Test fun pendingAndSlowDownRespectPersistedIntervals() = runBlocking {
        var clock = 0L; var calls = 0; val delays = mutableListOf<Long>(); val saved = mutableListOf<PendingGatewayLogin>()
        val result = pollGatewayLogin(pending(), { saved.add(it) }, request = {
            assertEquals(pending().verifier, it.getString("code_verifier"))
            when(++calls) { 1 -> throw DeviceApiError("slow_down", 400, "http_400"); 2 -> throw DeviceApiError("authorization_pending", 400, "http_400"); else -> JSONObject().put("ok", true) }
        }, now = { clock }, pause = { delays.add(it); clock += it })
        assertTrue(result.getBoolean("ok")); assertEquals(listOf(5000L, 10000L, 10000L), delays)
        assertEquals(10000L, saved.last().intervalMs)
    }
    @Test fun transientFailuresRetryFiveTimesThenRetainAResumableTransaction() = runBlocking {
        var clock = 0L; var calls = 0; var saved = pending()
        try {
            pollGatewayLogin(pending(), { saved = it }, request = { calls++; throw IOException("fixture offline") }, now = { clock }, pause = { clock += it })
            fail("Expected resumable pause")
        } catch(_: GatewayLoginPaused) { }
        assertEquals(6, calls); assertTrue(saved.nextPollAt > clock)
        assertEquals(pending().deviceCode, saved.deviceCode)
        var resumedAt = 0L
        pollGatewayLogin(saved, {}, request = { resumedAt = clock; JSONObject() }, now = { clock }, pause = { clock += it })
        assertEquals(saved.nextPollAt, resumedAt)
    }
    @Test fun gatewayOverloadAndNetworkFailuresRecoverWithoutANewGrant() = runBlocking {
        for(error in listOf(IOException("fixture"), DeviceApiError("temporary", 503, "http_503"), DeviceApiError("rate limited", 429, "http_429"))) {
            var clock = 0L; var calls = 0
            pollGatewayLogin(pending(), {}, request = { if(++calls == 1) throw error; JSONObject() }, now = { clock }, pause = { clock += it })
            assertEquals(2, calls); assertEquals(15000L, clock)
        }
    }
    @Test fun initializationRetriesOnlyTransientFailuresAndHasABound() = runBlocking {
        var calls = 0; val delays = mutableListOf<Long>()
        retryLoginRequest(pause = { delays.add(it) }) { if(++calls < 6) throw IOException("temporary"); JSONObject() }
        assertEquals(6, calls); assertEquals(listOf(500L, 1000L, 2000L, 4000L, 8000L), delays)
        calls = 0
        try { retryLoginRequest(pause = {}) { calls++; throw DeviceApiError("forbidden", 403, "http_403") }; fail("Expected rejection") }
        catch(_: DeviceApiError) { }
        assertEquals(1, calls)
    }
    @Test fun retryBackoffNeverUndercutsASlowGatewayPollingInterval() = runBlocking {
        var clock = 0L; var calls = 0; val waits = mutableListOf<Long>()
        pollGatewayLogin(pending().copy(intervalMs = 120000), {}, request = { if(++calls == 1) throw IOException("offline"); JSONObject() },
            now = { clock }, pause = { waits.add(it); clock += it })
        assertEquals(listOf(5000L, 120000L), waits)
    }
    @Test fun deniedExpiredAndInvalidProofAreTerminal() = runBlocking {
        for(reason in listOf("access_denied", "authorization_failed", "membership_disabled", "expired_token", "invalid_grant")) {
            var clock = 0L; var calls = 0
            try {
                pollGatewayLogin(pending(), {}, request = { calls++; throw DeviceApiError(reason, 400, "http_400") }, now = { clock }, pause = { clock += it })
                fail("Expected terminal login error")
            } catch(_: GatewayLoginEnded) { }
            assertEquals(1, calls)
        }
    }
    @Test fun expiredTransactionsNeverPollAndCancellationIsNotRetried() = runBlocking {
        var clock = 0L; var calls = 0
        try {
            pollGatewayLogin(pending().copy(expiresAt = 3000), {}, request = { calls++; JSONObject() }, now = { clock }, pause = { clock += it })
            fail("Expected expiration")
        } catch(_: GatewayLoginEnded) { }
        assertEquals(0, calls)
        try {
            pollGatewayLogin(pending(), {}, request = { calls++; throw CancellationException("cancel") }, now = { clock }, pause = { clock += it })
            fail("Expected cancellation")
        } catch(_: CancellationException) { }
        assertEquals(1, calls)
    }
}
