package app.markiro.handheld.core.host

import app.markiro.handheld.core.box.ServerRange
import app.markiro.handheld.core.box.Sscc
import app.markiro.handheld.core.box.SsccPool
import app.markiro.handheld.core.storage.BoxEntity
import app.markiro.handheld.core.storage.CodeEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.OutboxEntity
import app.markiro.handheld.core.storage.PalletEntity
import app.markiro.handheld.core.storage.ShiftCloseEntity
import app.markiro.handheld.core.storage.ShiftEntity
import app.markiro.handheld.core.storage.syntheticDeviceConfig
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** Rows and fixtures of the facts channel: real shapes of the device's tables and the records of `facts-request*.json`. */
object HostFactsFixtures {
    const val PREFIX = "460068200"
    const val SHIFT = "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b"
    const val OPERATOR = "c4a1e2b3-5d6f-4a7b-8c9d-0e1f2a3b4c5d"
    const val BOX_BLOCK = "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a"
    const val PALLET_BLOCK = "6e5d4c3b-2a1f-4e0d-9c8b-7a6f5e4d3c2b"
    const val GS = "\u001d"
    const val KM_A = "010460068200001321aaa${GS}93AAAA"
    const val KM_B = "010460068200001321bbb${GS}93BBBB"
    const val KM_C = "010460068200001321ccc${GS}93CCCC"

    fun fixture(name: String): JsonObject = Json.parseToJsonElement(
        checkNotNull(HostFactsFixtures::class.java.classLoader?.getResource(name)) { "$name is not in the test resources" }.readText(),
    ).jsonObject

    fun fixtureRecord(file: String, kind: String): JsonObject =
        fixture(file).getValue("records").jsonArray.map { it.jsonObject }.first { it.getValue("kind").jsonPrimitive.content == kind }

    /** The keys of a JSON value, nested; a value is its type: what the host's `deny_unknown_fields` and its reads depend on. */
    fun shape(element: JsonElement?): Any = when (element) {
        null -> "absent"
        is JsonNull -> "null"
        is JsonObject -> element.toSortedMap().mapValues { shape(it.value) }
        is JsonArray -> element.map { shape(it) }
        else -> if (element.jsonPrimitive.isString) "string" else "number"
    }

    fun config(db: HandheldDatabase, backend: String = "host") = syntheticDeviceConfig().copy(backend = backend)

    fun shift(id: String = SHIFT) = ShiftEntity(
        id = id, number = "OCT26-001", status = "active", mode = "aggregation", productId = "p1",
        productName = "Вода", productPrintName = null, productGtin14 = "04600682000013", lineId = "l1", lineName = "Линия 2",
        counterpartyName = null, plannedQty = 100, plannedDate = "2026-10-08", productionDate = null,
        boxCapacity = 12, palletBoxCapacity = 40, palletsEnabled = true, validationPrintMode = "none",
        closePolicyKind = null, closeOwnerDeviceId = null, openedAt = null, listFetchedAt = 1L, ssccIssuerPrefix = PREFIX,
    )

    suspend fun pool(db: HandheldDatabase) {
        val pool = SsccPool(db)
        pool.addRange(ServerRange(PREFIX, 0, 1500, 3499, null, BOX_BLOCK))
        pool.addRange(ServerRange(PREFIX, 1, 40, 1039, null, PALLET_BLOCK))
    }

    fun scanRow(
        raw: String,
        verdict: String = "ok",
        at: String = "2026-10-08T06:15:02.418Z",
        boxId: String? = null,
        operator: String? = OPERATOR,
        km: Boolean = verdict == "ok",
    ): OutboxEntity {
        val parsed = if (km) app.markiro.handheld.core.km.KmCodec.canonicalize(raw) else null
        return OutboxEntity(
            shiftId = SHIFT, raw = raw, verdict = verdict, scannedAt = at, operatorId = operator,
            codeHash = parsed?.let { app.markiro.handheld.core.km.KmCodec.hash(it) }, gtin14 = parsed?.gtin14, serial = parsed?.serial, boxId = boxId,
        )
    }

    fun closedBox(boxId: String, serial: Long, closedAt: String = "2026-10-08T06:21:47.302Z", palletId: String? = null) = BoxEntity(
        boxId = boxId, shiftId = SHIFT, sscc = Sscc.build(0, PREFIX, serial), openedAt = "2026-10-08T06:15:02.418Z", closedAt = closedAt,
        operatorId = OPERATOR, printState = "pending", printReason = null, ackedAt = null, palletId = palletId,
    )

    fun code(raw: String, boxId: String, at: String = "2026-10-08T06:15:02.418Z"): CodeEntity {
        val km = app.markiro.handheld.core.km.KmCodec.canonicalize(raw)
        return CodeEntity(app.markiro.handheld.core.km.KmCodec.hash(km), SHIFT, km.gtin14, km.serial, at, boxId)
    }

    fun closedPallet(palletId: String, serial: Long, closedAt: String = "2026-10-08T09:02:11.540Z") = PalletEntity(
        palletId = palletId, shiftId = SHIFT, terminalId = null, sscc = Sscc.build(1, PREFIX, serial), openedAt = "2026-10-08T06:21:47.302Z",
        closedAt = closedAt, operatorId = OPERATOR, printState = "pending", printReason = null, ackedAt = null,
    )

    fun shiftClose(eventId: String, closedAt: String = "2026-10-08T14:02:31.775Z") = ShiftCloseEntity(
        eventId = eventId, shiftId = SHIFT, operatorId = OPERATOR, plannedQtySnapshot = 1200, actualQty = 1188, closedBoxCount = 99,
        reasonCode = "material_shortage", closedAt = closedAt, state = "pending", conflictCode = null, lastCheckedAt = null,
    )
}
