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
 * Pins `palletLabelFields` to `packages/domain/src/labels/pallet-label.ts`.
 *
 * This consumes the SAME generated fixture `BoxLabelFixturesTest` does --
 * `box-label-fixtures.json`'s `palletFields` section, produced by
 * `packages/domain/src/labels/box-label-fixtures.ts` (regenerate with
 * `pnpm --filter @markiro/domain fixtures:box-labels`) -- rather than a
 * fixture of its own, because the box label already has a tracked generator
 * and a pallet's date arithmetic is the identical shared rule under a
 * different field builder, not a second one to pin independently.
 */
class PalletLabelFieldsTest {
    private val palletFields = Json.parseToJsonElement(
        checkNotNull(javaClass.classLoader?.getResource("box-label-fixtures.json")) {
            "run pnpm --filter @markiro/domain fixtures:box-labels"
        }.readText(),
    ).jsonObject.getValue("palletFields").jsonArray

    /** A JSON null reads as a Kotlin null, never as the string "null". */
    private fun JsonObject.textOrNull(key: String): String? =
        getValue(key).takeIf { it !is JsonNull }?.jsonPrimitive?.content

    @Test
    fun everyPalletFieldCaseAgreesWithTheDomain() {
        assertTrue("fixtures are empty", palletFields.isNotEmpty())
        for (element in palletFields) {
            val case = element.jsonObject
            val name = case.getValue("name").jsonPrimitive.content
            // Per case: one of them exercises the local-date fallback in a zone
            // where the instant has already rolled over into the next day.
            val zone = ZoneId.of(case.getValue("timeZone").jsonPrimitive.content)
            val input = case.getValue("input").jsonObject
            val actual = palletLabelFields(
                PalletLabelInput(
                    sscc = input.getValue("sscc").jsonPrimitive.content,
                    boxCount = input.getValue("boxCount").jsonPrimitive.content.toInt(),
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

    @Test
    fun printsUnitsInQtyAndBoxesInQtyBoxes() {
        val fields = palletLabelFields(
            input().copy(boxCount = 12, itemCount = 240),
        )
        assertEquals("240", fields[LabelField.QTY])
        assertEquals("12", fields[LabelField.QTY_BOXES])
    }

    @Test
    fun countsTheProductionDayAsDayOne() {
        // 2026-09-11 + 30 days, last usable day inclusive => 10.10.2026.
        val fields = palletLabelFields(
            input().copy(closedAt = "2026-09-11T07:00:00.000Z", productionDate = "2026-09-11", shelfLifeDays = 30),
        )
        assertEquals("10.10.2026", fields[LabelField.EXPIRY])
    }

    /** A minimal, valid base input for the two literal assertions above. */
    private fun input() = PalletLabelInput(
        sscc = "103460068200000004",
        boxCount = 1,
        itemCount = 1,
        productName = "Вода питьевая 0,5 л",
        productPrintName = "Вода 0,5",
        gtin14 = "04680089900000",
        egaisCode = null,
        shelfLifeDays = null,
        operatorName = "Иванов И.",
        counterpartyName = null,
        closedAt = "2026-09-11T07:00:00.000Z",
        productionDate = "2026-09-11",
        shiftNumber = "SEP26-003",
    )
}
