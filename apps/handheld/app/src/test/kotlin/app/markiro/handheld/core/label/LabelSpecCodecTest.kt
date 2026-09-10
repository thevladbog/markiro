package app.markiro.handheld.core.label

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * A template arrives as JSON the cabinet stored. What matters here is that a template this device
 * cannot honour is refused by name rather than printed as something else: a geometry field that
 * quietly became zero puts the element in the corner of a real label, and nothing downstream can
 * tell that apart from a template that asked for the corner.
 */
class LabelSpecCodecTest {
    private fun spec(elements: String) =
        """{"widthMm":58,"heightMm":40,"dpi":203,"language":"zpl","elements":[$elements]}"""

    private val text = """{"kind":"text","id":"t","xMm":2,"yMm":3,"text":"OK","fontSizePt":8}"""

    @Test
    fun aWellFormedSpecParses() {
        val parsed = LabelSpecCodec.parse(spec(text))
        assertEquals(58.0, parsed.widthMm, 0.0)
        assertEquals(203, parsed.dpi)
        val element = parsed.elements.single() as LabelElement.Text
        assertEquals(2.0, element.xMm, 0.0)
        assertEquals("OK", element.text)
        assertEquals(null, element.bold)
    }

    @Test
    fun theOneTextFormatInTheModelIsRead() {
        val field = """{"kind":"field","id":"f","xMm":1,"yMm":1,"field":"km.code",""" +
            """"textFormat":"km_without_crypto","fontSizePt":6}"""
        val element = LabelSpecCodec.parse(spec(field)).elements.single() as LabelElement.Field
        assertEquals(TextFormat.KM_WITHOUT_CRYPTO, element.textFormat)
    }

    @Test
    fun aTextFormatOutsideTheModelIsRefusedByName() {
        // Accepting it would print the whole code including the crypto tail, which is the one thing
        // the format exists to strip.
        val field = """{"kind":"field","id":"f","xMm":1,"yMm":1,"field":"km.code",""" +
            """"textFormat":"km_with_crypto","fontSizePt":6}"""
        val thrown = assertThrows(LabelRenderException::class.java) { LabelSpecCodec.parse(spec(field)) }
        assertEquals("unknown text format: km_with_crypto", thrown.message)
    }

    @Test
    fun aMissingGeometryFieldIsRefusedRatherThanBecomingZero() {
        val missing = """{"kind":"text","id":"t","yMm":3,"text":"OK","fontSizePt":8}"""
        val thrown = assertThrows(LabelRenderException::class.java) { LabelSpecCodec.parse(spec(missing)) }
        assertEquals("label spec is missing xMm", thrown.message)
    }

    @Test
    fun aGeometryFieldThatIsNotANumberIsRefused() {
        val wrong = """{"kind":"text","id":"t","xMm":"left","yMm":3,"text":"OK","fontSizePt":8}"""
        val thrown = assertThrows(LabelRenderException::class.java) { LabelSpecCodec.parse(spec(wrong)) }
        assertEquals("label spec xMm is not a number", thrown.message)
    }

    @Test
    fun anExplicitNullWhereAValueIsRequiredIsRefused() {
        val nulled = """{"kind":"text","id":"t","xMm":null,"yMm":3,"text":"OK","fontSizePt":8}"""
        val thrown = assertThrows(LabelRenderException::class.java) { LabelSpecCodec.parse(spec(nulled)) }
        assertEquals("label spec is missing xMm", thrown.message)
    }

    @Test
    fun anOptionalFieldOfTheWrongTypeIsRefusedRatherThanIgnored() {
        val wrong = """{"kind":"text","id":"t","xMm":1,"yMm":3,"text":"OK","fontSizePt":8,"maxLines":"two"}"""
        val thrown = assertThrows(LabelRenderException::class.java) { LabelSpecCodec.parse(spec(wrong)) }
        assertEquals("label spec maxLines is not a whole number", thrown.message)
    }

    @Test
    fun anAbsentOptionalStaysAbsent() {
        val element = LabelSpecCodec.parse(spec(text)).elements.single() as LabelElement.Text
        assertEquals(null, element.maxLines)
        assertEquals(null, element.align)
    }

    @Test
    fun aSpecWithNoElementListIsRefused() {
        val json = """{"widthMm":58,"heightMm":40,"dpi":203,"language":"zpl"}"""
        val thrown = assertThrows(LabelRenderException::class.java) { LabelSpecCodec.parse(json) }
        assertEquals("label spec has no elements", thrown.message)
    }

    @Test
    fun aBarcodeReadsEitherAFieldOrALiteral() {
        val fromField = """{"kind":"barcode","id":"b","xMm":1,"yMm":1,"format":"code128",""" +
            """"data":"sscc","sizeMm":10}"""
        val field = (LabelSpecCodec.parse(spec(fromField)).elements.single() as LabelElement.Barcode).data
        assertEquals(BarcodeSource.Field(LabelField.SSCC), field)

        val fromLiteral = """{"kind":"barcode","id":"b","xMm":1,"yMm":1,"format":"code128",""" +
            """"data":{"literal":"0468"},"sizeMm":10}"""
        val literal = (LabelSpecCodec.parse(spec(fromLiteral)).elements.single() as LabelElement.Barcode).data
        assertEquals(BarcodeSource.Literal("0468"), literal)
    }

    @Test
    fun aBarcodeWithNoDataIsRefused() {
        val noData = """{"kind":"barcode","id":"b","xMm":1,"yMm":1,"format":"code128","sizeMm":10}"""
        val thrown = assertThrows(LabelRenderException::class.java) { LabelSpecCodec.parse(spec(noData)) }
        assertEquals("label spec is missing barcode data", thrown.message)
    }
}
