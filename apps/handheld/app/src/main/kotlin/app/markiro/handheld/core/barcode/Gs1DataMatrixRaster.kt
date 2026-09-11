package app.markiro.handheld.core.barcode

import app.markiro.handheld.core.label.LabelRenderException
import app.markiro.handheld.core.label.RasterResult
import app.markiro.handheld.core.label.bitmapToZplHex

/** The largest label this product supports is 300 mm at 300 dpi. */
private const val MAX_SIDE_DOTS = 3543

/**
 * A marking code as a square bitmap, ready for the raster path both emitters
 * already use for text.
 *
 * `sideDots` is the WHOLE symbol square, not a module: a duplicate template
 * reserves the finished square (see `assertDuplicateTemplate` in the domain),
 * unlike an ordinary barcode element whose size is a module width. The scale is
 * chosen against the symbol plus two modules so the quiet zone falls inside the
 * reserved square rather than eating the neighbouring field.
 */
fun rasterizeGs1DataMatrix(canonicalRaw: String, sideDots: Int): RasterResult {
    if (sideDots < 1 || sideDots > MAX_SIDE_DOTS) {
        throw LabelRenderException("Data Matrix extent $sideDots is out of range")
    }
    val grid = encodeGs1DataMatrix(canonicalRaw)
    val scale = sideDots / (maxOf(grid.width, grid.height) + 2)
    if (scale < 1) {
        throw LabelRenderException(
            "Data Matrix needs at least ${grid.width + 2} dots, the template reserves $sideDots",
        )
    }
    val left = (sideDots - grid.width * scale) / 2
    val top = (sideDots - grid.height * scale) / 2
    val bitmap = ByteArray(sideDots * sideDots)
    for (row in 0 until grid.height) {
        for (column in 0 until grid.width) {
            if (!grid[column, row]) continue
            for (dy in 0 until scale) {
                val start = (top + row * scale + dy) * sideDots + left + column * scale
                bitmap.fill(1, start, start + scale)
            }
        }
    }
    val packing = bitmapToZplHex(bitmap, sideDots, sideDots)
    return RasterResult(packing.hex, packing.totalBytes, packing.bytesPerRow, sideDots, sideDots)
}
