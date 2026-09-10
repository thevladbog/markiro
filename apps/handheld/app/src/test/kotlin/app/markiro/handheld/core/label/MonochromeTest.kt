package app.markiro.handheld.core.label

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.ByteArrayOutputStream

class MonochromeTest {
    private fun argb(vararg pixels: Int) = IntArray(pixels.size) { pixels[it] }

    private val black = 0xFF000000.toInt()
    private val white = 0xFFFFFFFF.toInt()

    @Test
    fun luminanceIsThresholdedWithNoDithering() {
        // Exactly 127 grey is black: the comparison is strictly greater than 127.
        val grey127 = 0xFF7F7F7F.toInt()
        val grey128 = 0xFF808080.toInt()
        assertArrayEquals(byteArrayOf(1, 0, 1, 0), convertToMonochrome(argb(black, white, grey127, grey128), 4, 1))
    }

    @Test
    fun channelsAreReadUnsigned() {
        // A blue channel of 0xFF must not read as negative; pure blue is dark and stays black.
        assertArrayEquals(byteArrayOf(1), convertToMonochrome(argb(0xFF0000FF.toInt()), 1, 1))
        // Pure green is bright enough to be white under the BT.601 weights.
        assertArrayEquals(byteArrayOf(0), convertToMonochrome(argb(0xFF00FF00.toInt()), 1, 1))
    }

    @Test
    fun bitsPackMostSignificantFirstAndRowsPadToWholeBytes() {
        // Nine pixels: the first is black, the rest white. Row is two bytes, second byte all padding.
        val bitmap = ByteArray(9).also { it[0] = 1 }
        val packed = bitmapToZplHex(bitmap, 9, 1)
        assertEquals("8000", packed.hex)
        assertEquals(2, packed.bytesPerRow)
        assertEquals(2, packed.totalBytes)
    }

    @Test
    fun theZplCommandCarriesTheByteCountsAndRowStride() {
        val r = RasterResult(hex = "AAAA5555", totalBytes = 4, bytesPerRow = 2, width = 16, height = 2)
        assertEquals("^GFA,4,4,2,AAAA5555", buildGfaCommand(r))
    }

    @Test
    fun tsplInvertsEveryBitIncludingPadding() {
        assertArrayEquals(
            byteArrayOf(0x55, 0x55, 0xAA.toByte(), 0xAA.toByte()),
            tsplBitmapBytes("AAAA5555"),
        )
    }

    @Test
    fun theTsplCommandWritesParametersThenRawBytes() {
        val r = RasterResult(hex = "AAAA5555", totalBytes = 4, bytesPerRow = 2, width = 16, height = 2)
        val out = ByteArrayOutputStream()
        buildBitmapCommand(40, 40, r, out)
        val bytes = out.toByteArray()
        assertEquals("BITMAP 40,40,2,2,0,", String(bytes, 0, 19, Charsets.US_ASCII))
        assertArrayEquals(byteArrayOf(0x55, 0x55, 0xAA.toByte(), 0xAA.toByte()), bytes.copyOfRange(19, bytes.size))
    }
}
