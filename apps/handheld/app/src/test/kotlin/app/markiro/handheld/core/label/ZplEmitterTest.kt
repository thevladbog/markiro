package app.markiro.handheld.core.label

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ZplEmitterTest {
    private val data = mapOf(
        LabelField.PRODUCT_GTIN to "04600682000013",
        LabelField.SSCC to "346006820000000014",
        LabelField.PRODUCT_NAME to "Вода",
    )

    private fun spec(vararg elements: LabelElement) =
        LabelSpec(58.0, 40.0, 203, PrinterLanguage.ZPL, elements.toList())

    private val stub = RasterizeText { _, options ->
        val width = options.maxWidthPx ?: 16
        RasterResult(hex = "AAAA", totalBytes = 2, bytesPerRow = 2, width = width, height = 8)
    }

    @Test
    fun theDocumentIsFramedAndEndsWithANewline() = runTest {
        assertEquals("^XA\n^PW464\n^LL320\n^XZ\n", generateZpl(spec(), data, null))
    }

    @Test
    fun nativeTextUsesTheScalableFontAtBothAxes() = runTest {
        val document = generateZpl(spec(LabelElement.Text("t1", 2.0, 2.0, "ACME", 12.0)), data, null)
        assertTrue(document.contains("^FO16,16^A0N,34,34^FDACME^FS"))
        assertFalse(document.contains("^FH"))
        assertFalse(document.contains("^FB"))
    }

    @Test
    fun aBoxedTextEmitsAFieldBlockWithItsJustification() = runTest {
        val document = generateZpl(
            spec(LabelElement.Text("t1", 2.0, 2.0, "ACME", 12.0, maxWidthMm = 40.0, maxLines = 2, align = LabelAlign.CENTER)),
            data,
            null,
        )
        assertTrue(document.contains("^FO16,16^A0N,34,34^FB320,2,0,C,0^FDACME^FS"))
    }

    @Test
    fun onlyTheThreeControlCharactersAreEscaped() = runTest {
        val document = generateZpl(spec(LabelElement.Text("t1", 2.0, 2.0, "A^B~C_D", 10.0)), data, null)
        assertTrue(document.contains("^FH_^FDA_5EB_7EC_5FD^FS"))
    }

    @Test
    fun anSsccBarcodeCarriesTheApplicationIdentifierAndItsModuleWidth() = runTest {
        val document = generateZpl(
            spec(LabelElement.Barcode("b1", 4.0, 12.0, BarcodeFormat.CODE128, BarcodeSource.Field(LabelField.SSCC), 15.0, 0.25)),
            data,
            null,
        )
        assertTrue(document.contains("^FO32,96^BY2^BCN,120,N,N,N^FD>;>800346006820000000014^FS"))
    }

    @Test
    fun aLiteralBarcodeGetsNoApplicationIdentifierAndNoBarWidth() = runTest {
        val document = generateZpl(
            spec(LabelElement.Barcode("b1", 4.0, 12.0, BarcodeFormat.CODE128, BarcodeSource.Literal("ABC"), 10.0)),
            data,
            null,
        )
        assertTrue(document.contains("^FO32,96^BCN,80,N,N,N^FDABC^FS"))
        assertFalse(document.contains("^BY"))
    }

    @Test
    fun aReversedLineIsAnchoredAtItsLeftmostEnd() = runTest {
        val document = generateZpl(spec(LabelElement.Line("l1", 40.0, 30.0, 10.0, 30.0, 0.5)), data, null)
        assertTrue(document.contains("^FO80,240^GB240,4,4^FS"))
    }

    @Test
    fun cyrillicGoesThroughTheImageBranch() = runTest {
        val document = generateZpl(
            spec(LabelElement.Field("f1", 5.0, 5.0, LabelField.PRODUCT_NAME, fontSizePt = 12.0, maxWidthMm = 20.0, align = LabelAlign.RIGHT)),
            data,
            stub,
        )
        // The box is 160 dots and the stub returns a bitmap of that width, so the offset is zero.
        assertTrue(document.contains("^FO40,40^GFA,2,2,2,AAAA^FS"))
    }

    @Test
    fun cyrillicWithoutARasterizerIsRefusedByName() = runTest {
        val failure = runCatching {
            generateZpl(spec(LabelElement.Field("f1", 2.0, 2.0, LabelField.PRODUCT_NAME, fontSizePt = 10.0)), data, null)
        }.exceptionOrNull()
        assertTrue(failure is LabelRenderException)
        assertTrue(failure!!.message!!.contains("Вода"))
    }

    @Test
    fun matrixAndEanFormatsAreRefusedByName() = runTest {
        for (format in listOf(BarcodeFormat.DATAMATRIX, BarcodeFormat.QR, BarcodeFormat.EAN13)) {
            val failure = runCatching {
                generateZpl(spec(LabelElement.Barcode("b1", 2.0, 2.0, format, BarcodeSource.Literal("X"), 10.0)), data, null)
            }.exceptionOrNull()
            assertTrue(format.wire, failure is LabelRenderException)
            assertTrue(format.wire, failure!!.message!!.contains(format.wire))
        }
    }
}
