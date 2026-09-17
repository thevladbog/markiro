package app.markiro.handheld.core.inventory

import app.markiro.handheld.core.grants.*
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaEntity
import kotlinx.serialization.json.*
import java.util.UUID

/** A committed completion intent owns the close charge; network delivery never creates a charge. */
internal class InventoryLeaveJournal(private val db: HandheldDatabase) {
    private suspend fun key(id: String) = "inventory_leave:" + grantDigest(grantSlot(db.recovery.token().owner.grantOwnerKey(), "inventory", id))

    suspend fun pending(id: String): Boolean = db.metaDao().get(key(id)) != null && db.inventoryTaskDao().get(id)?.leftAt == null
    suspend fun completed(id: String): Boolean = db.metaDao().get(key(id)) != null && db.inventoryTaskDao().get(id)?.leftAt != null

    suspend fun activate(id: String) {
        check(!pending(id)) { "Inventory completion is awaiting reconciliation" }
        val key = key(id)
        db.metaDao().remove(key)
        db.metaDao().remove(key + ":legacy_payload")
    }

    /** Caller holds the business recovery commit, including the final empty-queue check. */
    suspend fun prepare(id: String, payload: String): EvidenceRequest {
        val key = key(id)
        val eventId = db.metaDao().get(key) ?: UUID.randomUUID().toString().also {
            val task = checkNotNull(db.inventoryTaskDao().get(id))
            check(task.state == "active" && task.leftAt == null)
            db.grants.complete(TaskKind.INVENTORY, id, it, GrantEventType.INVENTORY_CLOSE, payload = payload)
            db.metaDao().put(MetaEntity(key, it))
            // Freeze the new legacy body in the same recovery commit as its
            // completion identity. Existing pending rows lack this key and
            // retain their original body across an application upgrade.
            val identified = JsonObject(Json.parseToJsonElement(payload).jsonObject + ("requestId" to JsonPrimitive(it))).toString()
            db.metaDao().put(MetaEntity(key + ":legacy_payload", identified))
        }
        val evidence = GrantEvidenceTransport(db)
        val negotiated = evidence.negotiated(eventId)
        val requestPayload = if (negotiated) payload else db.metaDao().get(key + ":legacy_payload") ?: payload
        return evidence.prepare("inventory-leave:$id", eventId, "/station/inventories/$id/leave", requestPayload, mapOf("/#inventory.close.v1" to eventId), negotiated)
    }
}
