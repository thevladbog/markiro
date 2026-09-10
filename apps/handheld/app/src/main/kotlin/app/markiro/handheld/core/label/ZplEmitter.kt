package app.markiro.handheld.core.label

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

private const val HEX_INDICATOR = "_"

/**
 * Port of `generateZpl` in packages/domain/src/labels/zpl.ts.
 *
 * Elements are rendered strictly in order, one after another rather than concurrently, so the
 * document order does not depend on how fast an individual rasterization finishes.
 *
 * Several branches deliberately emit nothing, and each one is what keeps output byte-identical to
 * the original for templates written before the feature existed: no hex-escape prefix when no
 * control character occurs, no bar-width command when the template sets no module width, and a
 * field block only when the element carries a box.
 */
suspend fun generateZpl(
    spec: LabelSpec,
    data: Map<LabelField, String>,
    rasterize: RasterizeText?,
): String {
    val lines = ArrayList<String>()
    lines += "^XA"
    lines += "^PW${mmToDots(spec.widthMm, spec.dpi)}"
    lines += "^LL${mmToDots(spec.heightMm, spec.dpi)}"
    for (element in spec.elements) {
        lines += when (element) {
            is LabelElement.Text -> textLike(
                spec, element.xMm, element.yMm, element.text, element.fontSizePt, element.bold,
                element.align, element.maxWidthMm, element.maxLines, rasterize,
            )
            is LabelElement.Field -> textLike(
                spec, element.xMm, element.yMm,
                labelFieldDisplayValue(element.field, data, element.textFormat),
                element.fontSizePt, element.bold, element.align, element.maxWidthMm, element.maxLines, rasterize,
            )
            is LabelElement.Barcode -> barcode(spec, element, data)
            is LabelElement.Line -> line(spec, element)
            is LabelElement.Box -> box(spec, element)
        }
    }
    lines += "^XZ"
    return lines.joinToString("\n") + "\n"
}

/** `^`, `~` and `_` are ZPL's own control characters and must be sent as hex escapes. */
private fun escapeFieldData(text: String): Pair<String, String> {
    if (text.none { it == '^' || it == '~' || it == '_' }) return "" to text
    val escaped = buildString {
        for (ch in text) {
            if (ch == '^' || ch == '~' || ch == '_') {
                append(HEX_INDICATOR).append(ch.code.toString(16).uppercase().padStart(2, '0'))
            } else {
                append(ch)
            }
        }
    }
    return "^FH$HEX_INDICATOR" to escaped
}

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
): String {
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
        return "^FO${x + offset},$y${buildGfaCommand(raster)}^FS"
    }
    // The scalable font takes the same value for height and width. `bold` has no effect here: font
    // zero carries no weight parameter, so boldness is honoured on the image branch only.
    val height = ptToDots(fontSizePt, spec.dpi)
    val font = "^A0N,$height,$height"
    val (fh, payload) = escapeFieldData(text)
    if (maxWidthDots == null) return "^FO$x,$y$font$fh^FD$payload^FS"
    val justification = when (align) {
        LabelAlign.CENTER -> "C"
        LabelAlign.RIGHT -> "R"
        else -> "L"
    }
    val block = "^FB$maxWidthDots,${maxLines ?: 1},0,$justification,0"
    return "^FO$x,$y$font$block$fh^FD$payload^FS"
}

private fun barcode(spec: LabelSpec, element: LabelElement.Barcode, data: Map<LabelField, String>): String {
    if (element.format != BarcodeFormat.CODE128) {
        throw LabelRenderException("barcode format ${element.format.wire} is not supported on this device")
    }
    val x = mmToDots(element.xMm, spec.dpi)
    val y = mmToDots(element.yMm, spec.dpi)
    val source = element.data
    val value = when (source) {
        is BarcodeSource.Field -> data[source.field] ?: ""
        is BarcodeSource.Literal -> source.value
    }
    // The application identifier is added here and nowhere else: storage and transport carry a bare
    // eighteen-digit code. `>;` selects subset C and `>8` is the printer's own GS1 flag.
    val gs1 = source is BarcodeSource.Field && source.field == LabelField.SSCC
    val payload = if (gs1) ">;>800$value" else value
    // The bar-width command is modal on a real printer and survives into the next label, so it is
    // pinned immediately before its own barcode rather than set once per document.
    val barWidth = element.moduleWidthMm?.let { "^BY${max(1, min(10, mmToDots(it, spec.dpi)))}" } ?: ""
    val (fh, escaped) = escapeFieldData(payload)
    // The interpretation line is off on purpose, matching the other language, so one template does
    // not print differently depending on the printer brand.
    return "^FO$x,$y$barWidth^BCN,${mmToDots(element.sizeMm, spec.dpi)},N,N,N$fh^FD$escaped^FS"
}

private fun line(spec: LabelSpec, element: LabelElement.Line): String {
    val thickness = mmToDots(element.thicknessMm, spec.dpi)
    // The span rounds the difference in millimetres. Subtracting two already-rounded dot values can
    // differ by one dot, so do not simplify this.
    val spanX = mmToDots(abs(element.x2Mm - element.xMm), spec.dpi)
    val spanY = mmToDots(abs(element.y2Mm - element.yMm), spec.dpi)
    val originX = mmToDots(min(element.xMm, element.x2Mm), spec.dpi)
    val originY = mmToDots(min(element.yMm, element.y2Mm), spec.dpi)
    // A line drawn right to left still anchors at its leftmost end, and each axis is clamped up to
    // the thickness so a horizontal line never becomes a zero-height box.
    return "^FO$originX,$originY^GB${max(spanX, thickness)},${max(spanY, thickness)},$thickness^FS"
}

private fun box(spec: LabelSpec, element: LabelElement.Box): String {
    val x = mmToDots(element.xMm, spec.dpi)
    val y = mmToDots(element.yMm, spec.dpi)
    val width = mmToDots(element.widthMm, spec.dpi)
    val height = mmToDots(element.heightMm, spec.dpi)
    val thickness = mmToDots(element.thicknessMm, spec.dpi)
    return "^FO$x,$y^GB$width,$height,$thickness^FS"
}
