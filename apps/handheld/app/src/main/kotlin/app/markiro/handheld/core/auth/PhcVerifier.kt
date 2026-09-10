package app.markiro.handheld.core.auth

import java.security.MessageDigest
import java.util.Base64
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

/**
 * Byte-for-byte port of apps/station/src/lib/crypto.ts and packages/domain/src/crypto/phc.ts:
 * `pbkdf2$sha256$<iter>$<saltB64>$<hashB64>`, 32-byte key, 16-byte salt, canonical base64
 * with padding, a 10 000-iteration floor and a constant-time comparison.
 */
object PhcVerifier {
    private const val MIN_ITERATIONS = 10_000
    private const val KEY_BYTES = 32
    private const val SALT_BYTES = 16

    fun verify(secret: String, phc: String): Boolean {
        val parts = phc.split('$')
        if (parts.size != 5 || parts[0] != "pbkdf2" || parts[1] != "sha256") return false
        val iterations = parts[2].toIntOrNull() ?: return false
        if (iterations < MIN_ITERATIONS) return false
        val salt = decodeCanonical(parts[3], SALT_BYTES) ?: return false
        val expected = decodeCanonical(parts[4], KEY_BYTES) ?: return false
        val actual = derive(secret, salt, iterations)
        return MessageDigest.isEqual(actual, expected)
    }

    private fun derive(secret: String, salt: ByteArray, iterations: Int): ByteArray {
        // PBKDF2WithHmacSHA256 encodes the password as UTF-8 on Android 26+ and on the JVM,
        // matching TextEncoder in the station and Buffer.from(secret) on the server.
        val spec = PBEKeySpec(secret.toCharArray(), salt, iterations, KEY_BYTES * 8)
        return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
    }

    private fun decodeCanonical(value: String, expectedBytes: Int): ByteArray? {
        val decoded = try {
            Base64.getDecoder().decode(value)
        } catch (_: IllegalArgumentException) {
            return null
        }
        if (decoded.size != expectedBytes) return null
        if (Base64.getEncoder().encodeToString(decoded) != value) return null
        return decoded
    }
}
