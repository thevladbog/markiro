package app.markiro.handheld.core.label

import app.markiro.handheld.core.barcode.rasterizeGs1DataMatrix
import java.io.ByteArrayOutputStream
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/** The historical narrow-bar width used when a template sets no module width. */
private const val DEFAULT_NARROW_DOTS = 2

/**
 * Port of `generateTspl` in packages/domain/src/labels/tspl.ts.
 *
 * Returns bytes rather than text because the image command's payload is raw binary. Encoding this
 * document as UTF-8 at any point would turn every payload byte above 0x7F into two bytes and destroy
 * the bitmap.
 *
 * The media gap and print direction are fixed here rather than carried on the template: they are a
 * property of the printer and its media, not of the label design.
 */
suspend fun generateTspl(
    spec: LabelSpec,
    data: Map<LabelField, String>,
    rasterize: RasterizeText?,
): ByteArray {
    val out = ByteArrayOutputStream()
    fun line(text: String) {
        out.write(text.toByteArray(Charsets.ISO_8859_1))
        out.write('\n'.code)
    }
    line("SIZE ${number(spec.widthMm)} mm, ${number(spec.heightMm)} mm")
    line("GAP 2 mm, 0 mm")
    line("DIRECTION 1")
    line("CLS")
    for (element in spec.elements) {
        when (element) {
            is LabelElement.Text -> textLike(
                spec, element.xMm, element.yMm, element.text, element.fontSizePt, element.bold,
                element.align, element.maxWidthMm, element.maxLines, rasterize, out, ::line,
            )
            is LabelElement.Field -> textLike(
                spec, element.xMm, element.yMm,
                labelFieldDisplayValue(element.field, data, element.textFormat),
                element.fontSizePt, element.bold, element.align, element.maxWidthMm, element.maxLines,
                rasterize, out, ::line,
            )
            is LabelElement.Barcode -> barcode(spec, element, data, out, ::line)
            is LabelElement.Line -> line(bar(spec, element))
            is LabelElement.Box -> line(box(spec, element))
        }
    }
    line("PRINT 1")
    return out.toByteArray()
}

/**
 * Renders a number the way the original does: a whole value carries no decimal point. Kotlin would
 * otherwise write `58.0` where the reference writes `58`, and the page size would differ.
 */
private fun number(value: Double): String =
    if (value == value.toLong().toDouble()) value.toLong().toString() else value.toString()

/** Doubling a quote is this language's only escape. Everything else, control bytes included, passes through. */
private fun escape(text: String): String = text.replace("\"", "\"\"")

@Suppress("LongParameterList")
private suspend fun textLike(
    spec: LabelSpec,
    xMm: Double,
    yMm: Double,
    text: String,
    fontSizePt: Double,
    bold: Boolean?,
    align: LabelAlign?,
    maxWidthMm: Double?,
    maxLines: Int?,
    rasterize: RasterizeText?,
    out: ByteArrayOutputStream,
    line: (String) -> Unit,
) {
    val x = mmToDots(xMm, spec.dpi)
    val y = mmToDots(yMm, spec.dpi)
    val maxWidthDots = maxWidthMm?.let { mmToDots(it, spec.dpi) }
    if (needsImageRendering(text)) {
        if (rasterize == null) {
            throw LabelRenderException(
                "label text \"$text\" contains characters outside printable ASCII and needs image rendering, " +
                    "but no rasterizer was provided",
            )
        }
        val raster = rasterize.rasterize(
            text,
            RasterOptions(
                fontFamily = "sans-serif",
                fontSizePx = ptToDots(fontSizePt, spec.dpi),
                bold = bold ?: false,
                maxWidthPx = maxWidthDots,
                maxLines = maxLines ?: 1,
            ),
        )
        val offset = rasterAlignOffsetDots(align, maxWidthDots, raster.width)
        buildBitmapCommand(x + offset, y, raster, out)
        out.write('\n'.code)
        return
    }
    // Wrapping returns null when the element carries no box or the text already fits, which keeps
    // output identical for templates written before wrapping existed.
    val wrapped = if (maxWidthMm == null) {
        null
    } else {
        wrapTextToWidth(text, { estimatedTextWidthMm(it, fontSizePt) }, maxWidthMm, maxLines ?: 1)
            .takeUnless { it.size == 1 && it[0] == text }
    }
    val lines = wrapped ?: listOf(text)
    val step = mmToDots(ptToMm(fontSizePt) * LINE_HEIGHT_EM, spec.dpi)
    lines.forEachIndexed { index, content ->
        // Alignment is measured with the same estimate used for wrapping, so the two never disagree.
        val offset = rasterAlignOffsetDots(align, maxWidthDots, mmToDots(estimatedTextWidthMm(content, fontSizePt), spec.dpi))
        // The font size goes into both scale slots unconverted: the internal scalable font reads
        // them as points, and `bold` has no native effect because that font carries no weight.
        line("TEXT ${x + offset},${y + index * step},\"0\",0,${number(fontSizePt)},${number(fontSizePt)},\"${escape(content)}\"")
    }
}

private fun barcode(
    spec: LabelSpec,
    element: LabelElement.Barcode,
    data: Map<LabelField, String>,
    out: ByteArrayOutputStream,
    line: (String) -> Unit,
) {
    val x = mmToDots(element.xMm, spec.dpi)
    val y = mmToDots(element.yMm, spec.dpi)
    val source = element.data
    // This language's own DMATRIX carries no FNC1, so a native symbol would be a plain Data Matrix
    // rather than a GS1 one. The bitmap is the only correct form, and it is the same bitmap the
    // other language sends.
    if (element.format == BarcodeFormat.DATAMATRIX && source is BarcodeSource.Field && source.field == LabelField.KM_CODE) {
        val raw = data[LabelField.KM_CODE].orEmpty()
        if (raw.isEmpty()) throw LabelRenderException("no marking code to print")
        // Unlike every other barcode element, `sizeMm` here is the whole symbol square.
        buildBitmapCommand(x, y, rasterizeGs1DataMatrix(raw, mmToDots(element.sizeMm, spec.dpi)), out)
        out.write('\n'.code)
        return
    }
    if (element.format != BarcodeFormat.CODE128) {
        throw LabelRenderException("barcode format ${element.format.wire} is not supported on this device")
    }
    val value = when (source) {
        is BarcodeSource.Field -> data[source.field] ?: ""
        is BarcodeSource.Literal -> source.value
    }
    val gs1 = source is BarcodeSource.Field && source.field == LabelField.SSCC
    // `!1` is this language's GS1 flag and `00` is the application identifier, added here and
    // nowhere else.
    val payload = if (gs1) "!100$value" else value
    val narrow = element.moduleWidthMm?.let { max(1, mmToDots(it, spec.dpi)) } ?: DEFAULT_NARROW_DOTS
    // The interpretation line is off, matching the other language.
    line("BARCODE $x,$y,\"128\",${mmToDots(element.sizeMm, spec.dpi)},0,0,$narrow,$narrow,\"${escape(payload)}\"")
}

private fun bar(spec: LabelSpec, element: LabelElement.Line): String {
    val thickness = mmToDots(element.thicknessMm, spec.dpi)
    val spanX = mmToDots(abs(element.x2Mm - element.xMm), spec.dpi)
    val spanY = mmToDots(abs(element.y2Mm - element.yMm), spec.dpi)
    val originX = mmToDots(min(element.xMm, element.x2Mm), spec.dpi)
    val originY = mmToDots(min(element.yMm, element.y2Mm), spec.dpi)
    return "BAR $originX,$originY,${max(spanX, thickness)},${max(spanY, thickness)}"
}

private fun box(spec: LabelSpec, element: LabelElement.Box): String {
    val x = mmToDots(element.xMm, spec.dpi)
    val y = mmToDots(element.yMm, spec.dpi)
    // The end corner sums two separately rounded values. Rounding the sum instead can differ by a dot.
    val xEnd = x + mmToDots(element.widthMm, spec.dpi)
    val yEnd = y + mmToDots(element.heightMm, spec.dpi)
    return "BOX $x,$y,$xEnd,$yEnd,${mmToDots(element.thicknessMm, spec.dpi)}"
}
