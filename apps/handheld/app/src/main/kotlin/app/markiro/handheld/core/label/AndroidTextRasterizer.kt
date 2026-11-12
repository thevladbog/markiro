package app.markiro.handheld.core.label

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
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
 * Uses the same bundled IBM Plex Sans/Mono families and weights as the station.
 * Android and browser font engines may still differ in glyph antialiasing.
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
    val lines = when {
        maxWidth == null -> listOf(text)
        options.requireComplete -> wrapCompleteText(text, measure, maxWidth, options.maxLines)
        else -> wrapTextToWidth(text, measure, maxWidth.toDouble(), options.maxLines)
            .map { line -> if (measure(line) > maxWidth) clipWithEllipsis(line, measure, maxWidth.toDouble()) else line }
    }
    val natural = ceil(lines.maxOf { measure(it) }).toInt()
    val width = max(1, if (maxWidth == null) natural else min(natural, maxWidth))
    val lineHeight = ceil(options.fontSizePx * (options.lineHeight ?: LINE_HEIGHT_EM)).toInt()
    return RasterLayout(lines, width, max(1, lineHeight * lines.size), lineHeight)
}

@Singleton
class AndroidTextRasterizer @Inject constructor(@dagger.hilt.android.qualifiers.ApplicationContext private val context: android.content.Context) : RasterizeText {
    override suspend fun rasterize(text: String, options: RasterOptions): RasterResult =
        withContext(Dispatchers.Default) {
            val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                textSize = options.fontSizePx.toFloat()
                typeface = context.resources.getFont(when {
                    options.fontFamily == "monospace" && options.bold -> app.markiro.handheld.R.font.plex_mono_bold
                    options.fontFamily == "monospace" -> app.markiro.handheld.R.font.plex_mono_regular
                    options.bold -> app.markiro.handheld.R.font.plex_sans_bold
                    else -> app.markiro.handheld.R.font.plex_sans_regular
                })
                color = Color.BLACK
            }
            var fitted = options
            if (options.maxLines <= 1 && options.maxWidthPx != null && options.minFontSizePx != null) {
                while (paint.measureText(text) > options.maxWidthPx && fitted.fontSizePx > options.minFontSizePx) {
                    fitted = fitted.copy(fontSizePx = fitted.fontSizePx - 1)
                    paint.textSize = fitted.fontSizePx.toFloat()
                }
                if (paint.measureText(text) > options.maxWidthPx) throw LabelRenderException("Label quantity exceeds its box at minimum font size")
            }
            val bounds = Rect()
            fun inkBounds(line: String, rect: Rect) = paint.getTextBounds(line, 0, line.length, rect)
            val layout = rasterLayout(text, fitted) { line ->
                val advance = paint.measureText(line).toDouble()
                if (fitted.requireComplete) {
                    inkBounds(line, bounds)
                    max(0, -bounds.left) + max(advance, bounds.right.toDouble())
                } else {
                    advance
                }
            }
            val lines = layout.lines
            val width = layout.width
            val ink = if (fitted.requireComplete) lines.map { line -> Rect().also { inkBounds(line, it) } } else emptyList()
            val ascent = ink.maxOfOrNull { max(0, -it.top) } ?: 0
            val descent = ink.maxOfOrNull { max(0, it.bottom) } ?: 0
            val lineHeight = if (ink.isEmpty()) layout.lineHeight else max(layout.lineHeight, ascent + descent + 2)
            val height = if (ink.isEmpty()) layout.height else max(1, lineHeight * lines.size)

            val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bitmap)
            // An opaque background matters: the monochrome step ignores alpha, so a transparent
            // pixel would be read as whatever colour sits underneath it.
            canvas.drawColor(Color.WHITE)
            val metrics = paint.fontMetrics
            lines.forEachIndexed { index, line ->
                val boundsOnLine = ink.getOrNull(index)
                val left = boundsOnLine?.let { max(0, -it.left).toFloat() } ?: 0f
                val baseline = if (boundsOnLine == null) {
                    val centre = index * lineHeight + lineHeight / 2f
                    centre - (metrics.ascent + metrics.descent) / 2f
                } else {
                    (index * lineHeight + (lineHeight - ascent - descent) / 2 + ascent).toFloat()
                }
                canvas.drawText(line, left, baseline, paint)
            }
            val pixels = IntArray(width * height)
            bitmap.getPixels(pixels, 0, width, 0, 0, width, height)
            bitmap.recycle()

            val packing = bitmapToZplHex(convertToMonochrome(pixels, width, height), width, height)
            RasterResult(packing.hex, packing.totalBytes, packing.bytesPerRow, width, height)
        }
}
