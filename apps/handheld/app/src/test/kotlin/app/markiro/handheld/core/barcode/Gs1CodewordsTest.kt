package app.markiro.handheld.core.barcode

import app.markiro.handheld.core.label.LabelRenderException
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** GS1's AI separator, written as an escape so no control byte lands in this file. */
private const val GS = "\u001d"

class Gs1CodewordsTest {
    /**
     * "01" plus a GTIN-14 is sixteen digits, so ASCII encodation pairs all of
     * them: a pair's codeword is 130 plus its two-digit value.
     */
    @Test
    fun digitsArePairedAfterTheLeadingFnc1() {
        assertArrayEquals(
            intArrayOf(232, 131, 134, 190, 136, 212, 130, 130, 143),
            gs1Codewords("0104600682000013"),
        )
    }

    /** A separator is an FNC1 codeword, never the literal GS byte, and pairing restarts after it. */
    @Test
    fun separatorsBecomeFnc1AndBreakPairing() {
        assertArrayEquals(
            intArrayOf(232, 151, 66, 232, 223, 67),
            gs1Codewords("21A${GS}93B"),
        )
    }

    /** An unpaired trailing digit falls back to plain ASCII: its code plus one. */
    @Test
    fun anOddTrailingDigitIsEncodedAsAscii() {
        assertArrayEquals(intArrayOf(232, 151, 52), gs1Codewords("213"))
    }

    /**
     * The first pad is a plain 129; every later one is randomised by its own
     * 1-based position, which is what stops a run of identical modules.
     */
    @Test
    fun paddingIsPlainThenRandomised() {
        assertArrayEquals(
            intArrayOf(232, 131, 134, 190, 136, 212, 130, 130, 143, 129, 251, 147),
            padCodewords(gs1Codewords("0104600682000013"), 12),
        )
    }

    @Test
    fun paddingAnAlreadyFullStreamChangesNothing() {
        val codewords = gs1Codewords("0104600682000013")
        assertArrayEquals(codewords, padCodewords(codewords, codewords.size))
    }

    @Test
    fun aStreamLongerThanTheCapacityIsRejected() {
        val codewords = gs1Codewords("0104600682000013")
        val error = assertThrows(LabelRenderException::class.java) {
            padCodewords(codewords, codewords.size - 1)
        }
        assertTrue(error.message.orEmpty().contains("capacity"))
    }
}
