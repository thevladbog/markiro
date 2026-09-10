package app.markiro.handheld.core.scan

/** Vendor wedges often replace the unprintable separator with text; scans must carry the real byte. */
object ScanNormalizer {
    private const val GS = ""
    private val substitutes = listOf("<GS>", "{GS}", "\\x1d", "\\x1D", "\\u001d", "\\u001D")
    private val aimPrefix = Regex("^\\][A-Za-z][0-9A-Za-z]")

    fun normalize(raw: String): String {
        var value = raw.trimEnd('\r', '\n')
        value = aimPrefix.replace(value, "")
        for (token in substitutes) value = value.replace(token, GS)
        return value
    }
}
