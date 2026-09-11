package app.markiro.handheld.core.barcode

import app.markiro.handheld.core.label.LabelRenderException
import app.markiro.handheld.core.label.RasterResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

private const val RAW = "0104600682000013215Y7HG9\u001d93Zf8K"

/** Reads one pixel back out of the packing: rows pad to whole bytes, most significant bit leftmost. */
private fun RasterResult.pixel(x: Int, y: Int): Boolean {
    val byteIndex = y * bytesPerRow + x / 8
    val byte = hex.substring(byteIndex * 2, byteIndex * 2 + 2).toInt(16)
    return (byte shr (7 - x % 8)) and 1 == 1
}

class Gs1DataMatrixRasterTest {
    @Test
    fun theRasterIsTheRequestedSquare() {
        val raster = rasterizeGs1DataMatrix(RAW, 120)
        assertEquals(120, raster.width)
        assertEquals(120, raster.height)
        assertEquals(15, raster.bytesPerRow)
        assertEquals(15 * 120, raster.totalBytes)
        assertEquals(raster.totalBytes * 2, raster.hex.length)
    }

    /**
     * Every module lands where the same formula says it should, at full scale.
     * The symbol itself is already proved to decode; this proves the scaling
     * carries it faithfully rather than shearing or transposing it.
     */
    @Test
    fun everyModuleIsScaledIntoPlace() {
        val sideDots = 120
        val raster = rasterizeGs1DataMatrix(RAW, sideDots)
        val grid = encodeGs1DataMatrix(RAW)
        val scale = sideDots / (maxOf(grid.width, grid.height) + 2)
        val left = (sideDots - grid.width * scale) / 2
        val top = (sideDots - grid.height * scale) / 2
        assertTrue(scale >= 1)
        for (row in 0 until grid.height) {
            for (column in 0 until grid.width) {
                val expected = grid[column, row]
                for (dy in 0 until scale) {
                    for (dx in 0 until scale) {
                        assertEquals(
                            "module $column,$row offset $dx,$dy",
                            expected,
                            raster.pixel(left + column * scale + dx, top + row * scale + dy),
                        )
                    }
                }
            }
        }
    }

    /** The quiet zone is inside the square: a symbol touching the edge does not scan. */
    @Test
    fun theSquareKeepsABlankBorder() {
        val sideDots = 120
        val raster = rasterizeGs1DataMatrix(RAW, sideDots)
        for (i in 0 until sideDots) {
            assertFalse("top row $i", raster.pixel(i, 0))
            assertFalse("bottom row $i", raster.pixel(i, sideDots - 1))
            assertFalse("left column $i", raster.pixel(0, i))
            assertFalse("right column $i", raster.pixel(sideDots - 1, i))
        }
    }

    @Test
    fun aSquareTooSmallForOneDotPerModuleIsRefused() {
        assertThrows(LabelRenderException::class.java) { rasterizeGs1DataMatrix(RAW, 8) }
    }

    @Test
    fun anAbsurdSquareIsRefusedBeforeAnythingIsAllocated() {
        assertThrows(LabelRenderException::class.java) { rasterizeGs1DataMatrix(RAW, 0) }
        assertThrows(LabelRenderException::class.java) { rasterizeGs1DataMatrix(RAW, 4000) }
    }
}
