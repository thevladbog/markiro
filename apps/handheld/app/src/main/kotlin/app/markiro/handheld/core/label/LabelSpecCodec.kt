package app.markiro.handheld.core.label

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Reads a label template spec from the JSON the cabinet stores. Consumed by the fixture test now;
 * the aggregation slice feeds it the shift bundle's box template.
 */
object LabelSpecCodec {
    fun parse(json: String): LabelSpec = spec(Json.parseToJsonElement(json).jsonObject)

    fun spec(o: JsonObject): LabelSpec = LabelSpec(
        widthMm = o.num("widthMm"),
        heightMm = o.num("heightMm"),
        dpi = o.int("dpi"),
        language = PrinterLanguage.fromWire(o.str("language")),
        elements = o.getValue("elements").jsonArray.map { element(it.jsonObject) },
    )

    private fun element(o: JsonObject): LabelElement = when (val kind = o.str("kind")) {
        "text" -> LabelElement.Text(
            id = o.str("id"), xMm = o.num("xMm"), yMm = o.num("yMm"), text = o.str("text"),
            fontSizePt = o.num("fontSizePt"), bold = o.boolOrNull("bold"),
            align = o.strOrNull("align")?.let(LabelAlign::fromWire),
            maxWidthMm = o.numOrNull("maxWidthMm"), maxLines = o.intOrNull("maxLines"),
        )
        "field" -> LabelElement.Field(
            id = o.str("id"), xMm = o.num("xMm"), yMm = o.num("yMm"),
            field = LabelField.fromWire(o.str("field")),
            textFormat = o.strOrNull("textFormat")?.let { TextFormat.KM_WITHOUT_CRYPTO },
            fontSizePt = o.num("fontSizePt"), bold = o.boolOrNull("bold"),
            align = o.strOrNull("align")?.let(LabelAlign::fromWire),
            maxWidthMm = o.numOrNull("maxWidthMm"), maxLines = o.intOrNull("maxLines"),
        )
        "barcode" -> LabelElement.Barcode(
            id = o.str("id"), xMm = o.num("xMm"), yMm = o.num("yMm"),
            format = BarcodeFormat.fromWire(o.str("format")),
            data = o.getValue("data").let { element ->
                if (element is JsonObject) BarcodeSource.Literal(element.str("literal"))
                else BarcodeSource.Field(LabelField.fromWire(element.jsonPrimitive.content))
            },
            sizeMm = o.num("sizeMm"), moduleWidthMm = o.numOrNull("moduleWidthMm"),
        )
        "line" -> LabelElement.Line(
            id = o.str("id"), xMm = o.num("xMm"), yMm = o.num("yMm"),
            x2Mm = o.num("x2Mm"), y2Mm = o.num("y2Mm"), thicknessMm = o.num("thicknessMm"),
        )
        "box" -> LabelElement.Box(
            id = o.str("id"), xMm = o.num("xMm"), yMm = o.num("yMm"),
            widthMm = o.num("widthMm"), heightMm = o.num("heightMm"), thicknessMm = o.num("thicknessMm"),
        )
        else -> throw LabelRenderException("unknown label element kind: $kind")
    }

    private fun JsonObject.str(key: String) = getValue(key).jsonPrimitive.content
    private fun JsonObject.strOrNull(key: String) = get(key)?.takeIf { it !is JsonNull }?.jsonPrimitive?.content
    private fun JsonObject.num(key: String) = getValue(key).jsonPrimitive.doubleOrNull ?: 0.0
    private fun JsonObject.numOrNull(key: String) = get(key)?.takeIf { it !is JsonNull }?.jsonPrimitive?.doubleOrNull
    private fun JsonObject.int(key: String) = getValue(key).jsonPrimitive.intOrNull ?: 0
    private fun JsonObject.intOrNull(key: String) = get(key)?.takeIf { it !is JsonNull }?.jsonPrimitive?.intOrNull
    private fun JsonObject.boolOrNull(key: String) = get(key)?.takeIf { it !is JsonNull }?.jsonPrimitive?.booleanOrNull
}
