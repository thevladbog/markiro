package app.markiro.handheld.core.scan

/**
 * Turns one vendor broadcast into a scan.
 *
 * Keys are tried in order, and not one of them is guaranteed to hold a String.
 * Urovo's `barcode` is a byte array padded to the decoder's buffer, with the
 * real length in a separate extra, and its `barcodeType` is a single byte.
 * Reading only Strings dropped those scans without a trace -- the worst failure
 * this app can produce, because the scanner still beeps and the screen simply
 * does nothing.
 */
class IntentExtractor(private val profile: VendorProfile) {
    fun extract(extras: Map<String, Any?>, nowMs: Long): ScanEvent? {
        val data = profile.dataExtras.firstNotNullOfOrNull { key -> text(extras[key], extras[LENGTH]) } ?: return null
        val normalized = ScanNormalizer.normalize(data)
        if (normalized.isEmpty()) return null
        val symbology = profile.symbologyExtras.firstNotNullOfOrNull { key -> label(extras[key]) }
        return ScanEvent(normalized, symbology, "intent:${profile.id}", nowMs)
    }

    private fun text(value: Any?, length: Any?): String? = when (value) {
        is String -> value.ifEmpty { null }
        is ByteArray -> bytes(value, length)
        is CharSequence -> value.toString().ifEmpty { null }
        else -> null
    }

    /**
     * `length` names the decoded bytes; the rest of the buffer is whatever the
     * previous scan left there. Without honouring it the code carries a tail of
     * the code before it, which no GS1 parser survives. A missing or impossible
     * length falls back to trimming the NUL padding.
     */
    private fun bytes(value: ByteArray, length: Any?): String? {
        val declared = (length as? Number)?.toInt()?.takeIf { it in 0..value.size } ?: value.size
        val end = value.copyOfRange(0, declared).takeWhile { it != NUL }.toByteArray()
        return String(end, Charsets.UTF_8).ifEmpty { null }
    }

    /** Half the vendors name the symbology, the other half number it. Both are diagnostics only. */
    private fun label(value: Any?): String? = when (value) {
        is String -> value.ifEmpty { null }
        is CharSequence -> value.toString().ifEmpty { null }
        is Number -> value.toString()
        else -> null
    }

    private companion object {
        /** Urovo's `BARCODE_LENGTH_TAG`. No other profile sends it, so reading it costs nothing. */
        const val LENGTH = "length"
        const val NUL = 0.toByte()
    }
}
