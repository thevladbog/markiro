package app.markiro.handheld.core.network.host

import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The pairing code travels only through a client pinned to the certificate the person confirmed (real TLS, throw-away certificates). */
class HostPairingGatewayTest {
    private val servers = mutableListOf<MockWebServer>()

    @After
    fun stop() = servers.forEach { it.shutdown() }

    private fun serverOf(tls: TestTls): MockWebServer = MockWebServer().also {
        it.useHttps(tls.serverSocketFactory(), false)
        it.start()
        servers += it
    }

    private val hello = """{"product":"markiro-host","protocol":6,"minProtocol":1,"hostId":"3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f"}"""

    @Test
    fun observingReturnsTheCertificateTheHostPresentedAndAsksOnlyHello() = runTest {
        val tls = TestTls.create("host")
        val server = serverOf(tls)
        server.enqueue(MockResponse().setBody(hello))
        val observed = RealHostPairingGateway().observe(server.hostName, server.port).getOrThrow()
        assertEquals(tls.pin, observed.fingerprint)
        assertEquals("markiro-host", observed.hello.product)
        val request = server.takeRequest()
        assertEquals("GET", request.method)
        assertEquals("/v1/hello", request.path)
        assertEquals(null, request.getHeader("Authorization"))
    }

    @Test
    fun aClaimToAHostWithAnotherCertificateThanThePinIsRefusedBeforeAnyRequestReachesIt() = runTest {
        val shown = TestTls.create("impostor")
        val confirmed = TestTls.create("confirmed")
        val server = serverOf(shown)
        server.enqueue(MockResponse().setBody("""{"deviceId":"d1","deviceKey":"k1","hostId":"h1"}"""))
        val result = RealHostPairingGateway().claim(server.hostName, server.port, confirmed.pin, "7K3MQ9XV2D", null)
        assertEquals(HostFailure.CertificateMismatch, (result.exceptionOrNull() as HostApiError).failure)
        assertEquals("the code never left the device", 0, server.requestCount)
    }

    @Test
    fun aClaimToTheConfirmedCertificateSucceeds() = runTest {
        val tls = TestTls.create("host")
        val server = serverOf(tls)
        server.enqueue(MockResponse().setBody("""{"deviceId":"d1","deviceKey":"k1","hostId":"h1"}"""))
        val paired = RealHostPairingGateway().claim(server.hostName, server.port, tls.pin, "7K3MQ9XV2D", null).getOrThrow()
        assertEquals("d1", paired.deviceId)
        val request = server.takeRequest()
        assertEquals("/v1/pairing/claim", request.path)
        assertTrue(request.body.readUtf8().contains("7K3MQ9XV2D"))
    }
}
