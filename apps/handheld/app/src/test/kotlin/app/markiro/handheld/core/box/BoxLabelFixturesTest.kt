package app.markiro.handheld.core.box

import app.markiro.handheld.core.label.LabelField
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId

/**
 * Pins SSCC construction and the box label's dates to `packages/domain`.
 *
 * Unlike the label emitters, none of this is allowed to differ: a check digit
 * that disagrees is a number the receiver will reject, and an expiry a day out
 * is a claim about food that the rest of the platform contradicts.
 *
 * Every case records the zone it was generated in, because one of them
 * deliberately exercises the local-date path across a day boundary.
 */
class BoxLabelFixturesTest {
    private val fixtures: JsonObject = Json.parseToJsonElement(
        checkNotNull(javaClass.classLoader?.getResource("box-label-fixtures.json")) {
            "run pnpm --filter @markiro/domain fixtures:box-labels"
        }.readText(),
    ).jsonObject

    /** A JSON null reads as a Kotlin null, never as the string "null". */
    private fun JsonObject.textOrNull(key: String): String? =
        getValue(key).takeIf { it !is JsonNull }?.jsonPrimitive?.content

    @Test
    fun everySsccCaseAgreesWithTheDomain() {
        val cases = fixtures.getValue("sscc").jsonArray
        assertTrue("fixtures are empty", cases.isNotEmpty())
        for (element in cases) {
            val case = element.jsonObject
            val digit = case.getValue("extensionDigit").jsonPrimitive.content.toInt()
            val prefix = case.getValue("gs1Prefix").jsonPrimitive.content
            val serial = case.getValue("serial").jsonPrimitive.content.toLong()
            val label = "$digit/$prefix/$serial"
            val expected = case.textOrNull("sscc")
            if (expected != null) {
                assertEquals(label, expected, Sscc.build(digit, prefix, serial))
            } else {
                val thrown = runCatching { Sscc.build(digit, prefix, serial) }.exceptionOrNull()
                assertTrue("$label: expected a refusal, got a number", thrown is SsccException)
                assertEquals(label, case.getValue("error").jsonPrimitive.content, (thrown as SsccException).code)
            }
        }
    }

    @Test
    fun everyFieldCaseAgreesWithTheDomain() {
        val cases = fixtures.getValue("fields").jsonArray
        assertTrue("fixtures are empty", cases.isNotEmpty())
        for (element in cases) {
            val case = element.jsonObject
            val name = case.getValue("name").jsonPrimitive.content
            // Per case: one of them exercises the local-date fallback in a zone
            // where the instant has already rolled over into the next day.
            val zone = ZoneId.of(case.getValue("timeZone").jsonPrimitive.content)
            val input = case.getValue("input").jsonObject
            val actual = boxLabelFields(
                BoxLabelInput(
                    sscc = input.getValue("sscc").jsonPrimitive.content,
                    itemCount = input.getValue("itemCount").jsonPrimitive.content.toInt(),
                    productName = input.getValue("productName").jsonPrimitive.content,
                    productPrintName = input.textOrNull("productPrintName"),
                    gtin14 = input.getValue("gtin14").jsonPrimitive.content,
                    egaisCode = input.textOrNull("egaisCode"),
                    shelfLifeDays = input.getValue("shelfLifeDays").takeIf { it !is JsonNull }
                        ?.jsonPrimitive?.intOrNull,
                    operatorName = input.textOrNull("operatorName"),
                    counterpartyName = input.textOrNull("counterpartyName"),
                    closedAt = input.getValue("closedAt").jsonPrimitive.content,
                    productionDate = input.textOrNull("productionDate"),
                    shiftNumber = input.textOrNull("shiftNumber"),
                ),
                zone,
            )
            val expected = case.getValue("fields").jsonObject
            assertEquals("$name: field count", expected.size, actual.size)
            for ((wire, value) in expected) {
                assertEquals("$name / $wire", value.jsonPrimitive.content, actual[LabelField.fromWire(wire)])
            }
        }
    }
}
