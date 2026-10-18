package app.markiro.handheld.core.host

import app.markiro.handheld.core.box.BoxDigest
import app.markiro.handheld.core.box.Sscc
import app.markiro.handheld.core.km.KmCodec
import app.markiro.handheld.core.km.ScanRawKind
import app.markiro.handheld.core.storage.BoxEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.HostOutboxEntity
import app.markiro.handheld.core.storage.OutboxEntity
import app.markiro.handheld.core.storage.PalletEntity
import app.markiro.handheld.core.storage.ShiftCloseEntity
import app.markiro.handheld.core.util.Iso
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.UUID

/**
 * Turns what this device owes the host into records of `host_outbox`, once: the body of a record is built here and never again (a retry
 * after a broken connection sends these very bytes under this very id, or the host answers `payload_mismatch`). A source row (a scan,
 * a closed box, a closed pallet of a shift, a shift's close) names itself in `sourceKind` + `sourceKey`, and the unique index makes a
 * second pass over the same row make nothing.
 *
 * Records of one pass are ordered by the device's time, and at the same instant by kind (a scan before the box it fills, a box before its
 * pallet, the pallet before the shift's close): the host applies a batch in its order, and a box it has not met is `box_unknown`.
 * A source that cannot be written as the host reads it (a time that is not an instant of this device, an SSCC of no block it holds) is
 * kept as a quarantined record with the reason, so the person at support sees it and the rest of the queue goes on.
 */
class HostRecordFreezer(
    private val db: HandheldDatabase,
    private val clock: () -> String = { Iso.format(System.currentTimeMillis()) },
    private val newId: () -> String = { UUID.randomUUID().toString() },
) {
    private class Draft(val deviceAt: String?, val row: HostOutboxEntity)

    suspend fun freezeAll(): Int = db.recovery.commit { freezeOwned() }

    private suspend fun freezeOwned(): Int {
        val dao = db.hostOutboxDao()
        val drafts = buildList {
            // The order of these four lines is the order of kinds at one instant: `sortedWith` is stable.
            dao.unfrozenScans().forEach { add(scan(it)) }
            dao.unfrozenBoxes().forEach { add(box(it)) }
            dao.unfrozenPallets().forEach { add(pallet(it)) }
            dao.unfrozenCloses().forEach { add(close(it)) }
        }
        // A time that is not an instant sorts last: its record is quarantined, nothing waits for it.
        val ordered = drafts.sortedBy { it.deviceAt ?: "~" }
        var made = 0
        for (draft in ordered) if (dao.insert(draft.row) > 0) made++
        return made
    }

    private fun quarantined(id: String, kind: String, sourceKind: String, sourceKey: String, reason: String) =
        Draft(null, HostOutboxEntity(recordId = id, target = "facts", kind = kind, sourceKind = sourceKind, sourceKey = sourceKey, body = "{}", state = "quarantined", reason = reason, createdAt = clock()))

    private fun queued(id: String, kind: String, sourceKind: String, sourceKey: String, deviceAt: String, body: JsonObject) =
        Draft(deviceAt, HostOutboxEntity(recordId = id, target = "facts", kind = kind, sourceKind = sourceKind, sourceKey = sourceKey, body = body.toString(), state = "queued", reason = null, createdAt = clock()))

    private fun record(id: String, kind: String, shiftId: String, operatorId: String?, data: JsonObject) = buildJsonObject {
        put("id", id)
        put("kind", kind)
        put("shiftId", shiftId)
        if (operatorId == null) put("operatorId", JsonNull) else put("operatorId", operatorId)
        put("data", data)
    }

    private fun nullable(value: String?) = if (value == null) JsonNull else JsonPrimitive(value)

    private fun scan(row: OutboxEntity): Draft {
        val id = newId()
        val key = row.id.toString()
        fun bad(reason: String) = quarantined(id, "scan", "scan", key, reason)
        if (!Iso.isDeviceInstant(row.scannedAt)) return bad(BAD_DEVICE_TIME)
        if (row.verdict !in SCAN_VERDICTS) return bad("bad_verdict")
        val rawKind = ScanRawKind.classify(row.raw)
        // The host reads `invalid` as "no code of marking" and anything else as one: a scan that says otherwise is a defect, not a record.
        if ((row.verdict == "invalid") == (rawKind == "km")) return bad("bad_scan")
        val code = if (row.verdict == "invalid") null else runCatching { KmCodec.canonicalize(row.raw) }.getOrNull() ?: return bad("bad_scan")
        val data = buildJsonObject {
            put("scannedAt", row.scannedAt)
            put("verdict", row.verdict)
            put("duplicateSource", if (row.verdict == "duplicate") JsonPrimitive("local") else JsonNull)
            put("rawKind", rawKind)
            put("rawLength", row.raw.length)
            if (code == null) put("code", JsonNull) else put(
                "code",
                buildJsonObject {
                    put("codeHash", KmCodec.hash(code))
                    put("gtin14", code.gtin14)
                    put("serial", code.serial)
                    put("canonical", code.canonicalRaw)
                },
            )
            put("boxId", nullable(if (row.verdict == "ok") row.boxId else null))
        }
        return queued(id, "scan", "scan", key, row.scannedAt, record(id, "scan", row.shiftId, row.operatorId, data))
    }

    private suspend fun issued(shiftId: String, sscc: String, extension: Int): Triple<Long, String, String>? {
        val prefix = db.shiftDao().get(shiftId)?.ssccIssuerPrefix ?: return null
        val serial = Sscc.serialOf(sscc, prefix) ?: return null
        val blockId = db.ssccPoolDao().rangeOf(prefix, extension, serial)?.blockId ?: return null
        return Triple(serial, blockId, prefix)
    }

    private suspend fun box(row: BoxEntity): Draft {
        val id = newId()
        fun bad(reason: String) = quarantined(id, "box_closed", "box", row.boxId, reason)
        val sscc = row.sscc ?: return bad("bad_sscc")
        val closedAt = row.closedAt ?: return bad(BAD_DEVICE_TIME)
        if (!Iso.isDeviceInstant(row.openedAt) || !Iso.isDeviceInstant(closedAt)) return bad(BAD_DEVICE_TIME)
        val (serial, blockId, _) = issued(row.shiftId, sscc, 0) ?: return bad("block_unknown")
        val hashes = db.hostOutboxDao().codeHashesIn(row.boxId)
        val data = buildJsonObject {
            put("boxId", row.boxId)
            put("sscc", sscc)
            put("blockId", blockId)
            put("serial", serial)
            put("openedAt", row.openedAt)
            put("closedAt", closedAt)
            put("itemCount", hashes.size)
            put("membershipDigest", BoxDigest.of(hashes))
            if (row.palletId != null) put("palletId", row.palletId)
        }
        return queued(id, "box_closed", "box", row.boxId, closedAt, record(id, "box_closed", row.shiftId, row.operatorId, data))
    }

    private suspend fun pallet(row: PalletEntity): Draft {
        val id = newId()
        fun bad(reason: String) = quarantined(id, "pallet_closed", "pallet", row.palletId, reason)
        val shiftId = row.shiftId ?: return bad("bad_pallet")
        val sscc = row.sscc ?: return bad("bad_sscc")
        val closedAt = row.closedAt ?: return bad(BAD_DEVICE_TIME)
        if (!Iso.isDeviceInstant(row.openedAt) || !Iso.isDeviceInstant(closedAt)) return bad(BAD_DEVICE_TIME)
        val (serial, blockId, _) = issued(shiftId, sscc, 1) ?: return bad("block_unknown")
        val data = buildJsonObject {
            put("palletId", row.palletId)
            put("sscc", sscc)
            put("blockId", blockId)
            put("serial", serial)
            put("openedAt", row.openedAt)
            put("closedAt", closedAt)
            put("boxCount", db.palletDao().boxCount(row.palletId))
        }
        return queued(id, "pallet_closed", "pallet", row.palletId, closedAt, record(id, "pallet_closed", shiftId, row.operatorId, data))
    }

    private fun close(row: ShiftCloseEntity): Draft {
        // The close already has a UUID of its own, the one the shift keeps: the record is known by it on both sides.
        val id = row.eventId
        if (!Iso.isDeviceInstant(row.closedAt)) return quarantined(id, "shift_closed", "shift_close", row.eventId, BAD_DEVICE_TIME)
        val data = buildJsonObject {
            put("plannedQtySnapshot", row.plannedQtySnapshot?.let { JsonPrimitive(it) } ?: JsonNull)
            put("actualQty", row.actualQty)
            put("closedBoxCount", row.closedBoxCount)
            put("reasonCode", nullable(row.reasonCode))
            put("closedAt", row.closedAt)
        }
        return queued(id, "shift_closed", "shift_close", row.eventId, row.closedAt, record(id, "shift_closed", row.shiftId, row.operatorId, data))
    }

    private companion object {
        const val BAD_DEVICE_TIME = "bad_device_time"
        val SCAN_VERDICTS = setOf("ok", "duplicate", "wrong_gtin", "invalid")
    }
}
