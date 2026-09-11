package app.markiro.handheld.core.barcode

import app.markiro.handheld.core.label.LabelRenderException

/** ECC200's function-1 codeword. First in the stream it declares GS1 data; later it separates AIs. */
const val FNC1 = 232

/** ECC200's first pad codeword; every pad after it is randomised by position. */
private const val PAD = 129
private const val UPPER_SHIFT = 235
private const val GS = '\u001d'

/**
 * A canonical marking code as an unpadded ECC200 codeword stream.
 *
 * The leading FNC1 is what makes the symbol a GS1 Data Matrix rather than a
 * Data Matrix that happens to contain AIs, and each separator becomes an FNC1
 * codeword rather than a literal GS byte -- a scanner re-emits it as GS when it
 * decodes, which is why the round-trip test expects the separators back.
 *
 * ASCII encodation only. C40, Text, X12, EDIFACT and Base256 would produce a
 * smaller symbol for some codes; none of them would produce a MORE correct one,
 * and each is a separate latch/unlatch state machine to get wrong.
 */
fun gs1Codewords(canonicalRaw: String): IntArray {
    val out = ArrayList<Int>(canonicalRaw.length + 1)
    out += FNC1
    var i = 0
    while (i < canonicalRaw.length) {
        val ch = canonicalRaw[i]
        when {
            ch == GS -> {
                out += FNC1
                i += 1
            }
            ch.isAsciiDigit() && i + 1 < canonicalRaw.length && canonicalRaw[i + 1].isAsciiDigit() -> {
                out += 130 + (ch - '0') * 10 + (canonicalRaw[i + 1] - '0')
                i += 2
            }
            ch.code < 128 -> {
                out += ch.code + 1
                i += 1
            }
            ch.code < 256 -> {
                out += UPPER_SHIFT
                out += ch.code - 128 + 1
                i += 1
            }
            else -> throw LabelRenderException("marking code contains a character the symbol cannot carry")
        }
    }
    return out.toIntArray()
}

/**
 * Pads a stream to a symbol's data capacity.
 *
 * The first pad is a plain 129 and the rest are randomised against their own
 * 1-based position in the stream, exactly as the standard specifies: a long
 * tail of identical pad codewords would otherwise print as a regular block of
 * modules that reads poorly.
 */
fun padCodewords(codewords: IntArray, capacity: Int): IntArray {
    if (codewords.size > capacity) {
        throw LabelRenderException("marking code needs ${codewords.size} codewords, capacity is $capacity")
    }
    if (codewords.size == capacity) return codewords
    val out = codewords.copyOf(capacity)
    out[codewords.size] = PAD
    for (index in codewords.size + 1 until capacity) {
        // `index` is zero-based; the standard's position is one-based.
        val pseudoRandom = (149 * (index + 1)) % 253 + 1
        val value = PAD + pseudoRandom
        out[index] = if (value <= 254) value else value - 254
    }
    return out
}

private fun Char.isAsciiDigit(): Boolean = this in '0'..'9'
