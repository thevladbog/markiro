package app.markiro.handheld.core.network.host

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class HostApiTest {
    private class FakeTransport(private val answers: ArrayDeque<HostResult>) : HostTransport {
        val sent = mutableListOf<Triple<String, String, String?>>()
        override suspend fun get(path: String): HostResult = answers.removeFirst().also { sent += Triple("GET", path, null) }
        override suspend fun post(path: String, body: String): HostResult = answers.removeFirst().also { sent += Triple("POST", path, body) }
    }

    private fun api(vararg answers: HostResult) = FakeTransport(ArrayDeque(answers.toList())).let { it to HostApi(it) }
    private fun ok(body: String, code: Int = 200) = HostResult.Ok(code, body, null)
    private fun error(code: Int, kind: String, details: String = "{}", retryAfter: Long? = null) =
        HostResult.Ok(code, """{"error":{"code":"$kind","message":"m","details":$details}}""", retryAfter)

    @Test
    fun aClaimSendsTheCapabilityAndReadsTheKey() = runTest {
        val (transport, host) = api(ok("""{"deviceId":"d1","deviceKey":"k1","hostId":"h1"}"""))
        val paired = host.claim(code = "7K3MQ9XV2D", name = "ТСД 1", appVersion = "1.3.0", recoverDeviceId = null).getOrThrow()
        assertEquals(Triple("d1", "k1", "h1"), Triple(paired.deviceId, paired.deviceKey, paired.hostId))
        val body = transport.sent.single().third.orEmpty()
        assertTrue(body.contains("\"kind\":\"handheld\"") && body.contains("\"capabilities\":[\"handheld-host-v1\"]"))
        assertTrue("no recoverDeviceId when none", !body.contains("recoverDeviceId"))
    }

    @Test
    fun everyRefusalOfTheHostHasItsOwnReason() = runTest {
        val cases = listOf(
            error(400, "pairing_code_invalid") to HostFailure.PairingInvalid,
            error(400, "pairing_code_expired") to HostFailure.PairingExpired,
            error(429, "rate_limited") to HostFailure.RateLimited,
            error(409, "conflict", """{"constraint":"seat_limit"}""") to HostFailure.SeatLimit,
            error(409, "conflict", """{"constraint":"feature_disabled","feature":"handheld"}""") to HostFailure.FeatureDisabled,
            error(409, "conflict", """{"constraint":"license_restricted","state":"restricted"}""") to HostFailure.LicenseRestricted,
            error(409, "conflict", """{"constraint":"shift_busy"}""") to HostFailure.Constraint("shift_busy"),
            error(401, "unauthorized", """{"credential":"device"}""") to HostFailure.KeyRejected,
            error(403, "forbidden") to HostFailure.Forbidden,
            error(400, "protocol_unsupported") to HostFailure.ProtocolUnsupported,
            error(503, "restore_pending", """{"since":"2026-10-09T15:00:00Z"}""", retryAfter = 60) to HostFailure.RestorePending(60),
            HostResult.Ok(500, "boom", null) to HostFailure.ServerError(500),
        )
        for ((answer, expected) in cases) {
            val (_, host) = api(answer)
            assertEquals(expected, (host.claim("7K3MQ9XV2D", "ТСД 1", "1.3.0", null).exceptionOrNull() as HostApiError).failure)
        }
    }

    @Test
    fun aTransportFailureIsUnreachableTimeoutOrACertificateMismatch() = runTest {
        for ((failure, expected) in listOf(
            HostResult.Failed(TransportFailure.UNREACHABLE) to HostFailure.Unreachable,
            HostResult.Failed(TransportFailure.TIMEOUT) to HostFailure.Timeout,
            HostResult.Failed(TransportFailure.CERT_MISMATCH) to HostFailure.CertificateMismatch,
        )) {
            val (_, host) = api(failure)
            assertEquals(expected, (host.device().exceptionOrNull() as HostApiError).failure)
        }
    }

    @Test
    fun anAnswerThatIsNoJsonOfTheShapeIsABadResponseNotACrash() = runTest {
        val (_, host) = api(ok("not json"))
        assertEquals(HostFailure.BadResponse, (host.device().exceptionOrNull() as HostApiError).failure)
    }

    @Test
    fun aBatchOfFactsGoesAsFrozenBytesAndItsReceiptsComeBackInOrder() = runTest {
        val (transport, host) = api(
            ok("""{"receipts":[{"id":"r1","outcome":"accepted"},{"id":"r2","outcome":"rejected","code":"box_on_pallet","details":{"palletSscc":null,"palletId":"p"}}]}"""),
        )
        val frozen = """{"records":[{"id":"r1"},{"id":"r2"}]}"""
        val receipts = host.postFacts(frozen).getOrThrow()
        assertEquals(frozen, transport.sent.single().third)
        assertEquals("/v1/device/facts", transport.sent.single().second)
        assertEquals(listOf("accepted", "rejected"), receipts.map { it.outcome })
        assertEquals("box_on_pallet", receipts[1].code)
    }
}
