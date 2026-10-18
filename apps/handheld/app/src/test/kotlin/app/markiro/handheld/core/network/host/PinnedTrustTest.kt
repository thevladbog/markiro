package app.markiro.handheld.core.network.host

import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.lang.reflect.Proxy
import java.net.Proxy as NetProxy
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.SSLSession

/**
 * Risk Р-10 of the spec: a pinned trust manager that accepts anything would lose the whole protection, so the negative
 * tests come first. Real TLS over MockWebServer with throw-away ECDSA certificates.
 */
class PinnedTrustTest {
    private val servers = mutableListOf<MockWebServer>()

    @After
    fun stop() = servers.forEach { it.shutdown() }

    private fun serverOf(tls: TestTls): MockWebServer = MockWebServer().also {
        it.useHttps(tls.serverSocketFactory(), false)
        it.start()
        servers += it
    }

    private fun get(client: OkHttpClient, server: MockWebServer, path: String = "/v1/hello") =
        client.newCall(Request.Builder().url(server.url(path)).build())

    private fun causes(failure: Throwable?) = generateSequence(failure) { it.cause }

    // ---- the pinned trust manager itself ----

    @Test
    fun theManagerAcceptsTheLeafOfThePinAndNothingElse() {
        val paired = TestTls.create("paired")
        val other = TestTls.create("other")
        val manager = PinnedTrustManager(paired.pin)
        manager.checkServerTrusted(arrayOf(paired.certificate), "ECDHE_ECDSA")
        val failure = runCatching { manager.checkServerTrusted(arrayOf(other.certificate), "ECDHE_ECDSA") }.exceptionOrNull()
        assertTrue("$failure", failure is FingerprintMismatch)
        assertEquals(other.pin, (failure as FingerprintMismatch).seen)
    }

    @Test
    fun onlyTheLeafCountsAPinnedCertificateBehindAnImpostorLeafIsRefused() {
        val paired = TestTls.create("paired")
        val impostor = TestTls.create("impostor")
        val manager = PinnedTrustManager(paired.pin)
        assertTrue(
            runCatching { manager.checkServerTrusted(arrayOf(impostor.certificate, paired.certificate), "ECDHE_ECDSA") }
                .exceptionOrNull() is FingerprintMismatch,
        )
    }

    @Test
    fun anEmptyChainIsRefused() {
        val paired = TestTls.create("paired")
        assertTrue(
            runCatching { PinnedTrustManager(paired.pin).checkServerTrusted(emptyArray(), "ECDHE_ECDSA") }.exceptionOrNull() is CertificateException,
        )
    }

    @Test
    fun aMalformedPinTrustsNothingEvenTheCertificateItWasMeantFor() {
        val paired = TestTls.create("paired")
        for (pin in listOf("", paired.pin.uppercase(), paired.pin.dropLast(2), "zz".repeat(32), paired.pin + "0")) {
            assertTrue(
                pin,
                runCatching { PinnedTrustManager(pin).checkServerTrusted(arrayOf(paired.certificate), "ECDHE_ECDSA") }
                    .exceptionOrNull() is FingerprintMismatch,
            )
        }
    }

    @Test
    fun noManagerAuthenticatesClientsOrNamesIssuers() {
        val paired = TestTls.create("paired")
        for (manager in listOf(PinnedTrustManager(paired.pin), ObservingTrustManager())) {
            assertTrue(
                runCatching { manager.checkClientTrusted(arrayOf(paired.certificate), "ECDHE_ECDSA") }.exceptionOrNull() is CertificateException,
            )
            assertEquals(0, manager.acceptedIssuers.size)
        }
    }

    @Test
    fun theObservingManagerRecordsTheFingerprintAndRefusesAnEmptyChain() {
        val tls = TestTls.create("observed")
        val manager = ObservingTrustManager()
        assertNull(manager.observed)
        assertTrue(runCatching { manager.checkServerTrusted(emptyArray(), "x") }.exceptionOrNull() is CertificateException)
        assertNull(manager.observed)
        manager.checkServerTrusted(arrayOf(tls.certificate), "ECDHE_ECDSA")
        assertEquals(tls.pin, manager.observed)
    }


    @Test fun thePinnedClientSendsOnlyTheSuppliedProcessDatasetEpoch() {
        val host = TestTls.create("dataset-host")
        val server = serverOf(host).also { it.enqueue(MockResponse().setBody("{}")) }
        val epoch = "8b134f46-5501-4ba2-931e-fde1e7251951"
        val client = HostHttpClient.pinned(host.pin, datasetEpoch = { epoch }) { "key" }
        get(client, server).execute().use { assertEquals(200, it.code) }
        assertEquals(epoch, server.takeRequest().getHeader("x-markiro-dataset-epoch"))
    }

    // ---- the pinned client over real TLS ----

    @Test
    fun theCertificateOfThePinIsTrustedWhateverItsNamesAre() {
        val host = TestTls.create("markiro-host")
        val server = serverOf(host).also { it.enqueue(MockResponse().setBody("""{"ok":true}""")) }
        val client = HostHttpClient.pinned(host.pin) { "device-key" }
        get(client, server).execute().use { response -> assertEquals(200, response.code) }
        val request = server.takeRequest()
        assertEquals("Bearer device-key", request.getHeader("Authorization"))
        assertEquals(HostCompat.PROTOCOL.toString(), request.getHeader("x-markiro-protocol"))
        assertTrue(request.getHeader("x-markiro-app-version").orEmpty().isNotBlank())
    }

    @Test
    fun anotherCertificateIsRefusedAtTheHandshakeAndNoRequestReachesTheServer() {
        val paired = TestTls.create("paired")
        val impostor = TestTls.create("impostor")
        val server = serverOf(impostor).also { it.enqueue(MockResponse().setBody("secret")) }
        val client = HostHttpClient.pinned(paired.pin) { "device-key" }
        val failure = runCatching { get(client, server).execute().close() }.exceptionOrNull()
        assertTrue("$failure", failure is IOException)
        assertTrue(causes(failure).any { it is FingerprintMismatch })
        assertEquals("not a byte of the request leaves the device", 0, server.requestCount)
    }

    @Test
    fun aMalformedPinTrustsNothingOverTls() {
        val host = TestTls.create("markiro-host")
        val server = serverOf(host).also { it.enqueue(MockResponse()) }
        for (pin in listOf("", host.pin.uppercase(), host.pin.dropLast(2), "zz".repeat(32))) {
            val client = HostHttpClient.pinned(pin) { "k" }
            assertTrue(pin, runCatching { get(client, server).execute().close() }.isFailure)
        }
        assertEquals(0, server.requestCount)
    }

    @Test
    fun theKeyIsReadPerRequestAndWithoutAKeyNoAuthorizationGoes() {
        val host = TestTls.create("markiro-host")
        val server = serverOf(host).also { repeat(2) { _ -> it.enqueue(MockResponse()) } }
        var key: String? = null
        val client = HostHttpClient.pinned(host.pin) { key }
        get(client, server).execute().close()
        key = "k2"
        get(client, server).execute().close()
        assertNull(server.takeRequest().getHeader("Authorization"))
        assertEquals("Bearer k2", server.takeRequest().getHeader("Authorization"))
    }

    // The hostname check re-reads the peer, so it is the second lock on the same door.
    @Test
    fun theHostnameVerifierAcceptsOnlyASessionWithThePinnedLeaf() {
        val paired = TestTls.create("paired")
        val other = TestTls.create("other")
        val verifier = HostHttpClient.pinned(paired.pin) { null }.hostnameVerifier
        fun session(vararg chain: X509Certificate) = Proxy.newProxyInstance(
            javaClass.classLoader,
            arrayOf(SSLSession::class.java),
        ) { _, method, _ ->
            if (method.name == "getPeerCertificates") chain else throw UnsupportedOperationException(method.name)
        } as SSLSession
        assertTrue(verifier.verify("anything", session(paired.certificate)))
        assertFalse(verifier.verify("anything", session(other.certificate)))
        assertFalse(verifier.verify("anything", session()))
    }

    // ---- https only, no proxy, no redirect ----

    @Test
    fun plainHttpIsRefusedBeforeAnyConnection() {
        val plain = MockWebServer().also { it.enqueue(MockResponse()); it.start(); servers += it }
        val client = HostHttpClient.pinned("ab".repeat(32)) { "k" }
        val failure = runCatching {
            client.newCall(Request.Builder().url(plain.url("/v1/hello")).build()).execute().close()
        }.exceptionOrNull()
        assertTrue("$failure", failure is IOException)
        assertEquals(0, plain.requestCount)
    }

    @Test
    fun theObservingClientRefusesPlainHttpToo() {
        val plain = MockWebServer().also { it.enqueue(MockResponse()); it.start(); servers += it }
        val client = HostHttpClient.observing(ObservingTrustManager())
        assertTrue(runCatching { client.newCall(Request.Builder().url(plain.url("/v1/hello")).build()).execute().close() }.isFailure)
        assertEquals(0, plain.requestCount)
    }

    // The https-only interceptor and the connection spec are two locks; this checks the interceptor on its own,
    // on a client that otherwise WOULD speak cleartext.
    @Test
    fun theHttpsOnlyInterceptorAloneStopsAClearTextRequest() {
        val plain = MockWebServer().also { it.enqueue(MockResponse()); it.start(); servers += it }
        val client = OkHttpClient.Builder().addInterceptor(HttpsOnly).build()
        val failure = runCatching { client.newCall(Request.Builder().url(plain.url("/")).build()).execute().close() }.exceptionOrNull()
        assertTrue("$failure", failure is IOException)
        assertEquals(0, plain.requestCount)
    }

    @Test
    fun theConnectionSpecsAloneHaveNoClearText() {
        for (client in listOf(HostHttpClient.pinned("ab".repeat(32)) { null }, HostHttpClient.observing(ObservingTrustManager()))) {
            assertTrue(client.connectionSpecs.isNotEmpty())
            assertTrue(client.connectionSpecs.all { it.isTls })
        }
    }

    @Test
    fun noProxyAndNoRedirectPolicyIsConfigured() {
        for (client in listOf(HostHttpClient.pinned("ab".repeat(32)) { null }, HostHttpClient.observing(ObservingTrustManager()))) {
            assertSame(NetProxy.NO_PROXY, client.proxy)
            assertFalse(client.followRedirects)
            assertFalse(client.followSslRedirects)
        }
    }

    @Test
    fun aRedirectIsNotFollowed() {
        val host = TestTls.create("markiro-host")
        val target = serverOf(host).also { it.enqueue(MockResponse().setBody("elsewhere")) }
        val server = serverOf(host).also {
            it.enqueue(MockResponse().setResponseCode(302).addHeader("Location", target.url("/stolen").toString()))
        }
        val client = HostHttpClient.pinned(host.pin) { "k" }
        get(client, server).execute().use { assertEquals(302, it.code) }
        assertEquals(1, server.requestCount)
        assertEquals("the redirect target is never asked, with the key or without", 0, target.requestCount)
    }

    @Test
    fun aRedirectToClearTextIsNotFollowedEither() {
        val host = TestTls.create("markiro-host")
        val plain = MockWebServer().also { it.enqueue(MockResponse()); it.start(); servers += it }
        val server = serverOf(host).also {
            it.enqueue(MockResponse().setResponseCode(301).addHeader("Location", plain.url("/x").toString()))
        }
        val client = HostHttpClient.pinned(host.pin) { "k" }
        get(client, server).execute().use { assertEquals(301, it.code) }
        assertEquals(0, plain.requestCount)
    }

    // ---- observing mode only observes ----

    private val helloBody =
        """{"product":"markiro-host","protocol":6,"minProtocol":1,"hostId":"3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f","version":"0.1.0","time":"2026-10-15T09:00:00Z","initialized":true}"""

    @Test
    fun theObservingClientReadsTheFingerprintAndSendsNothingButAHello() = runTest {
        val host = TestTls.create("markiro-host")
        val server = serverOf(host).also { it.enqueue(MockResponse().setBody(helloBody)) }
        val observer = ObservingTrustManager()
        val hello = HostApi.observeHello(HostHttpClient.observing(observer), server.hostName, server.port)
        assertEquals(6, hello.protocol)
        assertEquals(host.pin, observer.observed)
        val request = server.takeRequest()
        assertEquals("GET", request.method)
        assertEquals("/v1/hello", request.path)
        assertNull("no key and no code go to a host that is not yet verified", request.getHeader("Authorization"))
        assertEquals(0L, request.bodySize)
    }

    @Test
    fun theObservingClientCannotCarryACodeOrAKeyEvenByMistake() {
        val host = TestTls.create("markiro-host")
        val server = serverOf(host).also { repeat(4) { _ -> it.enqueue(MockResponse().setBody(helloBody)) } }
        val client = HostHttpClient.observing(ObservingTrustManager())
        val url = server.url("/v1/hello")
        val attempts = listOf(
            Request.Builder().url(server.url("/v1/pairing/claim")).post("""{"code":"7K3MQ9XV2D"}""".toRequestBody()).build(),
            Request.Builder().url(url).post("{}".toRequestBody()).build(),
            Request.Builder().url(server.url("/v1/device")).get().build(),
            Request.Builder().url(url).header("Authorization", "Bearer key").get().build(),
        )
        for (attempt in attempts) {
            val failure = runCatching { client.newCall(attempt).execute().close() }.exceptionOrNull()
            assertTrue("${attempt.method} ${attempt.url.encodedPath}: $failure", failure is IOException)
        }
        assertEquals(0, server.requestCount)
    }

    @Test
    fun theObservingClientDoesNotVerifyAnythingSoItIsNeverTheOneThatPairs() {
        // Documented property: it accepts any certificate. The claim goes only through `pinned`, which a test above shows refusing.
        val any = TestTls.create("anything")
        val server = serverOf(any).also { it.enqueue(MockResponse().setBody(helloBody)) }
        val observer = ObservingTrustManager()
        HostHttpClient.observing(observer).newCall(Request.Builder().url(server.url("/v1/hello")).build()).execute().close()
        assertEquals(any.pin, observer.observed)
    }

    @Test
    fun observingTwoHostsRecordsTheLatestOne() {
        val a = TestTls.create("a")
        val b = TestTls.create("b")
        val sa = serverOf(a).also { it.enqueue(MockResponse().setBody(helloBody)) }
        val sb = serverOf(b).also { it.enqueue(MockResponse().setBody(helloBody)) }
        val observer = ObservingTrustManager()
        val client = HostHttpClient.observing(observer)
        client.newCall(Request.Builder().url(sa.url("/v1/hello")).build()).execute().close()
        assertEquals(a.pin, observer.observed)
        client.newCall(Request.Builder().url(sb.url("/v1/hello")).build()).execute().close()
        assertEquals(b.pin, observer.observed)
    }
}
