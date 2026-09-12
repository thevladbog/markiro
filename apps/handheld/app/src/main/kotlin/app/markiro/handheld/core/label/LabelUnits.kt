package app.markiro.handheld.core.label

import app.markiro.handheld.core.km.KmCodec
import kotlin.math.floor

private const val MM_PER_INCH = 25.4
private const val POINTS_PER_INCH = 72.0

/** «шт.» — the unit the domain package appends to a numeric quantity. */
const val QTY_UNIT_SUFFIX = "шт."

/**
 * «кор.» — the unit the domain package appends to a numeric box count, so a
 * pallet label's two counts cannot be read for one another.
 */
const val BOX_QTY_UNIT_SUFFIX = "кор."

/**
 * Rounds the way JavaScript's `Math.round` does, which is what the emitters in
 * packages/domain/src/labels were written against: a tie goes toward positive infinity, so a value
 * of exactly minus one half becomes zero rather than minus one.
 *
 * Neither of Kotlin's obvious choices does this. `kotlin.math.round` takes ties to even, and
 * `roundToInt` takes them away from zero, so both disagree on negative halves. Coordinates may be
 * negative, so the difference is a dot in the wrong place rather than a curiosity.
 */
private fun jsRound(value: Double): Int = floor(value + 0.5).toInt()

/** `round(mm * dpi / 25.4)`, matching `mmToDots` in packages/domain/src/labels/model.ts. */
fun mmToDots(mm: Double, dpi: Int): Int = jsRound(mm * dpi / MM_PER_INCH)

/** `round(pt / 72 * dpi)`, matching `ptToDots` in the same module. */
fun ptToDots(pt: Double, dpi: Int): Int = jsRound(pt / POINTS_PER_INCH * dpi)

/** Exposed for the alignment offset, which rounds the same way. */
internal fun roundLikeJs(value: Double): Int = jsRound(value)

/** `pt / 72 * 25.4`, matching `ptToMm` in packages/domain/src/labels/wrap.ts. */
fun ptToMm(pt: Double): Double = pt / POINTS_PER_INCH * MM_PER_INCH

/**
 * The printer's resolution wins over the template's authoring resolution. Returns the same instance
 * when there is nothing to change, matching the TypeScript identity guarantee.
 */
fun withPrinterDpi(spec: LabelSpec, printerDpi: Int?): LabelSpec =
    if (printerDpi == null || printerDpi == spec.dpi) spec else spec.copy(dpi = printerDpi)

/**
 * True when any code point falls outside printable ASCII, matching `needsImageRendering` in
 * packages/domain/src/labels/text.ts. Deliberately ASCII-only rather than Latin-1: native emission
 * of bytes above 0x7F depends on the printer's active code page, which cannot be verified here.
 *
 * Iterates by code point so an astral character counts once instead of as two surrogate halves.
 */
fun needsImageRendering(text: String): Boolean {
    var index = 0
    while (index < text.length) {
        val code = text.codePointAt(index)
        if (code < 0x20 || code > 0x7e) return true
        index += Character.charCount(code)
    }
    return false
}

private val DIGITS = Regex("^\\d+$")
private val SSCC_18 = Regex("^\\d{18}$")

/**
 * Port of `labelFieldDisplayValue` in packages/domain/src/labels/model.ts. The single display
 * formatting layer both emitters share. Every rule is tolerant: malformed input passes through
 * rather than throwing, because a label must still print.
 */
fun labelFieldDisplayValue(
    field: LabelField,
    data: Map<LabelField, String>,
    textFormat: TextFormat?,
): String {
    val value = data[field] ?: ""
    if (field == LabelField.KM_CODE && textFormat == TextFormat.KM_WITHOUT_CRYPTO) {
        val km = runCatching { KmCodec.canonicalize(value) }.getOrNull() ?: return ""
        return "01${km.gtin14}21${km.serial}"
    }
    if (field == LabelField.SSCC && SSCC_18.matches(value)) return "(00)$value"
    if (field == LabelField.QTY) {
        val digits = value.trim()
        if (DIGITS.matches(digits)) return "$digits $QTY_UNIT_SUFFIX"
    }
    if (field == LabelField.QTY_BOXES) {
        val digits = value.trim()
        if (DIGITS.matches(digits)) return "$digits $BOX_QTY_UNIT_SUFFIX"
    }
    return value
}
