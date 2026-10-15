package app.markiro.handheld.core.km

import app.markiro.handheld.core.box.Sscc

/** What the domain's `classifyScan` read a scan as (`ScanFact.rawKind`): an SSCC, a GTIN, a code of marking, or nothing it knows. */
object ScanRawKind {
    fun classify(raw: String): String {
        val trimmed = raw.trim()
        if (Sscc.parse(trimmed) != null) return "sscc"
        if (runCatching { KmCodec.normalizeGtin14(trimmed) }.isSuccess) return "gtin"
        return if (runCatching { KmCodec.canonicalize(raw) }.isSuccess) "km" else "unknown"
    }
}
