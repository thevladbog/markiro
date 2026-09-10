package app.markiro.handheld.core.inventory

import java.security.MessageDigest

/**
 * Builds the exact bytes `JSON.stringify` would produce for the domain's canonical objects: no
 * whitespace, insertion key order, `"` `\` and control characters escaped (short forms for
 * \b \f \n \r \t, `\u00xx` otherwise), everything else verbatim.
 */
object CanonicalJson {
    const val NULL = "null"

    fun str(value: String): String {
        val sb = StringBuilder(value.length + 2).append('"')
        for (ch in value) {
            when (ch) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\b' -> sb.append("\\b")
                '\u000c' -> sb.append("\\f")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> if (ch.code < 0x20) sb.append("\\u").append(ch.code.toString(16).padStart(4, '0')) else sb.append(ch)
            }
        }
        return sb.append('"').toString()
    }

    fun num(value: Long): String = value.toString()
    fun num(value: Int): String = value.toString()
    fun bool(value: Boolean): String = if (value) "true" else "false"
    fun strOrNull(value: String?): String = value?.let(::str) ?: NULL
    fun arr(items: List<String>): String = items.joinToString(",", "[", "]")
    fun obj(vararg fields: Pair<String, String>): String = fields.joinToString(",", "{", "}") { (k, v) -> str(k) + ":" + v }

    fun sha256Hex(text: String): String =
        MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
}
