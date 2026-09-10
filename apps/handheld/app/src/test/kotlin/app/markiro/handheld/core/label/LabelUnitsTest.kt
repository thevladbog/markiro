package app.markiro.handheld.core.label

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LabelUnitsTest {
    @Test
    fun millimetresConvertToDotsRoundingTiesUpward() {
        assertEquals(464, mmToDots(58.0, 203))
        assertEquals(320, mmToDots(40.0, 203))
        assertEquals(2, mmToDots(0.25, 203))
        assertEquals(-12, mmToDots(-1.5, 203))
        assertEquals(-1, mmToDots(-0.1, 203))
    }

    @Test
    fun tiesRoundTowardPositiveInfinityLikeJavaScript() {
        // Pinned on the helper rather than through a millimetre conversion, because no round
        // millimetre value lands exactly on half a dot once the floating-point division has run.
        //
        // Each of these disagrees with at least one of Kotlin's built-in choices: kotlin.math.round
        // takes ties to even and would give 2 for 2.5 and -2 for -1.5, while roundToInt takes them
        // away from zero and would give -1 for -0.5. JavaScript takes every tie upward.
        assertEquals(1, roundLikeJs(0.5))
        assertEquals(0, roundLikeJs(-0.5))
        assertEquals(2, roundLikeJs(1.5))
        assertEquals(-1, roundLikeJs(-1.5))
        assertEquals(3, roundLikeJs(2.5))
        assertEquals(-2, roundLikeJs(-2.5))
    }

    @Test
    fun pointsConvertToDotsAndMillimetres() {
        assertEquals(34, ptToDots(12.0, 203))
        assertEquals(50, ptToDots(12.0, 300))
        assertEquals(4.233333333333333, ptToMm(12.0), 1e-12)
    }

    @Test
    fun printerResolutionOverridesTheAuthoringOne() {
        val spec = LabelSpec(58.0, 40.0, 203, PrinterLanguage.ZPL, emptyList())
        assertTrue(spec === withPrinterDpi(spec, null))
        assertTrue(spec === withPrinterDpi(spec, 203))
        assertEquals(300, withPrinterDpi(spec, 300).dpi)
        assertEquals(58.0, withPrinterDpi(spec, 300).widthMm, 0.0)
    }

    @Test
    fun onlyPrintableAsciiStaysNative() {
        assertFalse(needsImageRendering("ACME Foods 04600682000013"))
        assertFalse(needsImageRendering(""))
        assertTrue(needsImageRendering("Вода"))
        assertTrue(needsImageRendering("café"))
        assertTrue(needsImageRendering("a\tb"))
        // Iterated by code point, so an astral character counts once and is out of range.
        assertTrue(needsImageRendering("😀"))
    }

    @Test
    fun fieldsAreFormattedForDisplay() {
        val data = mapOf(
            LabelField.SSCC to "346006820000000014",
            LabelField.QTY to "20",
            LabelField.PRODUCT_NAME to "Вода",
        )
        assertEquals("(00)346006820000000014", labelFieldDisplayValue(LabelField.SSCC, data, null))
        assertEquals("20 шт.", labelFieldDisplayValue(LabelField.QTY, data, null))
        assertEquals("Вода", labelFieldDisplayValue(LabelField.PRODUCT_NAME, data, null))
        assertEquals("", labelFieldDisplayValue(LabelField.OPERATOR, data, null))
        assertEquals("5 шт.", labelFieldDisplayValue(LabelField.QTY, mapOf(LabelField.QTY to "5 шт."), null))
        assertEquals("12 кг", labelFieldDisplayValue(LabelField.QTY, mapOf(LabelField.QTY to "12 кг"), null))
        // The crypto tail is dropped: the value becomes the application identifier, the GTIN, then
        // the serial identifier and the serial.
        assertEquals(
            "010460068200001321abcDEF1234567",
            labelFieldDisplayValue(
                LabelField.KM_CODE,
                mapOf(LabelField.KM_CODE to "010460068200001321abcDEF123456793ZZZZ"),
                TextFormat.KM_WITHOUT_CRYPTO,
            ),
        )
        assertEquals(
            "",
            labelFieldDisplayValue(LabelField.KM_CODE, mapOf(LabelField.KM_CODE to "nonsense"), TextFormat.KM_WITHOUT_CRYPTO),
        )
    }
}
