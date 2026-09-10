package app.markiro.handheld.core.network

import app.cash.turbine.test
import app.markiro.handheld.core.storage.InMemoryCredentialStore
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

class InterceptorsTest {
    private val server = MockWebServer()
    private val credential = InMemoryCredentialStore()
    private val reachability = ReachabilityTracker()
    private val revocation = RevocationBus()
    private val client = OkHttpClient.Builder()
        .addInterceptor(ApiKeyInterceptor(credential))
        .addInterceptor(CapabilitiesInterceptor())
        .addInterceptor(RevocationInterceptor(revocation))
        .addInterceptor(ReachabilityInterceptor(reachability))
        .build()

    @Before
    fun start() = server.start()

    @After
    fun stop() = server.shutdown()

    @Test
    fun sendsTheKeyAndCapabilitiesAndRecordsSuccess() {
        credential.write("mk_live_abc")
        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        client.newCall(Request.Builder().url(server.url("/station/identity")).build()).execute().close()
        val request = server.takeRequest()
        assertEquals("mk_live_abc", request.getHeader("x-api-key"))
        assertEquals(HANDHELD_CAPABILITIES, request.getHeader("x-station-capabilities"))
        assertNotNull(reachability.lastSuccessAt.value)
    }

    @Test
    fun omitsTheKeyHeaderWhenUnpaired() {
        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        client.newCall(Request.Builder().url(server.url("/station/pair")).build()).execute().close()
        assertNull(server.takeRequest().getHeader("x-api-key"))
    }

    @Test
    fun raisesRevocationOnTheDocumentedRejectionOnly() = runTest {
        credential.write("mk_live_abc")
        revocation.events.test {
            server.enqueue(MockResponse().setResponseCode(401).setBody("""{"code":"STATION_CREDENTIAL_REVOKED"}"""))
            client.newCall(Request.Builder().url(server.url("/shifts")).build()).execute().close()
            awaitItem()
            server.enqueue(MockResponse().setResponseCode(401).setBody("""{"code":"PAIR_INVALID"}"""))
            client.newCall(Request.Builder().url(server.url("/shifts")).build()).execute().close()
            expectNoEvents()
        }
    }
}
