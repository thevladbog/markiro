package app.markiro.handheld.core.network.host

import java.security.MessageDigest

/**
 * The pin of a host's certificate: the lower-case hex SHA-256 of its DER (`markiro_proto::certificate_fingerprint`). A
 * device trusts exactly this one certificate; the names inside it do not matter. Kept in one small file for review (risk Р-10).
 */
object CertPin {
    private val HEX64 = Regex("^[0-9a-f]{64}$")

    fun isFingerprint(text: String): Boolean = HEX64.matches(text)

    fun fingerprintOf(der: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(der).joinToString("") { "%02x".format(it.toInt() and 0xff) }

    /** What the person compares with the office's screen: the first 32 characters, upper case, in groups of four. */
    fun display(fingerprint: String): String = fingerprint.take(32).uppercase().chunked(4).joinToString(" ")

    /** Whether `der` is the certificate `expected` names. Constant time over the two digests; a malformed pin matches nothing. */
    fun matches(expected: String, der: ByteArray): Boolean {
        if (!isFingerprint(expected)) return false
        return MessageDigest.isEqual(
            fingerprintOf(der).toByteArray(Charsets.US_ASCII),
            expected.toByteArray(Charsets.US_ASCII),
        )
    }
}
