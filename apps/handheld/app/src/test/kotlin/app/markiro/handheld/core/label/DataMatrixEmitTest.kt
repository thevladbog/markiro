package app.markiro.handheld.core.label

import app.markiro.handheld.core.barcode.rasterizeGs1DataMatrix
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

private const val RAW = "0104600682000013215Y7HG9\u001d93Zf8K"
private const val DPI = 203

private fun spec(format: BarcodeFormat, source: BarcodeSource) = LabelSpec(
    widthMm = 58.0,
    heightMm = 40.0,
    dpi = DPI,
    language = PrinterLanguage.ZPL,
    elements = listOf(
        LabelElement.Barcode(
            id = "code",
            xMm = 4.0,
            yMm = 5.0,
            format = format,
            data = source,
            sizeMm = 20.0,
        ),
    ),
)

class DataMatrixEmitTest {
    private val duplicate = spec(BarcodeFormat.DATAMATRIX, BarcodeSource.Field(LabelField.KM_CODE))
    private val data = mapOf(LabelField.KM_CODE to RAW)

    @Test
    fun zplFramesTheSymbolAsAGraphicAtTheElementOrigin() = runBlocking {
        val raster = rasterizeGs1DataMatrix(RAW, mmToDots(20.0, DPI))
        val expected = "^FO${mmToDots(4.0, DPI)},${mmToDots(5.0, DPI)}" +
            "^GFA,${raster.totalBytes},${raster.totalBytes},${raster.bytesPerRow},${raster.hex}^FS"
        assertTrue(generateZpl(duplicate, data, null).contains(expected))
    }

    @Test
    fun tsplFramesTheSymbolAsABitmapAtTheElementOrigin() = runBlocking {
        val raster = rasterizeGs1DataMatrix(RAW, mmToDots(20.0, DPI))
        val document = String(generateTspl(duplicate, data, null), Charsets.ISO_8859_1)
        val header = "BITMAP ${mmToDots(4.0, DPI)},${mmToDots(5.0, DPI)},${raster.bytesPerRow},${raster.height},0,"
        assertTrue(document.contains(header))
        val payload = document.substringAfter(header).take(raster.totalBytes)
        assertEquals(String(tsplBitmapBytes(raster.hex), Charsets.ISO_8859_1), payload)
    }

    /**
     * An empty marking code is a template or data bug. Printing it blank would
     * put a scannable symbol carrying nothing but the GS1 flag on a product.
     */
    @Test
    fun anEmptyMarkingCodeIsARenderFailure() {
        assertThrows(LabelRenderException::class.java) {
            runBlocking { generateZpl(duplicate, emptyMap(), null) }
        }
        assertThrows(LabelRenderException::class.java) {
            runBlocking { generateTspl(duplicate, emptyMap(), null) }
        }
    }

    /** Only `km.code` gets the GS1 treatment; a literal Data Matrix stays unsupported. */
    @Test
    fun aDataMatrixBoundToALiteralIsStillRefused() {
        val literal = spec(BarcodeFormat.DATAMATRIX, BarcodeSource.Literal("hello"))
        assertThrows(LabelRenderException::class.java) {
            runBlocking { generateZpl(literal, data, null) }
        }
        assertThrows(LabelRenderException::class.java) {
            runBlocking { generateTspl(literal, data, null) }
        }
    }

    @Test
    fun otherBarcodeFormatsAreStillRefused() {
        val qr = spec(BarcodeFormat.QR, BarcodeSource.Field(LabelField.KM_CODE))
        assertThrows(LabelRenderException::class.java) {
            runBlocking { generateZpl(qr, data, null) }
        }
        assertThrows(LabelRenderException::class.java) {
            runBlocking { generateTspl(qr, data, null) }
        }
    }
}
