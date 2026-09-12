package app.markiro.handheld.core.exceptions

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The server validates each fact with a `superRefine` that rejects the WHOLE
 * batch on a wrong shape, and a rejected batch is retried forever. These
 * assertions are what stands between a typo and a permanently wedged device.
 */
class ExceptionFactsTest {
    private val keys = listOf(
        "kind", "boxId", "codeHash", "targetScannedAt",
        "shiftId", "terminalId", "operatorId", "reason", "occurredAt",
    )

    private val undo = ExceptionFact.Undo(
        boxId = "box-1", shiftId = "11111111-1111-4111-8111-111111111111",
        terminalId = "dev-1", operatorId = "22222222-2222-4222-8222-222222222222",
        occurredAt = "2026-09-11T08:00:00.000Z",
        codeHash = "a".repeat(64), targetScannedAt = "2026-09-11T07:59:00.000Z",
    )
    private val clear = ExceptionFact.Clear(
        boxId = "box-1", shiftId = undo.shiftId, terminalId = "dev-1",
        operatorId = undo.operatorId, occurredAt = undo.occurredAt,
    )
    private val disassemble = ExceptionFact.Disassemble(
        boxId = "box-1", shiftId = undo.shiftId, terminalId = "dev-1",
        operatorId = undo.operatorId, occurredAt = undo.occurredAt,
        reason = DisassembleReason.WRONG_PRODUCT.audit,
    )
    private val reprint = ExceptionFact.Reprint(
        boxId = "box-1", shiftId = undo.shiftId, terminalId = "dev-1",
        operatorId = undo.operatorId, occurredAt = undo.occurredAt,
        reason = ReprintReason.DAMAGED_LABEL.audit,
    )

    /** Every key is always present: the server's nullable fields have no default. */
    @Test
    fun everyKindCarriesEveryKey() {
        for (fact in listOf(undo, clear, disassemble, reprint)) {
            assertEquals(fact.kind, keys, fact.toWireJson().keys.toList())
        }
    }

    @Test
    fun undoCarriesTheCodeAndNoReason() {
        val json = undo.toWireJson()
        assertEquals("undo", json["kind"]!!.jsonPrimitive.content)
        assertEquals("a".repeat(64), json["codeHash"]!!.jsonPrimitive.content)
        assertEquals("2026-09-11T07:59:00.000Z", json["targetScannedAt"]!!.jsonPrimitive.content)
        assertEquals(JsonNull, json["reason"])
    }

    @Test
    fun clearCarriesNeitherCodeNorReason() {
        val json = clear.toWireJson()
        assertEquals("clear", json["kind"]!!.jsonPrimitive.content)
        assertEquals(JsonNull, json["codeHash"])
        assertEquals(JsonNull, json["targetScannedAt"])
        assertEquals(JsonNull, json["reason"])
    }

    @Test
    fun disassembleAndReprintCarryAReasonAndNoCode() {
        for (fact in listOf(disassemble, reprint)) {
            val json = fact.toWireJson()
            assertEquals(JsonNull, json["codeHash"])
            assertEquals(JsonNull, json["targetScannedAt"])
            assertEquals(fact.kind, false, json["reason"] == JsonNull)
        }
        assertEquals("Неверный товар", disassemble.toWireJson()["reason"]!!.jsonPrimitive.content)
        assertEquals("Этикетка повреждена", reprint.toWireJson()["reason"]!!.jsonPrimitive.content)
    }

    /** A null operator is a null, not a missing key. */
    @Test
    fun anAbsentOperatorIsStillSpelledOut() {
        val json = clear.copy(operatorId = null, terminalId = null).toWireJson()
        assertEquals(JsonNull, json["operatorId"])
        assertEquals(JsonNull, json["terminalId"])
    }

    // -- The pallet channel (06d). Its schema is `palletExceptionSchema` in
    // `apps/api/src/modules/station-scans/dto.ts`: a different key set from the
    // box one, and `reason` is REQUIRED for both of its kinds. --

    private val palletKeys = listOf("kind", "palletId", "shiftId", "terminalId", "operatorId", "reason", "occurredAt")

    private val palletReprint = PalletExceptionFact(
        kind = PalletExceptionKind.REPRINT, palletId = "pallet-1", shiftId = undo.shiftId,
        terminalId = "dev-1", operatorId = undo.operatorId,
        reason = ReprintReason.PRINT_OUTCOME_UNKNOWN.audit, occurredAt = undo.occurredAt,
    )

    @Test
    fun everyPalletKindCarriesEveryKeyTheServerDeclares() {
        for (kind in PalletExceptionKind.entries) {
            val json = palletReprint.copy(kind = kind).toWireJson()
            assertEquals(kind.wire, palletKeys, json.keys.toList())
            // A box fact's keys would fail the pallet schema outright.
            assertEquals(kind.wire, json["kind"]!!.jsonPrimitive.content)
        }
    }

    /**
     * `terminalId` and `operatorId` are `.nullable()` with no `.default()`, so
     * a dropped key is a 400 for the WHOLE batch, retried forever.
     */
    @Test
    fun anAbsentPalletOperatorIsStillSpelledOut() {
        val json = palletReprint.copy(operatorId = null, terminalId = null).toWireJson()
        assertEquals(palletKeys, json.keys.toList())
        assertEquals(JsonNull, json["operatorId"])
        assertEquals(JsonNull, json["terminalId"])
    }

    /** `reason` is `z.string().min(1)` for both pallet kinds -- never null, never empty. */
    @Test
    fun aPalletFactAlwaysCarriesANonEmptyReason() {
        for (kind in PalletExceptionKind.entries) {
            val reason = palletReprint.copy(kind = kind).toWireJson()["reason"]
            assertEquals(kind.wire, false, reason == JsonNull)
            assertTrue(kind.wire, reason!!.jsonPrimitive.content.isNotEmpty())
        }
        assertEquals("Результат печати неизвестен", palletReprint.toWireJson()["reason"]!!.jsonPrimitive.content)
    }

    /** The audit wording must match the station's, or one ledger reads two ways. */
    @Test
    fun theAuditWordingIsTheStationsVerbatim() {
        assertEquals(
            listOf("Неверный товар", "Неверное количество", "Упаковка повреждена", "Отклонено контролем качества"),
            DisassembleReason.entries.map { it.audit },
        )
        assertEquals(
            listOf("Этикетка повреждена", "Этикетка не читается", "Замятие принтера / нет печати", "Запрос контроля качества"),
            ReprintReason.entries.filter { it != ReprintReason.PRINT_OUTCOME_UNKNOWN }.map { it.audit },
        )
    }
}
