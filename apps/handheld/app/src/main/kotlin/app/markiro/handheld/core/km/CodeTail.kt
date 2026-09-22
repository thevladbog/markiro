package app.markiro.handheld.core.km

/**
 * How a unit is named on screen, everywhere: the tail of its serial.
 *
 * One rule for the work-screen journal, the last-scan strip and the
 * exceptions screen, so «Последний скан: …LHnBNvDM» matches the journal row
 * for the same unit. A hash tail is diagnostics, never an operator-facing name.
 * Display only: the full raw code stays in storage, printing and verification.
 */
fun serialTail(serial: String): String = if (serial.length > 8) "…" + serial.takeLast(8) else serial

/** [serialTail] of a raw scan; a code that does not parse keeps its raw tail, because that is all there is to show. */
fun feedTail(raw: String): String {
    val serial = runCatching { KmCodec.canonicalize(raw).serial }.getOrNull()
        ?: raw.substringBefore(KmCodec.GS).trim()
    return serialTail(serial)
}
