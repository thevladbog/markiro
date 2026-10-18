package app.markiro.handheld.feature.pairing

import app.markiro.handheld.core.network.host.CertPin

/**
 * The host's one-time code (10 Crockford characters) and the payload of the office's DataMatrix
 * (`markiro-host:1?h=<a,b>&p=<port>&f=<fingerprint>&c=<code>`): `markiro_proto::pairing::normalize` and the webview's
 * `parsePairingPayload`, pinned by `pairing-codes.json` and `pairing-payloads.json`. The Russian-layout recovery of a keyboard
 * wedge stays in the webview.
 */
object HostPairingCode {
    const val LENGTH = 10
    private const val ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    private val IPV4 = Regex("^(0|[1-9]\\d{0,2})\\.(0|[1-9]\\d{0,2})\\.(0|[1-9]\\d{0,2})\\.(0|[1-9]\\d{0,2})$")
    private val PORT = Regex("^\\d{1,5}$")

    /** Unicode White_Space, exactly what Rust's `char::is_whitespace` accepts (Java's own tests miss U+0085 and others). */
    private fun isWhiteSpace(c: Char): Boolean =
        c in '\u0009'..'\u000d' || c == ' ' || c == '\u0085' || c == '\u00a0' || c == '\u1680' ||
            c in '\u2000'..'\u200a' || c == '\u2028' || c == '\u2029' || c == '\u202f' ||
            c == '\u205f' || c == '\u3000'

    /** The ASCII hyphen, the dashes U+2010..U+2015 and the minus sign U+2212. */
    private fun isDash(c: Char): Boolean = c == '-' || c in '\u2010'..'\u2015' || c == '\u2212'

    /**
     * The canonical form of a typed or scanned code: separators skipped, ASCII letters upper-cased, O read as 0, I and L as 1.
     * `null` when the input cannot be a code.
     */
    fun normalize(input: String): String? {
        val code = StringBuilder()
        for (symbol in input) {
            if (isWhiteSpace(symbol) || isDash(symbol)) continue
            val upper = if (symbol in 'a'..'z') symbol.uppercaseChar() else symbol
            val canonical = when (upper) {
                'O' -> '0'
                'I', 'L' -> '1'
                else -> upper
            }
            if (ALPHABET.indexOf(canonical) < 0) return null
            code.append(canonical)
            if (code.length > LENGTH) return null
        }
        return code.toString().takeIf { it.length == LENGTH }
    }

    data class Payload(val addresses: List<String>, val port: Int, val fingerprint: String, val code: String)

    private fun trimmed(text: String): String {
        var start = 0
        var end = text.length
        while (start < end && isWhiteSpace(text[start])) start++
        while (end > start && isWhiteSpace(text[end - 1])) end--
        return text.substring(start, end)
    }

    private fun isIpv4(address: String): Boolean {
        val match = IPV4.matchEntire(address) ?: return false
        return match.groupValues.drop(1).all { it.toInt() <= 255 }
    }

    /** The payload of a scan: plain, behind the AIM identifier `]d1`, or typed with Caps Lock on. `null` when it is no payload of protocol 1. */
    fun parsePayload(text: String): Payload? {
        val body = trimmed(text).replace(Regex("^\\][dD]\\d"), "")
        val query = body.indexOf('?')
        if (query < 0 || !body.substring(0, query).equals("markiro-host:1", ignoreCase = true)) return null
        val fields = HashMap<String, String>()
        for (field in body.substring(query + 1).split("&")) {
            val equals = field.indexOf('=')
            if (equals < 0) return null
            val key = field.substring(0, equals).lowercase()
            if (key in fields) return null
            fields[key] = field.substring(equals + 1)
        }
        val hosts = fields["h"] ?: return null
        val port = fields["p"] ?: return null
        val fingerprint = fields["f"]?.lowercase() ?: return null
        val code = normalize(fields["c"] ?: "") ?: return null
        val addresses = if (hosts.isEmpty()) emptyList() else hosts.split(",")
        val portNumber = if (PORT.matches(port)) port.toInt() else 0
        if (!addresses.all(::isIpv4) || portNumber !in 1..65535) return null
        if (!CertPin.isFingerprint(fingerprint)) return null
        return Payload(addresses, portNumber, fingerprint, code)
    }
}
