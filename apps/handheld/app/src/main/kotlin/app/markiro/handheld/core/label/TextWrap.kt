package app.markiro.handheld.core.label

import kotlin.math.ceil
import kotlin.math.max

/** U+2026, one code point. */
const val WRAP_ELLIPSIS = "…"
const val AVG_CHAR_WIDTH_EM = 0.55
const val LINE_HEIGHT_EM = 1.5

/**
 * JavaScript's `\s` covers more than Java's default: no-break space, the Unicode space separators,
 * the line and paragraph separators and the byte-order mark. Spelling the class out keeps a product
 * name containing a no-break space wrapping the same way on both sides.
 */
private val WHITESPACE =
    Regex("[ \\t\\n\\u000B\\u000C\\r\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+")

/** `max(len, 1) * ptToMm(pt) * 0.55`. The floor of one is deliberate: an empty string is not zero wide. */
fun estimatedTextWidthMm(text: String, fontSizePt: Double): Double =
    max(text.length, 1) * ptToMm(fontSizePt) * AVG_CHAR_WIDTH_EM

/**
 * The longest prefix that still fits once the ellipsis is appended. Returns an empty string, with no
 * marker at all, when even the bare ellipsis does not fit.
 */
fun clipWithEllipsis(text: String, measure: (String) -> Double, maxWidth: Double): String {
    if (measure(WRAP_ELLIPSIS) > maxWidth) return ""
    var lo = 0
    var hi = text.length
    while (lo < hi) {
        // The upper mid is load-bearing: a floor mid makes this loop spin forever.
        val mid = ceil((lo + hi) / 2.0).toInt()
        if (measure(text.substring(0, mid) + WRAP_ELLIPSIS) <= maxWidth) lo = mid else hi = mid - 1
    }
    return text.substring(0, lo) + WRAP_ELLIPSIS
}

/** Greedy character accumulation for a word wider than the box. Iterates by code point. */
private fun breakLongWord(word: String, measure: (String) -> Double, maxWidth: Double): List<String> {
    val chunks = ArrayList<String>()
    var current = StringBuilder()
    var index = 0
    while (index < word.length) {
        val count = Character.charCount(word.codePointAt(index))
        val ch = word.substring(index, index + count)
        if (current.isNotEmpty() && measure(current.toString() + ch) > maxWidth) {
            chunks += current.toString()
            current = StringBuilder(ch)
        } else {
            current.append(ch)
        }
        index += count
    }
    if (current.isNotEmpty()) chunks += current.toString()
    return chunks.ifEmpty { listOf(word) }
}

/**
 * Port of `wrapTextToWidth` in packages/domain/src/labels/wrap.ts. `maxLines` defaults to one, and
 * one line means one line clipped, not no wrapping. The ellipsis appears only when a line was
 * actually dropped.
 */
fun wrapTextToWidth(
    text: String,
    measure: (String) -> Double,
    maxWidth: Double,
    maxLines: Int = 1,
): List<String> {
    if (!maxWidth.isFinite() || maxWidth <= 0.0) return listOf(text)
    val limit = max(1, maxLines)
    val words = text.split(WHITESPACE).filter { it.isNotEmpty() }
    if (words.isEmpty()) return listOf(text)

    val lines = ArrayList<String>()
    var current = ""
    for (word in words) {
        val candidate = if (current.isEmpty()) word else "$current $word"
        if (measure(candidate) <= maxWidth) {
            current = candidate
            continue
        }
        if (current.isNotEmpty()) lines += current
        if (measure(word) <= maxWidth) {
            current = word
            continue
        }
        val chunks = breakLongWord(word, measure, maxWidth)
        lines += chunks.dropLast(1)
        current = chunks.lastOrNull() ?: ""
    }
    if (current.isNotEmpty()) lines += current
    if (lines.isEmpty()) return listOf("")
    if (lines.size <= limit) return lines
    val kept = ArrayList(lines.subList(0, limit))
    kept[limit - 1] = clipWithEllipsis(kept[limit - 1], measure, maxWidth)
    return kept
}

/**
 * What `align` means in dots, for both emitters' image branches and the TSPL native branch. With no
 * box there is nothing to align against and the offset is zero whatever the alignment says, which
 * mirrors ZPL emitting no field block. Both branches clamp at zero so content wider than its box
 * stays anchored rather than running off the left edge.
 */
fun rasterAlignOffsetDots(align: LabelAlign?, maxWidthDots: Int?, contentWidthDots: Int): Int {
    if (maxWidthDots == null) return 0
    val leftover = maxWidthDots - contentWidthDots
    return when (align) {
        LabelAlign.CENTER -> max(0, roundLikeJs(leftover / 2.0))
        LabelAlign.RIGHT -> max(0, leftover)
        else -> 0
    }
}
