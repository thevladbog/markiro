package app.markiro.handheld.core.label

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Draws a text run with the platform's own font engine and hands the pixels to the shared packing
 * code. The only Android-dependent file in `core/label`.
 *
 * This output is not byte-comparable to the station's. The station and the cabinet editor share one
 * browser canvas implementation and are deliberately pixel-identical to each other so that preview
 * equals print; this is a third implementation. The same text lands at the same size in the same
 * place, and the glyph pixels differ. That is expected and is why the fixtures pin framing rather
 * than pixels.
 *
 * The line box and baseline mirror `apps/admin/src/labels/rasterizer.ts`: a box one and a half times
 * the font size, with the glyphs centred in it. A rasterized run therefore sits slightly lower than
 * a native one at the same coordinate. That offset is accepted in the original and is not corrected
 * here, because correcting it would break agreement with the cabinet preview.
 */
/** Where each line goes and how big the bitmap has to be. Separated so it can be tested with a real measure. */
internal data class RasterLayout(val lines: List<String>, val width: Int, val height: Int, val lineHeight: Int)

/**
 * Decides the bitmap's size and its lines. Pure, so a test can drive it with a deterministic
 * measure: an emulator-free test environment reports every string as zero wide, which would make
 * the width limit below look satisfied without ever being exercised.
 *
 * The width limit is a contract, not a hint. A bitmap wider than its box prints off the edge of the
 * label, so a line that still overflows after wrapping is clipped.
 */
internal fun rasterLayout(text: String, options: RasterOptions, measure: (String) -> Double): RasterLayout {
    val maxWidth = options.maxWidthPx
    val lines = if (maxWidth == null) {
        listOf(text)
    } else {
        wrapTextToWidth(text, measure, maxWidth.toDouble(), options.maxLines)
            .map { line -> if (measure(line) > maxWidth) clipWithEllipsis(line, measure, maxWidth.toDouble()) else line }
    }
    val natural = ceil(lines.maxOf { measure(it) }).toInt()
    val width = max(1, if (maxWidth == null) natural else min(natural, maxWidth))
    val lineHeight = ceil(options.fontSizePx * LINE_HEIGHT_EM).toInt()
    return RasterLayout(lines, width, max(1, lineHeight * lines.size), lineHeight)
}

@Singleton
class AndroidTextRasterizer @Inject constructor() : RasterizeText {
    override suspend fun rasterize(text: String, options: RasterOptions): RasterResult =
        withContext(Dispatchers.Default) {
            val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                textSize = options.fontSizePx.toFloat()
                typeface = Typeface.create(Typeface.SANS_SERIF, if (options.bold) Typeface.BOLD else Typeface.NORMAL)
                color = Color.BLACK
            }
            val layout = rasterLayout(text, options) { paint.measureText(it).toDouble() }
            val lines = layout.lines
            val width = layout.width
            val height = layout.height
            val lineHeight = layout.lineHeight

            val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bitmap)
            // An opaque background matters: the monochrome step ignores alpha, so a transparent
            // pixel would be read as whatever colour sits underneath it.
            canvas.drawColor(Color.WHITE)
            val metrics = paint.fontMetrics
            lines.forEachIndexed { index, line ->
                val centre = index * lineHeight + lineHeight / 2f
                canvas.drawText(line, 0f, centre - (metrics.ascent + metrics.descent) / 2f, paint)
            }
            val pixels = IntArray(width * height)
            bitmap.getPixels(pixels, 0, width, 0, 0, width, height)
            bitmap.recycle()

            val packing = bitmapToZplHex(convertToMonochrome(pixels, width, height), width, height)
            RasterResult(packing.hex, packing.totalBytes, packing.bytesPerRow, width, height)
        }
}
