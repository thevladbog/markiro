package app.markiro.handheld.core.label

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TsplEmitterTest {
    private val data = mapOf(
        LabelField.PRODUCT_GTIN to "04600682000013",
        LabelField.SSCC to "346006820000000014",
        LabelField.PRODUCT_NAME to "Вода",
    )

    private fun spec(vararg elements: LabelElement) =
        LabelSpec(58.0, 40.0, 203, PrinterLanguage.TSPL, elements.toList())

    private suspend fun text(spec: LabelSpec, rasterize: RasterizeText? = null) =
        String(generateTspl(spec, data, rasterize), Charsets.ISO_8859_1)

    private val stub = RasterizeText { _, _ ->
        RasterResult(hex = "AAAA5555", totalBytes = 4, bytesPerRow = 2, width = 16, height = 2)
    }

    @Test
    fun theDocumentIsFramedWithMillimetresAndEndsWithANewline() = runTest {
        assertEquals("SIZE 58 mm, 40 mm\nGAP 2 mm, 0 mm\nDIRECTION 1\nCLS\nPRINT 1\n", text(spec()))
    }

    @Test
    fun aFractionalPageSizeKeepsItsDecimalAndAWholeOneDoesNot() = runTest {
        val document = String(
            generateTspl(LabelSpec(57.5, 40.0, 203, PrinterLanguage.TSPL, emptyList()), data, null),
            Charsets.ISO_8859_1,
        )
        assertTrue(document.startsWith("SIZE 57.5 mm, 40 mm\n"))
    }

    @Test
    fun theFontSizeIsPassedThroughUnconverted() = runTest {
        val document = text(spec(LabelElement.Text("t1", 2.0, 2.0, "ACME", 12.0)))
        assertTrue(document.contains("TEXT 16,16,\"0\",0,12,12,\"ACME\""))
    }

    @Test
    fun quotesAreDoubled() = runTest {
        val document = text(spec(LabelElement.Text("t1", 2.0, 2.0, "Say \"hi\"", 10.0)))
        assertTrue(document.contains("\"Say \"\"hi\"\"\""))
    }

    @Test
    fun aBoxedTextWrapsAndAlignsEachLineItself() = runTest {
        val document = text(
            spec(LabelElement.Text("t1", 2.0, 2.0, "Hi", 12.0, maxWidthMm = 40.0, align = LabelAlign.CENTER)),
        )
        // The box is 320 dots, the estimate for two glyphs at twelve points is 37 dots, so the
        // offset is round((320 - 37) / 2) = 142 and x becomes 16 + 142.
        assertTrue(document.contains("TEXT 158,16,\"0\",0,12,12,\"Hi\""))
    }

    @Test
    fun anSsccBarcodeCarriesTheApplicationIdentifierAndBothBarWidths() = runTest {
        val document = text(
            spec(LabelElement.Barcode("b1", 4.0, 12.0, BarcodeFormat.CODE128, BarcodeSource.Field(LabelField.SSCC), 15.0, 0.25)),
        )
        assertTrue(document.contains("BARCODE 32,96,\"128\",120,0,0,2,2,\"!100346006820000000014\""))
    }

    @Test
    fun aBarcodeWithoutAModuleWidthKeepsTheHistoricalTwoDotBar() = runTest {
        val document = text(
            spec(LabelElement.Barcode("b1", 4.0, 12.0, BarcodeFormat.CODE128, BarcodeSource.Literal("ABC"), 10.0)),
        )
        assertTrue(document.contains("BARCODE 32,96,\"128\",80,0,0,2,2,\"ABC\""))
    }

    @Test
    fun aBoxIsGivenAsOppositeCorners() = runTest {
        val document = text(spec(LabelElement.Box("x1", 1.0, 1.0, 10.0, 5.0, 0.25)))
        assertTrue(document.contains("BOX 8,8,88,48,2"))
    }

    @Test
    fun theImagePayloadIsRawInvertedBytes() = runTest {
        val bytes = generateTspl(
            spec(LabelElement.Field("f1", 5.0, 5.0, LabelField.PRODUCT_NAME, fontSizePt = 12.0)),
            data,
            stub,
        )
        val marker = "BITMAP 40,40,2,2,0,".toByteArray(Charsets.US_ASCII)
        val start = bytes.indexOfSlice(marker)
        assertTrue(start >= 0)
        val payloadAt = start + marker.size
        assertArrayEquals(
            byteArrayOf(0x55, 0x55, 0xAA.toByte(), 0xAA.toByte()),
            bytes.copyOfRange(payloadAt, payloadAt + 4),
        )
    }

    @Test
    fun matrixAndEanFormatsAreRefusedByName() = runTest {
        for (format in listOf(BarcodeFormat.DATAMATRIX, BarcodeFormat.QR, BarcodeFormat.EAN13)) {
            val failure = runCatching {
                generateTspl(
                    spec(LabelElement.Barcode("b1", 2.0, 2.0, format, BarcodeSource.Literal("X"), 10.0)),
                    data,
                    null,
                )
            }.exceptionOrNull()
            assertTrue(format.wire, failure is LabelRenderException)
        }
    }
}

private fun ByteArray.indexOfSlice(slice: ByteArray): Int {
    outer@ for (start in 0..size - slice.size) {
        for (i in slice.indices) if (this[start + i] != slice[i]) continue@outer
        return start
    }
    return -1
}
