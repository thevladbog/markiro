package app.markiro.handheld.core.barcode

import app.markiro.handheld.core.label.LabelRenderException
import com.google.zxing.datamatrix.encoder.DefaultPlacement
import com.google.zxing.datamatrix.encoder.ErrorCorrection
import com.google.zxing.datamatrix.encoder.SymbolInfo
import com.google.zxing.datamatrix.encoder.SymbolShapeHint

/** A finished symbol: one boolean per module, row major, true is black. */
class ModuleGrid(val width: Int, val height: Int, val modules: BooleanArray) {
    operator fun get(x: Int, y: Int): Boolean = modules[y * width + x]
}

/**
 * A canonical marking code as a printable GS1 Data Matrix.
 *
 * Only the framing is ours. Choosing the symbol size, computing Reed-Solomon
 * error correction and placing the data modules are ZXing's -- all three are
 * fiddly, all three are identical for every Data Matrix ever made, and a subtle
 * error in any of them produces a symbol that looks right and scans wrong.
 * What ZXing will not do is GS1, which is why the codeword stream is built here.
 *
 * Square symbols only. A rectangular one would be legal, but the template
 * reserves a square, and a template author sizing a square around an 8x32
 * symbol is a worse failure than a slightly larger square symbol.
 */
fun encodeGs1DataMatrix(canonicalRaw: String): ModuleGrid {
    val codewords = gs1Codewords(canonicalRaw)
    val info = runCatching { SymbolInfo.lookup(codewords.size, SymbolShapeHint.FORCE_SQUARE) }.getOrNull()
        ?: throw LabelRenderException("marking code is too long for a Data Matrix symbol")
    val padded = padCodewords(codewords, info.dataCapacity)
    val encoded = ErrorCorrection.encodeECC200(String(CharArray(padded.size) { padded[it].toChar() }), info)
    val placement = DefaultPlacement(encoded, info.symbolDataWidth, info.symbolDataHeight)
    placement.place()
    return compose(placement, info)
}

/**
 * Wraps the placed data regions in their patterns: a solid L down the left and
 * along the bottom of each region, and an alternating clock track along its top
 * and right. A symbol of 32 modules or more carries several regions, each with
 * its own full set, which is why this walks regions rather than the outer edge.
 */
private fun compose(placement: DefaultPlacement, info: SymbolInfo): ModuleGrid {
    val width = info.symbolWidth
    val height = info.symbolHeight
    val modules = BooleanArray(width * height)
    fun set(x: Int, y: Int, value: Boolean) {
        modules[y * width + x] = value
    }

    var matrixY = 0
    for (y in 0 until info.symbolDataHeight) {
        if (y % info.matrixHeight == 0) {
            for (x in 0 until width) set(x, matrixY, x % 2 == 0)
            matrixY += 1
        }
        var matrixX = 0
        for (x in 0 until info.symbolDataWidth) {
            if (x % info.matrixWidth == 0) {
                set(matrixX, matrixY, true)
                matrixX += 1
            }
            set(matrixX, matrixY, placement.getBit(x, y))
            matrixX += 1
            if (x % info.matrixWidth == info.matrixWidth - 1) {
                set(matrixX, matrixY, y % 2 == 0)
                matrixX += 1
            }
        }
        matrixY += 1
        if (y % info.matrixHeight == info.matrixHeight - 1) {
            for (x in 0 until width) set(x, matrixY, true)
            matrixY += 1
        }
    }
    return ModuleGrid(width, height, modules)
}
