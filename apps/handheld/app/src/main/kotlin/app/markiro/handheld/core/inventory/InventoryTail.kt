package app.markiro.handheld.core.inventory

import app.markiro.handheld.core.km.KmCodec

/**
 * The short code label the work screen shows: `…<last 4 alphanumerics of the serial>` for items and
 * `…<last 4 digits>` for SSCCs (spec §"Classification"). The verdict card, the feed and a restored
 * last scan all go through here so a crypto tail (`<GS>93…`) never leaks into the label.
 */
object InventoryTail {
    fun ofSerial(serial: String): String? {
        val chars = serial.filter { it.isLetterOrDigit() }
        return if (chars.isEmpty()) null else "…" + chars.takeLast(4)
    }

    fun ofSscc(sscc: String): String = "…" + sscc.takeLast(4)

    /** Tail of a recorded event read back from storage; `null` when the raw cannot be parsed. */
    fun ofEvent(kind: String, canonicalRaw: String?): String? {
        if (canonicalRaw == null) return null
        return when (kind) {
            "item" -> runCatching { KmCodec.canonicalize(canonicalRaw).serial }.getOrNull()?.let(::ofSerial)
            "known_box", "old_box" -> ofSscc(canonicalRaw)
            else -> null
        }
    }
}
