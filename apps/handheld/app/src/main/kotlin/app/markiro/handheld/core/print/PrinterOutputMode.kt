package app.markiro.handheld.core.print

import app.markiro.handheld.core.label.LabelRenderException

/** Apply to new RAW output before freezing bytes and digests; never to a saved replay. */
fun applyPrinterOutputMode(document: ByteArray, language: String, mode: String?): ByteArray {
    if (mode == null) return document
    val code = when (mode) {
        "normal" -> "T"
        "peel" -> "P"
        "cutter" -> "C"
        else -> throw LabelRenderException("Unsupported printer output mode")
    }
    return when (language) {
        "zpl" -> {
            if (document.size < 3 || document[0] != 94.toByte() || document[1] != 88.toByte() || document[2] != 65.toByte())
                throw LabelRenderException("ZPL document must start with ^XA")
            "^XA\n^MM$code\n".toByteArray(Charsets.US_ASCII) + document.copyOfRange(3, document.size)
        }
        "tspl" -> {
            // The first command is textual. Match its framing without decoding the bitmap bytes.
            val firstLineEnd = document.indexOf('\n'.code.toByte())
            val terminator = if (firstLineEnd > 0 && document[firstLineEnd - 1] == '\r'.code.toByte()) "\r\n" else "\n"
            val commands = when (mode) {
                "cutter" -> listOf("SET PEEL OFF", "SET CUTTER 1")
                "peel" -> listOf("SET CUTTER OFF", "SET PEEL ON")
                else -> listOf("SET CUTTER OFF", "SET PEEL OFF")
            }
            commands.joinToString(terminator, postfix = terminator).toByteArray(Charsets.US_ASCII) + document
        }
        else -> throw LabelRenderException("Unsupported printer language")
    }
}
