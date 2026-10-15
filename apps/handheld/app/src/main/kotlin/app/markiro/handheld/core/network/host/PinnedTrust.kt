package app.markiro.handheld.core.network.host

import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.X509TrustManager

/** The certificate the host presents is not the one this device was paired with. Recognised by the cause chain of an `IOException`. */
class FingerprintMismatch(val seen: String) : CertificateException("the server's certificate is not the paired one")

/**
 * Trusts exactly one certificate: the SHA-256 of the leaf's DER equals the pin. Neither the chain, nor the dates, nor the names are
 * looked at — the certificate is self-signed and its names do not matter (the host's own `tls.rs` says so). The system's trust store
 * and user-installed certificates take no part. Risk Р-10: this file is small on purpose.
 */
class PinnedTrustManager(private val expected: String) : X509TrustManager {
    override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {
        throw CertificateException("this device does not authenticate clients")
    }

    override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
        val leaf = chain.firstOrNull() ?: throw CertificateException("the server sent no certificate")
        val der = leaf.encoded
        if (!CertPin.matches(expected, der)) throw FingerprintMismatch(CertPin.fingerprintOf(der))
    }

    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}

/**
 * For pairing by hand: accepts any certificate and remembers the leaf's fingerprint, so the person can compare it with the office's
 * screen. The client built with it only ever asks `GET /v1/hello` (`HostApi.observeHello`); a code or a key never goes through it.
 */
class ObservingTrustManager : X509TrustManager {
    @Volatile
    var observed: String? = null
        private set

    override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {
        throw CertificateException("this device does not authenticate clients")
    }

    override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
        val leaf = chain.firstOrNull() ?: throw CertificateException("the server sent no certificate")
        observed = CertPin.fingerprintOf(leaf.encoded)
    }

    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}
