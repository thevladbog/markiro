package app.markiro.handheld.core.host

import app.markiro.handheld.core.network.host.FactReceiptDto
import app.markiro.handheld.core.storage.ConflictEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.HostOutboxEntity
import app.markiro.handheld.core.util.Iso
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * What the host's receipt of each record does to this device, one record at a time and each in its own commit (a crash between two
 * records loses nothing: the one not yet settled is sent again and gets its kept receipt):
 *
 * - `accepted` and `conflict` leave the queue together with their source row (the scan leaves the outbox, a box or a pallet is
 *   acknowledged, a shift's close is accepted); a `conflict` of a scan is also kept as a conflict, visible on the device;
 * - `rejected` stays as a quarantined record with the host's code (support sees it, the rest of the queue goes on) and its source is
 *   not acknowledged; a rejected close is marked as a conflict of its shift;
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
                    "accepted" -> acknowledge(row)
                    "conflict" -> {
                        recordConflict(row, receipt)
                        acknowledge(row)
                    }
                    "rejected" -> reject(row, receipt.code ?: "rejected")
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
        }
    }

    private suspend fun reject(row: HostOutboxEntity, code: String) {
        db.hostOutboxDao().quarantine(row.recordId, code)
        if (row.sourceKind == "shift_close") db.shiftCloseDao().markConflict(row.sourceKey, code, now())
    }

    /** A scan the host already holds under another scan: the winner's terminal and time, as the cloud's conflict list keeps them. */
    private suspend fun recordConflict(row: HostOutboxEntity, receipt: FactReceiptDto) {
        if (row.sourceKind != "scan") return
        val body = runCatching { Json.parseToJsonElement(row.body).jsonObject }.getOrNull() ?: return
        val hash = body["data"].asObject()?.get("code").asObject()?.get("codeHash")?.jsonPrimitive?.contentOrNull ?: return
        val winner = receipt.details?.get("winner").asObject() ?: return
        val scannedAt = winner["scannedAt"]?.jsonPrimitive?.contentOrNull ?: return
        db.conflictDao().insertIgnore(listOf(ConflictEntity(hash, winner["deviceId"]?.jsonPrimitive?.contentOrNull, scannedAt, now())))
    }

    private fun kotlinx.serialization.json.JsonElement?.asObject(): JsonObject? = this as? JsonObject
}
