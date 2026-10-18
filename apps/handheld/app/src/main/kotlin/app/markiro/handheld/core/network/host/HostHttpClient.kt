package app.markiro.handheld.core.network.host

import app.markiro.handheld.BuildConfig
import okhttp3.ConnectionSpec
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Response
import java.io.IOException
import java.net.Proxy
import java.security.SecureRandom
import java.util.concurrent.TimeUnit
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/** Host mode speaks HTTPS only, in every build: the debug build's cleartext allowance is for the cloud's local API. */
internal object HttpsOnly : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        if (!chain.request().url.isHttps) throw IOException("host mode speaks https only")
        return chain.proceed(chain.request())
    }
}

/**
 * The observing client may ask exactly one question: `GET /v1/hello`, bodiless and without credentials. A code or a key cannot
 * reach a host that is not yet verified even by a caller's mistake.
 */
internal object ObserveOnly : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val allowed = request.method == "GET" && request.url.encodedPath == "/v1/hello" && request.body == null &&
            request.header("Authorization") == null
        if (!allowed) throw IOException("an unverified host is only asked hello")
        return chain.proceed(request)
    }
}

/** The headers the host asks of a device: its protocol and its app's version, and the key as a bearer token. */
private class DeviceHeaders(private val key: () -> String?, private val datasetEpoch: () -> String?) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val builder = chain.request().newBuilder()
            .header("x-markiro-protocol", HostCompat.PROTOCOL.toString())
            .header("x-markiro-app-version", BuildConfig.VERSION_NAME)
        key()?.let { builder.header("Authorization", "Bearer $it") }
        datasetEpoch()?.let { builder.header("x-markiro-dataset-epoch", it) }
        return chain.proceed(builder.build())
    }
}

object HostHttpClient {
    private fun base(): OkHttpClient.Builder = OkHttpClient.Builder()
        .proxy(Proxy.NO_PROXY)
        .followRedirects(false)
        .followSslRedirects(false)
        // MODERN_TLS: TLS 1.3 and 1.2 with the AEAD suites; no cleartext connection spec at all.
        .connectionSpecs(listOf(ConnectionSpec.MODERN_TLS))
        .connectTimeout(2, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .writeTimeout(10, TimeUnit.SECONDS)
        .callTimeout(30, TimeUnit.SECONDS)
        .addInterceptor(HttpsOnly)

    private fun OkHttpClient.Builder.trusting(trust: X509TrustManager, verifier: HostnameVerifier): OkHttpClient.Builder {
        val context = SSLContext.getInstance("TLS")
        context.init(null, arrayOf(trust), SecureRandom())
        return sslSocketFactory(context.socketFactory, trust).hostnameVerifier(verifier)
    }

    /**
     * The client of a paired device: it trusts the certificate whose fingerprint is `pin` and no other. The hostname check passes
     * only after the handshake went through [PinnedTrustManager]: it re-reads the peer's leaf and compares it with the pin, so the
     * single place that ignores the name is this one.
     */
    fun pinned(pin: String, datasetEpoch: () -> String? = { null }, key: () -> String?): OkHttpClient = base()
        .trusting(PinnedTrustManager(pin)) { _, session ->
            runCatching { CertPin.matches(pin, session.peerCertificates.first().encoded) }.getOrDefault(false)
        }
        .addInterceptor(DeviceHeaders(key, datasetEpoch))
        .build()

    /** The client for looking at a host that is not yet verified: no key, no code, certificate recorded in `observer`. */
    fun observing(observer: ObservingTrustManager): OkHttpClient = base()
        .trusting(observer) { _, _ -> true }
        .addInterceptor(ObserveOnly)
        .build()
}
