package app.markiro.handheld.core.label

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class LotNumberRenderingTest {
    private val renderer = LabelRenderer(AndroidTextRasterizer(ApplicationProvider.getApplicationContext()))

    @Test
    fun optionalFieldsHideTheirCaptionsAndLotValueWhenAbsent() = runTest {
        val spec = spec(
            """
            {"id":"lot-caption","kind":"text","text":"Lot","fontSizePt":10,"xMm":4,"yMm":0,
             "when":{"field":"shift.lotNumber","op":"present"}},
            {"id":"egais-caption","kind":"text","text":"EGAIS","fontSizePt":10,"xMm":4,"yMm":12,
             "when":{"field":"product.egais","op":"present"}},
            $lot
            """.trimIndent(),
        )
        val zpl = generateZpl(spec, emptyMap(), null)
        val tspl = generateTspl(spec, emptyMap(), null).toString(Charsets.ISO_8859_1)
        for (output in listOf(zpl, tspl)) {
            assertFalse(output.contains("Lot"))
            assertFalse(output.contains("EGAIS"))
            assertFalse(output.contains("^GFA"))
            assertFalse(output.contains("BITMAP"))
        }
        assertTrue(generateZpl(spec, mapOf(LabelField.PRODUCT_EGAIS to "42"), null).contains("EGAIS"))
    }

    @Test
    fun lotValueFitsWithItsDistinctiveLastGlyphInBothPrinterLanguages() = runTest {
        val spec = spec(lot)
        val field = LabelField.fromWire("shift.lotNumber")
        val prefix = "АБВГДЕЖЗИКЛМНОПРСТУФХЦЧ"
        for ((language, bitmapCommand) in listOf(PrinterLanguage.ZPL to "^GFA", PrinterLanguage.TSPL to "BITMAP")) {
            val first = renderer.render(spec, mapOf(field to "${prefix}А"), language, 203).toString(Charsets.ISO_8859_1)
            val second = renderer.render(spec, mapOf(field to "${prefix}Б"), language, 203).toString(Charsets.ISO_8859_1)
            assertTrue(first.contains(bitmapCommand))
            assertNotEquals("The last glyph must not be clipped", first, second)
        }
    }

    @Test
    fun lotValueThatCannotFitIsRefusedInBothPrinterLanguages() = runTest {
        val spec = spec(lot.replace("\"maxWidthMm\":30", "\"maxWidthMm\":4"))
        val field = LabelField.fromWire("shift.lotNumber")
        for (language in PrinterLanguage.entries) {
            try {
                renderer.render(spec, mapOf(field to "BATCH123456789"), language, 203)
                fail("An overflowing lot value must not become a truncated label")
            } catch (expected: LabelRenderException) {
                assertTrue(expected.message.orEmpty().contains("lot number"))
            }
        }
    }

    private fun spec(elements: String) = LabelSpecCodec.parse(
        """{"widthMm":58,"heightMm":40,"dpi":203,"language":"zpl","elements":[$elements]}""",
    )

    private val lot =
        """
        {"id":"lot-value","kind":"field","field":"shift.lotNumber","xMm":4,"yMm":5,
         "fontSizePt":12,"minFontSizePt":9,"maxWidthMm":30,"maxLines":2}
        """.trimIndent()
}
