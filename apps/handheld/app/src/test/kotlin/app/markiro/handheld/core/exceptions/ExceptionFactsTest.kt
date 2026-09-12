package app.markiro.handheld.core.exceptions

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
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
