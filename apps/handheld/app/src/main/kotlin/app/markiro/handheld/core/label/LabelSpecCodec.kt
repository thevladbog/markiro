package app.markiro.handheld.core.label

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject

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
        elements = (o["elements"] as? JsonArray ?: throw LabelRenderException("label spec has no elements"))
            .map { element(it.jsonObject) },
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
            textFormat = o.strOrNull("textFormat")?.let(TextFormat::fromWire),
            fontSizePt = o.num("fontSizePt"), bold = o.boolOrNull("bold"),
            align = o.strOrNull("align")?.let(LabelAlign::fromWire),
            maxWidthMm = o.numOrNull("maxWidthMm"), maxLines = o.intOrNull("maxLines"),
        )
        "barcode" -> LabelElement.Barcode(
            id = o.str("id"), xMm = o.num("xMm"), yMm = o.num("yMm"),
            format = BarcodeFormat.fromWire(o.str("format")),
            data = when (val source = o["data"]) {
                is JsonObject -> BarcodeSource.Literal(source.str("literal"))
                is JsonNull, null -> throw LabelRenderException("label spec is missing barcode data")
                is JsonPrimitive -> BarcodeSource.Field(LabelField.fromWire(source.content))
                else -> throw LabelRenderException("label spec barcode data is neither a field nor a literal")
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

    /**
     * A required value, refused by name when it is missing or is not a value at all. Nothing here
     * falls back to zero: a geometry field that quietly became `0.0` puts the element in the corner
     * of a real label instead of saying the template is wrong.
     */
    private fun JsonObject.required(key: String): JsonPrimitive {
        // An explicit null and an absent key say the same thing to a template that needs the value.
        val value = get(key)
        if (value == null || value is JsonNull) throw LabelRenderException("label spec is missing $key")
        return value as? JsonPrimitive ?: throw LabelRenderException("label spec $key is not a value")
    }

    private fun JsonObject.optional(key: String): JsonPrimitive? {
        val value = get(key)?.takeIf { it !is JsonNull } ?: return null
        return value as? JsonPrimitive ?: throw LabelRenderException("label spec $key is not a value")
    }

    private fun JsonPrimitive.number(key: String) =
        doubleOrNull ?: throw LabelRenderException("label spec $key is not a number")

    private fun JsonPrimitive.whole(key: String) =
        intOrNull ?: throw LabelRenderException("label spec $key is not a whole number")

    private fun JsonObject.str(key: String) = required(key).content
    private fun JsonObject.strOrNull(key: String) = optional(key)?.content
    private fun JsonObject.num(key: String) = required(key).number(key)
    private fun JsonObject.numOrNull(key: String) = optional(key)?.number(key)
    private fun JsonObject.int(key: String) = required(key).whole(key)
    private fun JsonObject.intOrNull(key: String) = optional(key)?.whole(key)
    private fun JsonObject.boolOrNull(key: String) =
        optional(key)?.let { it.booleanOrNull ?: throw LabelRenderException("label spec $key is not a boolean") }
}
