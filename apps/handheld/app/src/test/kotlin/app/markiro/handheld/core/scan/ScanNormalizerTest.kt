package app.markiro.handheld.core.scan

import org.junit.Assert.assertEquals
import org.junit.Test

class ScanNormalizerTest {
    private val gs = ""

    @Test
    fun keepsARealGroupSeparator() {
        assertEquals(
            "0104680089900383217XQ4K2A${gs}91EE10",
            ScanNormalizer.normalize("0104680089900383217XQ4K2A${gs}91EE10"),
        )
    }

    @Test
    fun replacesTextualSubstitutesWithTheSeparator() {
        assertEquals("01046800${gs}91EE10", ScanNormalizer.normalize("01046800<GS>91EE10"))
        assertEquals("01046800${gs}91EE10", ScanNormalizer.normalize("01046800{GS}91EE10"))
        assertEquals("01046800${gs}91EE10", ScanNormalizer.normalize("01046800\\x1d91EE10"))
    }

    @Test
    fun stripsAnAimIdentifierPrefixAndLineEndings() {
        assertEquals("0104680089900383", ScanNormalizer.normalize("]d20104680089900383\r\n"))
        assertEquals("4680089900383", ScanNormalizer.normalize("]E04680089900383\n"))
    }
}
