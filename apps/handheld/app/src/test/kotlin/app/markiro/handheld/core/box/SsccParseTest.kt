package app.markiro.handheld.core.box

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Reading a box label back, which nothing on this device needed until exceptions. */
class SsccParseTest {
    @Test
    fun aScannedLabelIsReadInEveryShapeAScannerEmits() {
        assertEquals("046800899000000018", Sscc.parse("046800899000000018"))
        assertEquals("046800899000000018", Sscc.parse("(00)046800899000000018"))
        assertEquals("046800899000000018", Sscc.parse("00046800899000000018"))
        assertEquals("046800899000000018", Sscc.parse("  046800899000000018\r\n"))
    }

    /** A number starting 00 is a real SSCC, not an element string with the AI. */
    @Test
    fun anSsccBeginningWithZerosSurvives() {
        assertEquals("004680089900000001", Sscc.parse("004680089900000001"))
    }

    @Test
    fun anythingThatIsNotAnSsccIsNotGuessedAt() {
        assertNull(Sscc.parse(""))
        assertNull(Sscc.parse("0104600682000013215Y7HG9"))
        assertNull(Sscc.parse("04680089900000001"))
        assertNull(Sscc.parse("04680089900000001X"))
    }

    /** What `build` produces is what `parse` reads back. */
    @Test
    fun everyBuiltNumberParses() {
        val built = Sscc.build(0, "468008990", 17)
        assertEquals(built, Sscc.parse(built))
        assertEquals(built, Sscc.parse("(00)$built"))
    }
}
