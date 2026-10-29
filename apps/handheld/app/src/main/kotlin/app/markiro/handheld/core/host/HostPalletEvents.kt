package app.markiro.handheld.core.host

import app.markiro.handheld.core.box.Sscc
import app.markiro.handheld.core.exceptions.DisassembleReason
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.HostOutboxEntity
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.storage.PalletEntity
import app.markiro.handheld.core.storage.PalletExceptionEntity
import app.markiro.handheld.core.storage.PalletMembershipEntity
import app.markiro.handheld.core.storage.PalletMembershipRemovalEntity
import app.markiro.handheld.core.util.Iso
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.UUID

/**
 * Freezes the device's own warehouse pallets into the records of the pallet-events channel (`POST /v1/device/pallet-events`): the pallet
 * opened, a box put on it, a box taken off, the pallet closed and, for a host of protocol 8, a closed pallet taken apart. A record is built once and never again: a retry sends the same bytes under
 * the same id, and the id is derived from the source (a pallet, a box and the moment it was put there), so a pass that runs twice makes
 * nothing twice.
 *
 * A source leaves `pending` when it is frozen (a membership and a removal become `sent`: a box scanned again after it was taken off is a new
 * source and a new record, never the old one reused). The close of a pallet waits until every box event of that pallet is settled by the
 * host, and then counts the boxes the host kept: the count it checks (`pallet_count_mismatch`) is the one after the host's own refusals.
 * A pallet is opened on the host by its first box, not before: an empty draft is never sent.
 */
class HostPalletEvents(
    private val db: HandheldDatabase,
    private val clock: () -> String = { Iso.format(System.currentTimeMillis()) },
) {
    private class Draft(val at: String?, val rank: Int, val row: HostOutboxEntity)

    suspend fun freeze(): Int = db.recovery.commit { freezeOwned() }

    private suspend fun freezeOwned(): Int {
        val dao = db.hostOutboxDao()
        val pallets = dao.unackedWarehousePallets()
        val drafts = mutableListOf<Draft>()
        for (pallet in pallets) {
            val settledOpen = opened(pallet.palletId) || dao.frozen(OPEN, pallet.palletId) > 0
            val hasBoxes = dao.membershipRows(pallet.palletId) > 0
            if (!settledOpen && (hasBoxes || pallet.closedAt != null)) drafts += open(pallet)
        }
        for (m in db.palletMembershipDao().pending(MAX_PER_PASS)) drafts += added(m)
        for (r in db.palletMembershipRemovalDao().pending(MAX_PER_PASS)) drafts += removed(r)
        if (readsDisassembly()) {
            for (taken in dao.unsentWarehouseDisassemblies()) {
                if (dao.frozen(DISASSEMBLED, taken.id.toString()) == 0) drafts += disassembled(taken)
            }
        }
        for (pallet in pallets) {
            val closedAt = pallet.closedAt ?: continue
            if (pallet.sscc == null || dao.frozen(CLOSED, pallet.palletId) > 0) continue
            if (dao.unsettledMemberships(pallet.palletId) > 0 || dao.unsettledRemovals(pallet.palletId) > 0) continue
            drafts += closed(pallet, closedAt)
        }
        // A time that is not an instant sorts last: its record is quarantined, nothing waits for it.
        val ordered = drafts.sortedWith(compareBy<Draft> { it.at ?: "~" }.thenBy { it.rank })
        var made = 0
        for (draft in ordered) if (dao.insert(draft.row) > 0) made++
        return made
    }

    private suspend fun opened(palletId: String) = db.metaDao().get(openedKey(palletId)) != null

    /** A host before protocol 8 answers the kind `invalid_record` for good: the disassembly waits until the host is updated. */
    private suspend fun readsDisassembly() =
        (db.metaDao().get(MetaStore.HOST_PROTOCOL)?.toIntOrNull() ?: 0) >= DISASSEMBLY_PROTOCOL

    private fun id(kind: String, key: String) = UUID.nameUUIDFromBytes("pallet-event:$kind:$key".toByteArray()).toString()

    private fun record(id: String, kind: String, operatorId: String?, data: JsonObject) = buildJsonObject {
        put("id", id)
        put("kind", kind)
        if (operatorId == null) put("operatorId", JsonNull) else put("operatorId", operatorId)
        put("data", data)
    }

    private fun quarantined(id: String, kind: String, sourceKind: String, key: String, reason: String) =
        Draft(null, 0, HostOutboxEntity(recordId = id, target = "events", kind = kind, sourceKind = sourceKind, sourceKey = key, body = "{}", state = "quarantined", reason = reason, createdAt = clock()))

    private fun queued(id: String, kind: String, sourceKind: String, key: String, at: String, rank: Int, body: JsonObject) =
        Draft(at, rank, HostOutboxEntity(recordId = id, target = "events", kind = kind, sourceKind = sourceKind, sourceKey = key, body = body.toString(), state = "queued", reason = null, createdAt = clock()))

    private fun open(p: PalletEntity): Draft {
        val id = id(OPEN, p.palletId)
        val product = p.productId ?: return quarantined(id, KIND_OPEN, OPEN, p.palletId, "bad_pallet")
        if (!Iso.isDeviceInstant(p.openedAt)) return quarantined(id, KIND_OPEN, OPEN, p.palletId, BAD_DEVICE_TIME)
        val data = buildJsonObject {
            put("palletId", p.palletId)
            put("productId", product)
            put("openedAt", p.openedAt)
        }
        return queued(id, KIND_OPEN, OPEN, p.palletId, p.openedAt, 0, record(id, KIND_OPEN, p.operatorId, data))
    }

    private suspend fun added(m: PalletMembershipEntity): Draft {
        val key = "${m.palletId}:${m.sscc}:${m.addedAt}"
        val id = id(ADDED, key)
        db.palletMembershipDao().markSent(m.palletId, m.sscc)
        if (!Iso.isDeviceInstant(m.addedAt)) return quarantined(id, KIND_ADDED, ADDED, key, BAD_DEVICE_TIME)
        val data = buildJsonObject {
            put("palletId", m.palletId)
            put("boxSscc", m.sscc)
            put("addedAt", m.addedAt)
        }
        return queued(id, KIND_ADDED, ADDED, key, m.addedAt, 1, record(id, KIND_ADDED, m.operatorId, data))
    }

    private suspend fun removed(r: PalletMembershipRemovalEntity): Draft {
        val key = r.id.toString()
        val id = id(REMOVED, key)
        db.palletMembershipRemovalDao().markSent(r.id)
        if (!Iso.isDeviceInstant(r.removedAt)) return quarantined(id, KIND_REMOVED, REMOVED, key, BAD_DEVICE_TIME)
        val data = buildJsonObject {
            put("palletId", r.palletId)
            put("boxSscc", r.sscc)
            put("removedAt", r.removedAt)
        }
        return queued(id, KIND_REMOVED, REMOVED, key, r.removedAt, 2, record(id, KIND_REMOVED, r.operatorId, data))
    }

    private suspend fun closed(p: PalletEntity, closedAt: String): Draft {
        val id = id(CLOSED, p.palletId)
        fun bad(reason: String) = quarantined(id, KIND_CLOSED, CLOSED, p.palletId, reason)
        val sscc = checkNotNull(p.sscc)
        if (!Iso.isDeviceInstant(p.openedAt) || !Iso.isDeviceInstant(closedAt)) return bad(BAD_DEVICE_TIME)
        val range = db.ssccPoolDao().allWithBlockId().firstOrNull { r ->
            r.extensionDigit == 1 && Sscc.serialOf(sscc, r.issuerPrefix)?.let { it in r.fromSerial..r.toSerial } == true
        } ?: return bad("block_unknown")
        val serial = checkNotNull(Sscc.serialOf(sscc, range.issuerPrefix))
        val data = buildJsonObject {
            put("palletId", p.palletId)
            put("sscc", sscc)
            put("blockId", checkNotNull(range.blockId))
            put("serial", serial)
            put("openedAt", p.openedAt)
            put("closedAt", closedAt)
            put("boxCount", db.palletMembershipDao().countOnPallet(p.palletId))
        }
        return queued(id, KIND_CLOSED, CLOSED, p.palletId, closedAt, 3, record(id, KIND_CLOSED, p.operatorId, data))
    }

    /**
     * A closed pallet taken apart (`ExceptionEngine.disassemblePallet`): the source is its exception row, settled by the host's receipt. The
     * reason goes as its code (the enum's name), never the Russian words the row keeps; this screen offers no «другое», so no text goes.
     */
    private fun disassembled(row: PalletExceptionEntity): Draft {
        val key = row.id.toString()
        val id = id(DISASSEMBLED, row.palletId)
        val code = DisassembleReason.entries.firstOrNull { it.audit == row.reason }?.name?.lowercase()
            ?: return quarantined(id, KIND_DISASSEMBLED, DISASSEMBLED, key, "bad_reason")
        if (!Iso.isDeviceInstant(row.occurredAt)) return quarantined(id, KIND_DISASSEMBLED, DISASSEMBLED, key, BAD_DEVICE_TIME)
        val data = buildJsonObject {
            put("palletId", row.palletId)
            put("reasonCode", code)
            put("reasonText", JsonNull)
            put("disassembledAt", row.occurredAt)
        }
        return queued(id, KIND_DISASSEMBLED, DISASSEMBLED, key, row.occurredAt, 4, record(id, KIND_DISASSEMBLED, row.operatorId, data))
    }

    companion object {
        const val OPEN = "warehouse_pallet_open"
        const val ADDED = "warehouse_pallet_box_added"
        const val REMOVED = "warehouse_pallet_box_removed"
        const val CLOSED = "warehouse_pallet_closed"
        const val DISASSEMBLED = "warehouse_pallet_disassembled"

        const val KIND_OPEN = "warehouse_pallet_opened"
        const val KIND_ADDED = "pallet_box_added"
        const val KIND_REMOVED = "pallet_box_removed"
        const val KIND_CLOSED = "warehouse_pallet_closed"
        const val KIND_DISASSEMBLED = "warehouse_pallet_disassembled"

        /** The host protocol that reads [KIND_DISASSEMBLED] (`markiro_proto::PROTOCOL_VERSION` 8). */
        const val DISASSEMBLY_PROTOCOL = 8

        private const val BAD_DEVICE_TIME = "bad_device_time"
        private const val MAX_PER_PASS = 10_000

        /** The host has the pallet open (the record of its opening was acknowledged); kept until the close is acknowledged. */
        fun openedKey(palletId: String) = "host_pallet_opened:$palletId"
    }
}
