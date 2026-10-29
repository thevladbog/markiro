package app.markiro.handheld.core.host

import app.markiro.handheld.core.network.host.FactReceiptDto
import app.markiro.handheld.core.network.host.flag
import app.markiro.handheld.core.network.host.text
import app.markiro.handheld.core.storage.ConflictEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.HostOutboxEntity
import app.markiro.handheld.core.storage.MetaEntity
import app.markiro.handheld.core.util.Iso
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

/**
 * What the host's receipt of each record does to this device, one record at a time and each in its own commit (a crash between two
 * records loses nothing: the one not yet settled is sent again and gets its kept receipt):
 *
 * - `accepted` and `conflict` leave the queue together with their source row (the scan leaves the outbox, a box or a pallet is
 *   acknowledged, a shift's close is accepted); a `conflict` of a scan is also kept as a conflict, visible on the device;
 * - `rejected` stays as a quarantined record with the host's code (support sees it, the rest of the queue goes on) and its source is
 *   not acknowledged; a rejected close is marked as a conflict of its shift. The records of the pallet-events channel settle the same way, except
 *   that a box the host refuses (`box_on_pallet` and the like, or a `conflict` receipt) is a rejected membership, not a quarantined record;
 * - a record without a receipt in the answer stays queued: the next pass sends it again under its id;
 * - an unknown outcome is a defect of one side and is kept quarantined, never read as success.
 *
 * Returns how many records of [sent] the answer settled.
 */
class HostAckMapper(private val db: HandheldDatabase, private val now: () -> String = { Iso.format(System.currentTimeMillis()) }) {
    suspend fun apply(sent: List<HostOutboxEntity>, receipts: List<FactReceiptDto>): Int {
        val byId = receipts.mapNotNull { r -> r.id?.let { it to r } }.toMap()
        var settled = 0
        for (row in sent) {
            val receipt = byId[row.recordId] ?: continue // no receipt: stays queued, the next pass repeats it
            db.recovery.commit {
                when (receipt.outcome) {
                    "accepted" -> {
                        acknowledge(row)
                        noteCloseReceipt(row, receipt)
                    }
                    "conflict" -> if (row.sourceKind == HostPalletEvents.ADDED) {
                        // A box the host already holds on another pallet: the membership is refused, the queue goes on.
                        refuseBox(row, "box_on_pallet", receipt)
                    } else {
                        recordConflict(row, receipt)
                        acknowledge(row)
                    }
                    "rejected" -> reject(row, receipt)
                    else -> db.hostOutboxDao().quarantine(row.recordId, "unknown_outcome")
                }
            }
            settled++
        }
        return settled
    }

    private suspend fun acknowledge(row: HostOutboxEntity) {
        db.hostOutboxDao().delete(row.recordId)
        when (row.sourceKind) {
            "scan" -> row.sourceKey.toLongOrNull()?.let { db.outboxDao().delete(it) }
            "box" -> db.boxDao().markAcked(listOf(row.sourceKey), now())
            "pallet" -> db.palletDao().markAcked(listOf(row.sourceKey), now())
            "shift_close" -> db.shiftCloseDao().markAccepted(row.sourceKey, now())
            HostPalletEvents.OPEN -> db.metaDao().put(MetaEntity(HostPalletEvents.openedKey(row.sourceKey), now()))
            // The receipt belongs to the add that was frozen (its `addedAt`): a box taken off and put on again is another row.
            HostPalletEvents.ADDED -> body(row)?.let { db.palletMembershipDao().markAcceptedAt(it.palletId, it.sscc, it.addedAt, now()) }
            HostPalletEvents.REMOVED -> row.sourceKey.toLongOrNull()?.let { db.palletMembershipRemovalDao().delete(it) }
            HostPalletEvents.DISASSEMBLED -> row.sourceKey.toLongOrNull()?.let { db.palletExceptionDao().markAcked(listOf(it), now()) }
            HostPalletEvents.CLOSED -> {
                db.palletDao().markAcked(listOf(row.sourceKey), now())
                db.metaDao().remove(HostPalletEvents.openedKey(row.sourceKey))
            }
        }
    }

    /**
     * What the host said of a close beyond «accepted» (plan 2b): the part closed while the shift stays open for the others, or the shift closed
     * without the reason its plan needed. Written with the acknowledgement, in the same commit; the close summary reads it once the queue is drained.
     */
    private suspend fun noteCloseReceipt(row: HostOutboxEntity, receipt: FactReceiptDto) {
        if (row.sourceKind != "shift_close") return
        val note = when {
            receipt.details.flag("partClosed") -> ShiftParticipationStore.NOTE_PART_CLOSED
            receipt.details.flag("reasonMissing") -> ShiftParticipationStore.NOTE_REASON_MISSING
            else -> return
        }
        val shiftId = db.shiftCloseDao().forEvent(row.sourceKey)?.shiftId ?: return
        db.metaDao().put(MetaEntity(ShiftParticipationStore.closeNoteKey(shiftId), note))
    }

    private suspend fun reject(row: HostOutboxEntity, receipt: FactReceiptDto) {
        val code = receipt.code ?: "rejected"
        when {
            row.sourceKind == HostPalletEvents.ADDED && code in BOX_REFUSALS -> refuseBox(row, code, receipt)
            // Taking off a box the host never had (the box was put and taken off before the host heard of either) leaves nothing to undo.
            row.sourceKind == HostPalletEvents.REMOVED && code in NOTHING_TO_REMOVE -> acknowledge(row)
            else -> {
                db.hostOutboxDao().quarantine(row.recordId, code)
                if (row.sourceKind == "shift_close") db.shiftCloseDao().markConflict(row.sourceKey, code, now())
            }
        }
    }

    /**
     * The host will not hold this box on this pallet: the membership is rejected (the pallet's screen shows which box and why, and the box
     * can be scanned again), the device's own claim on the box is released, and when the host named the pallet that has it, the registry
     * says so too. The record leaves the queue; nothing is quarantined, the line is not stopped.
     */
    private suspend fun refuseBox(row: HostOutboxEntity, code: String, receipt: FactReceiptDto) {
        val sent = body(row)
        db.hostOutboxDao().delete(row.recordId)
        if (sent == null) return
        val winnerSscc = receipt.details.text("palletSscc")
        // Only the row that was sent is refused; a replacement added since (another `addedAt`) holds the claim on the box.
        if (db.palletMembershipDao().markRejectedAt(sent.palletId, sent.sscc, sent.addedAt, code, winnerSscc, now()) == 0) return
        db.boxRegistryDao().release(sent.sscc)
        if (code == "box_on_pallet") {
            db.boxRegistryDao().markOnPallet(sent.sscc, receipt.details.text("palletId"), winnerSscc)
        }
    }

    private class Sent(val palletId: String, val sscc: String, val addedAt: String?)

    private fun body(row: HostOutboxEntity): Sent? {
        val data = runCatching { Json.parseToJsonElement(row.body).jsonObject["data"].asObject() }.getOrNull() ?: return null
        val palletId = data.text("palletId") ?: return null
        val sscc = data.text("boxSscc") ?: return null
        return Sent(palletId, sscc, data.text("addedAt"))
    }

    /** A scan the host already holds under another scan: the winner's terminal and time, as the cloud's conflict list keeps them. */
    private suspend fun recordConflict(row: HostOutboxEntity, receipt: FactReceiptDto) {
        if (row.sourceKind != "scan") return
        val body = runCatching { Json.parseToJsonElement(row.body).jsonObject }.getOrNull() ?: return
        val hash = body["data"].asObject()?.get("code").asObject().text("codeHash") ?: return
        val winner = receipt.details?.get("winner").asObject() ?: return
        val scannedAt = winner.text("scannedAt") ?: return
        db.conflictDao().insertIgnore(listOf(ConflictEntity(hash, winner.text("deviceId"), scannedAt, now())))
    }

    private companion object {
        /** A refusal of one box, not of the pallet: the box cannot be on this pallet as it is. */
        val BOX_REFUSALS = setOf("box_on_pallet", "box_not_found", "box_not_closed", "product_mismatch")
        val NOTHING_TO_REMOVE = setOf("box_not_found", "pallet_unknown")
    }

    private fun kotlinx.serialization.json.JsonElement?.asObject(): JsonObject? = this as? JsonObject
}
