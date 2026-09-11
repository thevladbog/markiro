package app.markiro.handheld.core.box

import app.markiro.handheld.core.km.KmCodec

/** Refusals carry the domain's own codes, because `box-label-fixtures.json` pins them. */
class SsccException(val code: String, message: String) : Exception(message)

/**
 * Port of `packages/domain/src/gs1/sscc.ts`.
 *
 * Pinned by `box-label-fixtures.json`: a check digit that disagrees with the
 * domain is a label carrying a number that will not reconcile at the receiver,
 * and nothing downstream would catch it.
 */
object Sscc {
    private val PREFIX = Regex("^\\d{4,12}$")

    /** Serials available per prefix and extension: the serial field is 16 - |prefix| digits. */
    fun serialCapacity(gs1Prefix: String): Long {
        if (!PREFIX.matches(gs1Prefix)) throw SsccException("SSCC_PREFIX", "bad GS1 prefix: \"$gs1Prefix\"")
        var capacity = 1L
        repeat(16 - gs1Prefix.length) { capacity *= 10 }
        return capacity
    }

    fun build(extensionDigit: Int, gs1Prefix: String, serial: Long): String {
        if (extensionDigit !in 0..9) throw SsccException("SSCC_PREFIX", "bad extension digit: $extensionDigit")
        val capacity = serialCapacity(gs1Prefix)
        if (serial < 0 || serial >= capacity) {
            throw SsccException("SSCC_RANGE", "serial $serial outside 0..${capacity - 1}")
        }
        val body = "$extensionDigit$gs1Prefix" + serial.toString().padStart(16 - gs1Prefix.length, '0')
        return body + KmCodec.checkDigit(body)
    }

    /**
     * The 18 digits of a scanned SSCC label, or null.
     *
     * A box label carries GS1 element string `(00)` + 18 digits. Some scanners
     * keep the parentheses, some emit the bare AI, and a keyboard wedge can add
     * whitespace. A bare 18-digit string is taken as-is rather than having a
     * leading `00` stripped: an SSCC legitimately starts with its extension
     * digit, so stripping would corrupt every box number beginning `00`.
     *
     * Deliberately no check-digit validation: the only consumer looks the value
     * up among boxes this device closed, and a mis-decoded scan finds nothing
     * and is reported as an unknown label either way.
     */
    fun parse(raw: String): String? {
        val trimmed = raw.trim()
        val body = when {
            trimmed.startsWith("(00)") -> trimmed.removePrefix("(00)")
            trimmed.length == 20 && trimmed.startsWith("00") -> trimmed.drop(2)
            else -> trimmed
        }
        return body.takeIf { it.length == 18 && it.all(Char::isDigit) }
    }
}
