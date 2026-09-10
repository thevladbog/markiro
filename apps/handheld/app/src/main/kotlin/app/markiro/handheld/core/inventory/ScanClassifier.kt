package app.markiro.handheld.core.inventory

import app.markiro.handheld.core.km.KmCodec
import app.markiro.handheld.core.km.ParsedKm

sealed interface ScanInput {
    data class Km(val km: ParsedKm) : ScanInput
    data class Gtin(val gtin14: String) : ScanInput
    data class Sscc(val sscc: String) : ScanInput
    data class Unknown(val raw: String) : ScanInput
}

/** Port of packages/domain/src/scan/classify.ts and gs1/sscc.ts `parseScannedSscc`. */
object ScanClassifier {
    private val GTIN_LENGTHS = setOf(8, 12, 13, 14)

    /** The bare 18 digits from `]C1`, `(00)` or `00`-prefixed scans; null for anything that is not a valid SSCC. */
    fun parseSscc(raw: String): String? {
        if (raw.length > 25) return null
        var rest = raw
        if (rest.startsWith("]C1")) rest = rest.substring(3)
        if (rest.startsWith("(00)")) {
            rest = rest.substring(4)
        } else if (rest.length == 20 && rest.startsWith("00")) {
            rest = rest.substring(2)
        }
        return rest.takeIf { it.length == 18 && it.all { c -> c in '0'..'9' } && KmCodec.hasValidCheckDigit(it) }
    }

    fun isValidGtin(value: String): Boolean = value.length in GTIN_LENGTHS && runCatching { KmCodec.normalizeGtin14(value) }.isSuccess

    fun classify(raw: String): ScanInput {
        val trimmed = raw.trim()
        parseSscc(trimmed)?.let { return ScanInput.Sscc(it) }
        if (isValidGtin(trimmed)) return ScanInput.Gtin(KmCodec.normalizeGtin14(trimmed))
        return runCatching<ScanInput> { ScanInput.Km(KmCodec.canonicalize(raw)) }.getOrElse { ScanInput.Unknown(raw) }
    }
}
