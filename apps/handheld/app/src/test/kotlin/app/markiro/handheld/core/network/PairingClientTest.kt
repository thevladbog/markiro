package app.markiro.handheld.core.network

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class PairingClientTest {
    private val server = MockWebServer()
    private val client = PairingClient(OkHttpClient(), Json { ignoreUnknownKeys = true })

    @Before
    fun start() = server.start()

    @After
    fun stop() = server.shutdown()

    private fun base() = server.url("/").toString().trimEnd('/')

    @Test
    fun parsesAProvisioningResponseAndSendsTheHandheldCapability() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(201).setBody(
                """
                {"device":{"id":"dev-1","name":"ТСД 1","kind":"handheld","tenantId":"t-1","organizationName":"ООО «Родник»","line":{"id":"line-2","name":"Линия 2"}},
                 "credential":{"apiKey":"mk_live_abc","serverUrl":"https://admin.markiro.app"},
                 "operators":[{"operatorId":"op-1","name":"Иванова Анна","login":"4127","role":"operator","pinHash":"pbkdf2${'$'}sha256${'$'}100000${'$'}a${'$'}b","badgeHash":null,"active":true}],
                 "subscription":{"access":"managed","status":"active","startsAt":null,"endsAt":null}}
                """.trimIndent(),
            ),
        )
        val result = client.redeem(base(), "48124812")
        val success = result as PairingResult.Success
        assertEquals("handheld", success.response.device.kind)
        assertEquals("Линия 2", success.response.device.line?.name)
        assertEquals("mk_live_abc", success.response.credential.apiKey)
        assertEquals(1, success.response.operators.size)
        val request = server.takeRequest()
        assertEquals("/station/pair", request.path)
        assertEquals(HANDHELD_CAPABILITIES, request.getHeader("x-station-capabilities"))
        assertTrue(request.body.readUtf8().contains("\"code\":\"48124812\""))
    }

    @Test
    fun mapsEveryPairingErrorCode() = runTest {
        val cases = mapOf(
            "PAIR_INVALID" to PairingError.INVALID,
            "PAIR_EXPIRED" to PairingError.EXPIRED,
            "PAIR_LOCKED" to PairingError.LOCKED,
            "PAIR_RATE_LIMITED" to PairingError.RATE_LIMITED,
            "PAIR_KIND_MISMATCH" to PairingError.KIND_MISMATCH,
        )
        for ((code, expected) in cases) {
            server.enqueue(MockResponse().setResponseCode(401).setBody("""{"code":"$code"}"""))
            val result = client.redeem(base(), "00000000")
            assertEquals(expected, (result as PairingResult.Failure).error)
        }
    }

    @Test
    fun treatsUnreachableServersAndGarbageAsDistinctFailures() = runTest {
        server.enqueue(MockResponse().setResponseCode(201).setBody("not json"))
        assertEquals(PairingError.INVALID_RESPONSE, (client.redeem(base(), "11111111") as PairingResult.Failure).error)
        assertEquals(PairingError.INVALID, (client.redeem(base(), "12") as PairingResult.Failure).error)
        server.shutdown()
        assertEquals(PairingError.UNAVAILABLE, (client.redeem("http://127.0.0.1:1", "11111111") as PairingResult.Failure).error)
    }
}
