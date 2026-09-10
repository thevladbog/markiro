package app.markiro.handheld.core.inventory

import app.markiro.handheld.core.storage.InventoryEventEntity

/**
 * Canonical JSON of `inventoryEventSchema` and the event-batch envelope
 * (packages/domain/src/inventory/station-sync.ts): the digest is SHA-256 of the payload bytes,
 * so the key order and escaping must match `JSON.stringify` exactly.
 */
object InventoryBatchCodec {
    fun eventJson(e: InventoryEventEntity): String = CanonicalJson.obj(
        "eventId" to CanonicalJson.str(e.eventId),
        "deviceSequence" to CanonicalJson.num(e.deviceSequence),
        "operatorId" to CanonicalJson.str(e.operatorId),
        "scannedAt" to CanonicalJson.str(e.scannedAt),
        "kind" to CanonicalJson.str(e.kind),
        "normalizedIdentity" to CanonicalJson.str(e.normalizedIdentity),
        "codeHash" to CanonicalJson.strOrNull(e.codeHash),
        "canonicalRaw" to CanonicalJson.strOrNull(e.canonicalRaw),
        "activeProductionDate" to CanonicalJson.str(e.activeProductionDate),
        "localVerdict" to CanonicalJson.str(e.localVerdict),
    )

    fun payloadJson(snapshotId: String, sequenceCeiling: Long, pendingEventCount: Int, events: List<String>): String = CanonicalJson.obj(
        "snapshotId" to CanonicalJson.str(snapshotId),
        "snapshotRevision" to CanonicalJson.num(1),
        "sequenceCeiling" to CanonicalJson.num(sequenceCeiling),
        "pendingEventCount" to CanonicalJson.num(pendingEventCount),
        "openBoxCount" to CanonicalJson.num(0),
        "events" to CanonicalJson.arr(events),
    )

    fun digest(payloadJson: String): String = CanonicalJson.sha256Hex(payloadJson)

    /** The request is the payload plus `batchId` and `payloadDigest`; the server's strict schema accepts any key order. */
    fun requestJson(batchId: String, payloadDigest: String, payloadJson: String): String =
        "{" + CanonicalJson.str("batchId") + ":" + CanonicalJson.str(batchId) + "," +
            CanonicalJson.str("payloadDigest") + ":" + CanonicalJson.str(payloadDigest) + "," + payloadJson.substring(1)
}
