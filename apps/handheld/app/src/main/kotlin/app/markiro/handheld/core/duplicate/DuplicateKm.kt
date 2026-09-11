package app.markiro.handheld.core.duplicate

import app.markiro.handheld.core.km.KmCodec
import app.markiro.handheld.core.km.KmException
import app.markiro.handheld.core.km.ParsedKm
import java.security.MessageDigest

enum class DuplicateMatch { MATCH, MISMATCH, INVALID }

/**
 * Eligibility for duplication, not a check of the crypto signature's
 * authenticity: a code with no crypto tail cannot be reproduced as a valid
 * marking code, so it must never reach a label.
 *
 * Port of `parseDuplicateKm` in packages/domain/src/product-labels/km.ts.
 */
fun parseDuplicateKm(raw: String): ParsedKm {
    val km = KmCodec.canonicalize(raw)
    val complete = km.ais["93"] != null || (km.ais["91"] != null && km.ais["92"] != null)
    if (!complete) throw KmException("KM_REPRINT_INCOMPLETE", "Complete marking code required")
    return km
}

/**
 * Compares the FULL raw code, separators and crypto tail included -- unlike
 * `KmCodec.hash`, which deliberately drops the tail so two scans of one physical
 * item collide. Using the identity here would accept a different unit of the
 * same product as a valid verification.
 */
fun compareDuplicateKm(expected: String, scanned: String): DuplicateMatch {
    // A damaged saved payload is a storage failure, not an operator mismatch, so
    // it is deliberately not caught here.
    val canonicalExpected = parseDuplicateKm(expected).canonicalRaw
    return try {
        if (parseDuplicateKm(scanned).canonicalRaw == canonicalExpected) {
            DuplicateMatch.MATCH
        } else {
            DuplicateMatch.MISMATCH
        }
    } catch (_: KmException) {
        DuplicateMatch.INVALID
    }
}

fun productLabelBytesDigest(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

/** Unlike `KmCodec.hash`, this covers every separator and the entire crypto tail. */
fun duplicatePayloadDigest(raw: String): String =
    productLabelBytesDigest(parseDuplicateKm(raw).canonicalRaw.toByteArray(Charsets.UTF_8))
