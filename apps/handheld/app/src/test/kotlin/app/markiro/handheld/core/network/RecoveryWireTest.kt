package app.markiro.handheld.core.network

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

class RecoveryWireTest {
    @Test fun interpretsTheSameStrictRequestFixturesAsTypeScript() {
        val content = checkNotNull(javaClass.classLoader?.getResource("station-recovery/requests.json")).readText()
        for (fixture in Json.parseToJsonElement(content).jsonArray) {
            val row = fixture.jsonObject
            assertEquals(row.getValue("name").jsonPrimitive.content, row.getValue("valid").jsonPrimitive.boolean,
                runCatching { RecoveryResponse.json.decodeFromString(RecoveryRequest.serializer(), row.getValue("request").toString()).validate() }.isSuccess)
        }
    }

    @Test fun interpretsTheSameStrictFixturesAsTypeScript() {
        val content = checkNotNull(javaClass.classLoader?.getResource("station-recovery/responses.json")).readText()
        for (fixture in Json.parseToJsonElement(content).jsonArray) {
            val row = fixture.jsonObject
            assertEquals(row.getValue("name").jsonPrimitive.content, row.getValue("valid").jsonPrimitive.boolean,
                runCatching { RecoveryResponse.decode(row.getValue("response").toString()) }.isSuccess)
        }
    }

    @Test fun recoveryUsesVersionedRouteExpectedIdentityAndIndependentCapability() = runTest {
        MockWebServer().use { server ->
            val content = checkNotNull(javaClass.classLoader?.getResource("station-recovery/responses.json")).readText()
            val good = Json.parseToJsonElement(content).jsonArray.first().jsonObject.getValue("response").toString()
            server.enqueue(MockResponse().setBody(good))
            val expected = RecoveryIdentity("tenant-existing", "00000000-0000-4000-8000-000000000001", "handheld")
            val client = PairingClient(OkHttpClient(), NetworkModule.json())
            assertTrue(client.recover(server.url("/").toString(), "12345678", expected) is PairingResult.Success)
            val sent = server.takeRequest()
            assertEquals("/station/pair/recovery", sent.path)
            assertTrue(checkNotNull(sent.getHeader("x-station-capabilities")).split(',').contains("handheld-v1"))
            assertNull(sent.getHeader("x-api-key"))
            assertEquals(RecoveryRequest(version = 1, code = "12345678", expected = expected), RecoveryResponse.json.decodeFromString(RecoveryRequest.serializer(), sent.body.readUtf8()))
        }
    }

    @Test fun unsupportedServerNeverFallsBackAndForeignResponseNeverPublishes() = runTest {
        MockWebServer().use { server ->
            val client = PairingClient(OkHttpClient(), NetworkModule.json())
            val expected = RecoveryIdentity("tenant-existing", "00000000-0000-4000-8000-000000000001", "handheld")
            for (status in listOf(404, 405)) {
                server.enqueue(MockResponse().setResponseCode(status))
                assertEquals(PairingResult.Failure(PairingError.UPDATE_REQUIRED), client.recover(server.url("/").toString(), "12345678", expected))
                assertEquals("/station/pair/recovery", server.takeRequest().path)
            }
            val content = checkNotNull(javaClass.classLoader?.getResource("station-recovery/responses.json")).readText()
            val good = Json.parseToJsonElement(content).jsonArray.first().jsonObject.getValue("response").toString()
            server.enqueue(MockResponse().setBody(good))
            assertEquals(PairingResult.Failure(PairingError.RECOVERY_MISMATCH), client.recover(server.url("/").toString(), "12345678", expected.copy(tenantId = "foreign")))
            assertEquals(3, server.requestCount)
        }
    }
    @Test fun aLostRecoveryResponseStaysUnavailableWithoutOrdinaryPairingFallback() = runTest {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("x".repeat(4096)).setSocketPolicy(okhttp3.mockwebserver.SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY))
            val expected = RecoveryIdentity("tenant-existing", "00000000-0000-4000-8000-000000000001", "handheld")
            val result = PairingClient(OkHttpClient(), NetworkModule.json()).recover(server.url("/").toString(), "12345678", expected)
            assertEquals(PairingResult.Failure(PairingError.UNAVAILABLE), result)
            assertEquals("/station/pair/recovery", server.takeRequest().path)
            assertEquals(1, server.requestCount)
        }
    }

}
