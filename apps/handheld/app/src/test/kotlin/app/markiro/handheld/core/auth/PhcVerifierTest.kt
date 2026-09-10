package app.markiro.handheld.core.auth

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PhcVerifierTest {
    // salt = bytes 0..15, secret "1234", 100000 iterations
    private val v1 = "pbkdf2\$sha256\$100000\$AAECAwQFBgcICQoLDA0ODw==\$hp5sg1DFvrCsw5n7qsO2DSIEM4lrJqZHc00NjxWG4fo="
    // salt = bytes 255..240, secret "4821", 100000 iterations (the server's pin-hash.ts layout)
    private val v2 = "pbkdf2\$sha256\$100000\$//79/Pv6+fj39vX08/Lx8A==\$vnKOJ9tCMFhFLJvDRw80Z7LCYxPrUj6dT6uhgeSIwVM="
    // salt = bytes (i*17)%256, secret "735519", exactly the 10000-iteration floor
    private val v3 = "pbkdf2\$sha256\$10000\$ABEiM0RVZneImaq7zN3u/w==\$73dv9sAwMBY3IQrFX3Cp8pxM5Qn8KjP8pPTRAPs+xkc="
    // same as v1 but 1 iteration: correct digest for that cost, still refused
    private val v4 = "pbkdf2\$sha256\$1\$AAECAwQFBgcICQoLDA0ODw==\$i/F57D1qcIBBiv5AzlKB8LqqXqCNwubIJuZH8P6K1uI="

    @Test fun verifiesKnownVectors() {
        assertTrue(PhcVerifier.verify("1234", v1))
        assertTrue(PhcVerifier.verify("4821", v2))
        assertTrue(PhcVerifier.verify("735519", v3))
    }

    @Test fun rejectsWrongSecret() {
        assertFalse(PhcVerifier.verify("0000", v1))
        assertFalse(PhcVerifier.verify("", v1))
    }

    @Test fun rejectsIterationsBelowTheFloor() {
        assertFalse(PhcVerifier.verify("1234", v4))
    }

    @Test fun rejectsMalformedOrNonCanonicalStrings() {
        assertFalse(PhcVerifier.verify("1234", "not-a-phc"))
        assertFalse(PhcVerifier.verify("1234", "argon2\$x\$y\$z\$w"))
        assertFalse(PhcVerifier.verify("1234", v1.replace("DA0ODw==", "DA0ODw")))
        assertFalse(PhcVerifier.verify("1234", v1.substring(0, v1.length - 4)))
    }
}
