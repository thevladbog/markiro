package app.markiro.handheld.core.label

import kotlin.math.ceil

internal data class PositionedLotNumber(val x: Int, val y: Int, val raster: RasterResult)

/** Match the shared lot label layout. Try complete wraps before shrinking, never shorten the value. */
internal suspend fun rasterizeLotNumber(
    spec: LabelSpec,
    element: LabelElement.Field,
    text: String,
    rasterize: RasterizeText?,
): PositionedLotNumber {
    if (rasterize == null) throw LabelRenderException("Lot number printing needs a text rasterizer")
    val dpi = spec.dpi
    val x = mmToDots(element.xMm, dpi)
    val y = mmToDots(element.yMm, dpi)
    val availableWidth = mmToDots(spec.widthMm, dpi) - x
    val maxWidth = minOf(availableWidth, element.maxWidthMm?.let { mmToDots(it, dpi) } ?: availableWidth)
    val size = ptToDots(element.fontSizePt, dpi)
    val minSize = ptToDots(element.minFontSizePt ?: element.fontSizePt, dpi)
    val maxLines = element.maxLines ?: 2
    val lineHeight = element.lineHeight ?: 1.25
    val maxHeight = minOf(mmToDots(spec.heightMm, dpi) - y, ceil(size * lineHeight).toInt() * maxLines)
    if (x >= 0 && y >= 0 && maxWidth > 0 && maxHeight > 0) {
        val options = RasterOptions(
            fontFamily = element.fontFamily ?: "monospace",
            fontSizePx = size,
            bold = element.bold ?: false,
            maxWidthPx = maxWidth,
            maxLines = maxLines,
            lineHeight = lineHeight,
            requireComplete = true,
        )
        for (fontSize in size downTo minSize) {
            val raster = try {
                rasterize.rasterize(text, options.copy(fontSizePx = fontSize))
            } catch (_: CompleteTextOverflow) {
                continue
            }
            if (raster.width <= maxWidth && raster.height <= maxHeight) {
                val offset = rasterAlignOffsetDots(element.align, maxWidth, raster.width)
                return PositionedLotNumber(x + offset, y, raster)
            }
        }
    }
    throw LabelRenderException("${element.id}: the complete lot number does not fit in its printable area")
}
