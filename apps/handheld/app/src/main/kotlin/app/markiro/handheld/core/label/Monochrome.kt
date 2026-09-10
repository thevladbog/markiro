package app.markiro.handheld.core.label

import java.io.ByteArrayOutputStream

data class ZplPacking(val hex: String, val totalBytes: Int, val bytesPerRow: Int)

private const val HEX = "0123456789ABCDEF"

/**
 * Port of `convertToMonochrome` in packages/domain/src/labels/raster.ts. One byte per pixel, 1 for
 * black. BT.601 luminance in floating point, then a hard threshold with no dithering; exactly 127
 * is black. Alpha is ignored, matching the original, so callers must draw onto an opaque background.
 *
 * Channels are masked to unsigned. Reading a channel of 0x80 or more as a signed byte would invert
 * the image.
 */
fun convertToMonochrome(argb: IntArray, width: Int, height: Int): ByteArray {
    val out = ByteArray(width * height)
    val count = minOf(argb.size, out.size)
    for (i in 0 until count) {
        val pixel = argb[i]
        val r = (pixel shr 16) and 0xFF
        val g = (pixel shr 8) and 0xFF
        val b = pixel and 0xFF
        val grey = 0.299 * r + 0.587 * g + 0.114 * b
        out[i] = if (grey > 127.0) 0 else 1
    }
    return out
}

/**
 * Port of `bitmapToZplHex` in the same module. Row major, top row first, most significant bit is the
 * leftmost pixel of its byte. Rows pad to whole bytes and the padding bits stay zero, which is white
 * in ZPL polarity.
 */
fun bitmapToZplHex(bitmap: ByteArray, width: Int, height: Int): ZplPacking {
    val bytesPerRow = (width + 7) / 8
    val hex = StringBuilder(bytesPerRow * height * 2)
    for (y in 0 until height) {
        for (x in 0 until bytesPerRow) {
            var byte = 0
            for (bit in 0 until 8) {
                val pixelX = x * 8 + bit
                if (pixelX < width) {
                    val index = y * width + pixelX
                    if (index < bitmap.size && bitmap[index].toInt() == 1) byte = byte or (1 shl (7 - bit))
                }
            }
            hex.append(HEX[(byte shr 4) and 0xF]).append(HEX[byte and 0xF])
        }
    }
    return ZplPacking(hex.toString(), bytesPerRow * height, bytesPerRow)
}

/** `^GFA,<binaryBytes>,<graphicBytes>,<bytesPerRow>,<hex>`. The caller supplies the origin and the field separator. */
fun buildGfaCommand(r: RasterResult): String = "^GFA,${r.totalBytes},${r.totalBytes},${r.bytesPerRow},${r.hex}"

/**
 * The one place polarity is flipped. ZPL sets a bit for black; TSPL's overwrite mode sets a bit for
 * white. Every bit is inverted, including the row padding, so padding that was white under one
 * convention stays white under the other.
 */
fun tsplBitmapBytes(hex: String): ByteArray {
    val out = ByteArray(hex.length / 2)
    for (i in out.indices) {
        val value = hex.substring(i * 2, i * 2 + 2).toInt(16)
        out[i] = (value xor 0xFF).toByte()
    }
    return out
}

/**
 * `BITMAP x,y,<widthInBytes>,<heightInDots>,<mode 0>,<raw bytes>`. The payload is binary and runs to
 * the end of the line, so this writes into the document stream rather than returning a string.
 */
fun buildBitmapCommand(x: Int, y: Int, r: RasterResult, out: ByteArrayOutputStream) {
    out.write("BITMAP $x,$y,${r.bytesPerRow},${r.height},0,".toByteArray(Charsets.US_ASCII))
    out.write(tsplBitmapBytes(r.hex))
}
