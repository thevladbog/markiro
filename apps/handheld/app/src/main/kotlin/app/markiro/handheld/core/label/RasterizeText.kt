package app.markiro.handheld.core.label

/**
 * A rasterized text run, in ZPL polarity: a set bit is black. Rows are padded to whole bytes, so
 * `width` is not `bytesPerRow * 8` and cannot be recovered from the packing. Alignment needs the
 * logical width, which is why it is carried here.
 */
data class RasterResult(
    /** Uppercase ASCII hex, no separators, rows concatenated. */
    val hex: String,
    val totalBytes: Int,
    val bytesPerRow: Int,
    val width: Int,
    val height: Int,
)

/**
 * `maxWidthPx` is a contract, not a hint: the returned bitmap must not be wider. An implementation
 * satisfies it by wrapping up to `maxLines` lines and clipping the last. Without that, a long
 * Cyrillic name prints off the right edge of the label.
 */
data class RasterOptions(
    val fontFamily: String,
    val fontSizePx: Int,
    val bold: Boolean,
    val maxWidthPx: Int?,
    val maxLines: Int,
)

fun interface RasterizeText {
    suspend fun rasterize(text: String, options: RasterOptions): RasterResult
}
