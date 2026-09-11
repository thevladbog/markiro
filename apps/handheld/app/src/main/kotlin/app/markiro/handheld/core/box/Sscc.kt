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
}
