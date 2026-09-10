package app.markiro.handheld.core.km

import java.security.MessageDigest

/** Same codes as `DomainError` in packages/domain (`KM_*`, `GTIN_INVALID`). */
class KmException(val code: String, message: String) : RuntimeException(message)

/** `canonicalRaw` is what the server re-parses; `ais` keeps the crypto tail for display only. */
data class ParsedKm(val canonicalRaw: String, val gtin14: String, val serial: String, val ais: Map<String, String>)

/**
 * Port of packages/domain/src/gs1/km.ts (`canonicalizeKm`, `parseKm`, `kmKey`, `kmHash`) and
 * gtin.ts / check-digit.ts. Verified against the fixtures the domain package exports; any
 * divergence makes the server reject a whole scan batch, so change both sides together.
 */
object KmCodec {
    const val GS = '\u001d'
    const val MAX_UTF8_BYTES = 1024
    private val GTIN_LENGTHS = setOf(8, 12, 13, 14)

    fun canonicalize(raw: String): ParsedKm {
        var s = trimEdges(raw)
        if (s.startsWith("]d2")) s = s.substring(3)
        s = trimEdges(s)
        if (s.contains('\ufffd')) throw KmException("KM_BAD_ENCODING", "KM contains a replacement character")
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (c.isHighSurrogate()) {
                if (i + 1 >= s.length || !s[i + 1].isLowSurrogate()) {
                    throw KmException("KM_BAD_ENCODING", "KM contains an unpaired UTF-16 surrogate")
                }
                i += 2
                continue
            }
            if (c.isLowSurrogate()) throw KmException("KM_BAD_ENCODING", "KM contains an unpaired UTF-16 surrogate")
            if ((c.code < 0x20 && c != GS) || c.code == 0x7f) {
                throw KmException("KM_BAD_CONTROL", "KM contains a forbidden control character")
            }
            i += 1
        }
        if (s.toByteArray(Charsets.UTF_8).size > MAX_UTF8_BYTES) {
            throw KmException("KM_TOO_LONG", "KM exceeds the $MAX_UTF8_BYTES-byte UTF-8 limit")
        }
        return parse(s)
    }

    /** Structural parse of `01<gtin14>21<serial>[GS<ai><value>]*`, then GTIN check digit, then duplicate AIs. */
    fun parse(raw: String): ParsedKm {
        if (raw.isEmpty()) throw KmException("KM_EMPTY", "empty scan")
        var s = if (raw.startsWith("]d2")) raw.substring(3) else raw
        if (!s.startsWith("01")) throw KmException("KM_NO_GTIN", "KM must start with AI 01")
        val gtinField = s.substring(2, minOf(16, s.length))
        if (gtinField.length != 14 || !gtinField.all { it in '0'..'9' }) {
            throw KmException("KM_BAD_GTIN", "KM AI 01 GTIN must be 14 digits")
        }
        s = s.substring(16)
        if (!s.startsWith("21")) throw KmException("KM_NO_SERIAL", "KM must carry AI 21 serial")
        val gsAt = s.indexOf(GS)
        val serial = if (gsAt == -1) s.substring(2) else s.substring(2, gsAt)
        if (serial.isEmpty()) throw KmException("KM_NO_SERIAL", "KM serial is empty")
        val ordered = ArrayList<Pair<String, String>>()
        var rest = if (gsAt == -1) "" else s.substring(gsAt + 1)
        if (gsAt != -1 && rest.isEmpty()) throw KmException("KM_EMPTY_AI", "KM contains an empty trailing AI segment")
        while (rest.isNotEmpty()) {
            if (rest.startsWith(GS)) throw KmException("KM_EMPTY_AI", "KM contains an empty trailing AI segment")
            if (rest.length <= 2) throw KmException("KM_BAD_AI", "KM contains an incomplete trailing AI segment")
            val ai = rest.substring(0, 2)
            if (!ai.all { it in '0'..'9' }) throw KmException("KM_BAD_AI", "KM trailing AI must be two digits")
            val end = rest.indexOf(GS)
            val value = if (end == -1) rest.substring(2) else rest.substring(2, end)
            if (value.isEmpty()) throw KmException("KM_EMPTY_AI", "KM trailing AI $ai has an empty value")
            if (end == rest.length - 1) throw KmException("KM_EMPTY_AI", "KM contains an empty trailing AI segment")
            ordered += ai to value
            rest = if (end == -1) "" else rest.substring(end + 1)
        }
        val gtin14 = normalizeGtin14(gtinField)
        val ais = LinkedHashMap<String, String>()
        for ((ai, value) in ordered) {
            if (ais.containsKey(ai)) throw KmException("KM_DUPLICATE_AI", "KM contains duplicate trailing AI $ai")
            ais[ai] = value
        }
        return ParsedKm(raw, gtin14, serial, ais)
    }

    /** Canonical duplicate-detection identity; the crypto tail is deliberately excluded. */
    fun key(km: ParsedKm): String = "01${km.gtin14}21${km.serial}"

    fun hash(km: ParsedKm): String =
        MessageDigest.getInstance("SHA-256").digest(key(km).toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    fun normalizeGtin14(input: String): String {
        if (input.isEmpty() || !input.all { it in '0'..'9' } || input.length !in GTIN_LENGTHS) {
            throw KmException("GTIN_INVALID", "not a GTIN: \"$input\"")
        }
        if (!hasValidCheckDigit(input)) throw KmException("GTIN_INVALID", "check digit mismatch: \"$input\"")
        return input.padStart(14, '0')
    }

    /** GS1 mod-10: the rightmost body digit carries weight 3, alternating leftwards. */
    fun checkDigit(body: String): Int {
        var sum = 0
        for (i in body.indices) {
            val digit = body[body.length - 1 - i] - '0'
            sum += if (i % 2 == 0) digit * 3 else digit
        }
        return (10 - (sum % 10)) % 10
    }

    fun hasValidCheckDigit(code: String): Boolean =
        code.length >= 2 && code.all { it in '0'..'9' } && checkDigit(code.dropLast(1)) == code.last() - '0'

    private fun trimEdges(s: String): String {
        var start = 0
        var end = s.length
        while (start < end && (s[start] == ' ' || s[start] == '\t')) start += 1
        while (end > start && (s[end - 1] == ' ' || s[end - 1] == '\t')) end -= 1
        return s.substring(start, end)
    }
}
