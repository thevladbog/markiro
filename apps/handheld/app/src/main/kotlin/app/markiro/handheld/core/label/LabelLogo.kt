package app.markiro.handheld.core.label

import kotlin.math.floor
import kotlin.math.roundToInt

data class PositionedLogo(val x: Int, val y: Int, val raster: RasterResult)
fun fitLabelLogo(element: LabelElement.OrganizationLogo, dpi: Int, logo: RasterResult?): PositionedLogo {
    if (logo == null) throw LabelRenderException("Organization or fallback Markiro logo is required")
    if (logo.width !in 1..1120 || logo.height !in 1..512 || logo.bytesPerRow != (logo.width + 7) / 8 || logo.hex.length != logo.bytesPerRow * logo.height * 2 || !logo.hex.matches(Regex("[a-fA-F0-9]+"))) throw LabelRenderException("Invalid logo raster")
    val maxW = mmToDots(element.widthMm, dpi)
    val maxH = mmToDots(element.heightMm, dpi)
    if (maxW !in 1..3508 || maxH !in 1..3508) throw LabelRenderException("Invalid logo bounds")
    val scale = minOf(maxW.toDouble() / logo.width, maxH.toDouble() / logo.height)
    val width = maxOf(1, (logo.width * scale).roundToInt())
    val height = maxOf(1, (logo.height * scale).roundToInt())
    val mono = ByteArray(width * height)
    for (y in 0 until height) for (x in 0 until width) {
        val sx = floor(x.toDouble() * logo.width / width).toInt()
        val sy = floor(y.toDouble() * logo.height / height).toInt()
        val i = (sy * logo.bytesPerRow + (sx shr 3)) * 2
        if ((logo.hex.substring(i, i + 2).toInt(16) and (0x80 shr (sx % 8))) != 0) mono[y * width + x] = 1
    }
    val packed = bitmapToZplHex(mono, width, height)
    return PositionedLogo(mmToDots(element.xMm, dpi), mmToDots(element.yMm, dpi) + (maxH - height) / 2, RasterResult(packed.hex, packed.totalBytes, packed.bytesPerRow, width, height))
}
