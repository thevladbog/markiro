package app.markiro.handheld.core.network.host

import java.io.File
import java.nio.file.Files
import java.security.KeyStore
import java.security.cert.X509Certificate
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory

/**
 * A throw-away self-signed ECDSA P-256 certificate (the host's own is ECDSA P-256 too), made with the JDK's `keytool`:
 * `okhttp-tls` is not in the offline Gradle cache, and a test of the trust code should not need a library to forge certificates.
 */
class TestTls private constructor(val certificate: X509Certificate, private val store: KeyStore) {
    val pin: String = CertPin.fingerprintOf(certificate.encoded)

    fun serverSocketFactory(): SSLSocketFactory {
        val keys = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm())
        keys.init(store, PASSWORD.toCharArray())
        return SSLContext.getInstance("TLS").also { it.init(keys.keyManagers, null, null) }.socketFactory
    }

    companion object {
        private const val PASSWORD = "changeit"

        /** The names in the certificate are never 127.0.0.1 / localhost: the pin, not the name, must decide. */
        fun create(commonName: String): TestTls {
            val dir = Files.createTempDirectory("markiro-tls").toFile()
            val file = File(dir, "k.p12")
            val keytool = File(System.getProperty("java.home"), "bin/keytool").path
            val process = ProcessBuilder(
                keytool, "-genkeypair", "-alias", "a", "-keyalg", "EC", "-groupname", "secp256r1", "-sigalg", "SHA256withECDSA",
                "-dname", "CN=$commonName", "-ext", "san=dns:host-$commonName.invalid", "-validity", "30",
                "-storetype", "PKCS12", "-keystore", file.path, "-storepass", PASSWORD,
            ).redirectErrorStream(true).start()
            val output = process.inputStream.bufferedReader().readText()
            check(process.waitFor() == 0) { "keytool failed: $output" }
            val store = KeyStore.getInstance("PKCS12")
            file.inputStream().use { store.load(it, PASSWORD.toCharArray()) }
            file.delete()
            dir.delete()
            return TestTls(store.getCertificate("a") as X509Certificate, store)
        }
    }
}
