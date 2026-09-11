package app.markiro.handheld.core.barcode

import app.markiro.handheld.core.label.LabelRenderException
import com.google.zxing.common.BitMatrix
import com.google.zxing.datamatrix.decoder.Decoder
import com.google.zxing.datamatrix.encoder.SymbolInfo
import com.google.zxing.datamatrix.encoder.SymbolShapeHint
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

private const val GS = "\u001d"

private fun ModuleGrid.toBitMatrix(): BitMatrix {
    val matrix = BitMatrix(width, height)
    for (y in 0 until height) {
        for (x in 0 until width) {
            if (this[x, y]) matrix.set(x, y)
        }
    }
    return matrix
}

/**
 * What a scanner reads back. ZXing renders every FNC1 codeword as ASCII 29,
 * including the leading one, so a correct GS1 symbol decodes to a separator
 * followed by the code with its own separators intact. Anything less means the
 * symbol is a plain Data Matrix that a Chestny ZNAK scanner would misread.
 */
private fun decode(grid: ModuleGrid): String = Decoder().decode(grid.toBitMatrix()).text

class DataMatrixTest {
    @Test
    fun zxingExposesTheSymbolTableWeRelyOn() {
        val info = SymbolInfo.lookup(12, SymbolShapeHint.FORCE_SQUARE)
        assertEquals(16, info.symbolWidth)
        assertEquals(16, info.symbolHeight)
        assertEquals(12, info.dataCapacity)
        assertEquals(12, info.errorCodewords)
        // Data-region geometry, used to place the finder and clock patterns.
        assertEquals(14, info.symbolDataWidth)
        assertEquals(14, info.symbolDataHeight)
        assertEquals(14, info.matrixWidth)
        assertEquals(14, info.matrixHeight)
        assertTrue(info.symbolWidth >= info.symbolDataWidth)
    }

    @Test
    fun aShortCodeDecodesBackToItselfBehindTheGs1Flag() {
        val raw = "0104600682000013215Y7HG9"
        assertEquals(GS + raw, decode(encodeGs1DataMatrix(raw)))
    }

    @Test
    fun everySeparatorSurvivesAsASeparator() {
        val raw = "0104600682000013215Y7HG9${GS}93Zf8K"
        assertEquals(GS + raw, decode(encodeGs1DataMatrix(raw)))
    }

    /** A production Chestny ZNAK code: long serial, 91 and 92 present, crypto tail included. */
    @Test
    fun aFullProductionCodeDecodesBackToItself() {
        val raw = "010460068200001321AbC5xY9k2Qw${GS}91EE10${GS}92" +
            "RG5RMTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MA"
        assertEquals(GS + raw, decode(encodeGs1DataMatrix(raw)))
    }

    @Test
    fun theSymbolIsSquareAndLargeEnoughForItsData() {
        val grid = encodeGs1DataMatrix("0104600682000013215Y7HG9")
        assertEquals(grid.width, grid.height)
        assertTrue(grid.width in 10..144)
    }

    @Test
    fun aCodeTooLongForTheLargestSymbolIsRefusedAsARenderFailure() {
        val raw = "010460068200001321" + "A".repeat(2000)
        assertThrows(LabelRenderException::class.java) { encodeGs1DataMatrix(raw) }
    }
}
