package app.markiro.handheld.feature.printer

import android.graphics.Paint
import android.graphics.Typeface
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.unit.dp
import app.markiro.handheld.core.label.BarcodeSource
import app.markiro.handheld.core.label.LabelElement
import app.markiro.handheld.core.label.LabelField
import app.markiro.handheld.core.label.LabelSpec
import app.markiro.handheld.core.label.labelFieldDisplayValue
import app.markiro.handheld.core.label.ptToMm

/**
 * A picture of what was sent. Text is drawn with the same font engine that rasterizes it for the
 * printer, and the geometry is to scale, which is the part that can actually go wrong.
 *
 * The barcode is a placeholder block of the right width rather than real bars. No barcode is encoded
 * on this device: both emitters hand the payload to a native printer command, so drawn bars would
 * claim a fidelity this preview does not have. The caption beside it says so.
 */
@Composable
fun LabelPreview(spec: LabelSpec, data: Map<LabelField, String>, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().height(120.dp).background(Color.White).padding(4.dp)) {
        Canvas(Modifier.fillMaxSize()) {
            val scale = size.width / spec.widthMm.toFloat()
            fun mm(value: Double) = value.toFloat() * scale
            val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = android.graphics.Color.BLACK }

            fun drawText(content: String, xMm: Double, yMm: Double, fontSizePt: Double, bold: Boolean) {
                val size = mm(ptToMm(fontSizePt))
                paint.textSize = size
                paint.typeface = Typeface.create(Typeface.SANS_SERIF, if (bold) Typeface.BOLD else Typeface.NORMAL)
                drawContext.canvas.nativeCanvas.drawText(content, mm(xMm), mm(yMm) + size, paint)
            }

            for (element in spec.elements) {
                when (element) {
                    is LabelElement.Box -> drawRect(
                        Color.Black,
                        topLeft = Offset(mm(element.xMm), mm(element.yMm)),
                        size = Size(mm(element.widthMm), mm(element.heightMm)),
                        style = Stroke(width = mm(element.thicknessMm).coerceAtLeast(1f)),
                    )
                    is LabelElement.Line -> drawLine(
                        Color.Black,
                        Offset(mm(element.xMm), mm(element.yMm)),
                        Offset(mm(element.x2Mm), mm(element.y2Mm)),
                        strokeWidth = mm(element.thicknessMm).coerceAtLeast(1f),
                    )
                    is LabelElement.Barcode -> {
                        val value = when (val source = element.data) {
                            is BarcodeSource.Field -> data[source.field] ?: ""
                            is BarcodeSource.Literal -> source.value
                        }
                        // Width from the module arithmetic the domain package documents: a fixed
                        // frame, the GS1 flag, and one symbol per digit pair.
                        val modules = FRAME_MODULES + FLAG_MODULES + SYMBOL_MODULES * ((value.length + 2 + 1) / 2)
                        drawRect(
                            Color(0xFFBBBBBB),
                            topLeft = Offset(mm(element.xMm), mm(element.yMm)),
                            size = Size(mm((element.moduleWidthMm ?: 0.25) * modules), mm(element.sizeMm)),
                        )
                    }
                    is LabelElement.Text ->
                        drawText(element.text, element.xMm, element.yMm, element.fontSizePt, element.bold == true)
                    is LabelElement.Field -> drawText(
                        labelFieldDisplayValue(element.field, data, element.textFormat),
                        element.xMm,
                        element.yMm,
                        element.fontSizePt,
                        element.bold == true,
                    )
                }
            }
        }
    }
}

private const val FRAME_MODULES = 35
private const val FLAG_MODULES = 11
private const val SYMBOL_MODULES = 11
