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
            val commands = when (mode) {
                "cutter" -> "SET PEEL OFF\nSET CUTTER 1\n"
                "peel" -> "SET CUTTER OFF\nSET PEEL ON\n"
                else -> "SET CUTTER OFF\nSET PEEL OFF\n"
            }
            commands.toByteArray(Charsets.US_ASCII) + document
        }
        else -> throw LabelRenderException("Unsupported printer language")
    }
}
