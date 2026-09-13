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
        db.metaDao().remove(key(id))
    }

    /** Caller holds the business recovery commit, including the final empty-queue check. */
    suspend fun prepare(id: String, payload: String): EvidenceRequest {
        val key = key(id)
        val eventId = db.metaDao().get(key) ?: UUID.randomUUID().toString().also {
            val task = checkNotNull(db.inventoryTaskDao().get(id))
            check(task.state == "active" && task.leftAt == null)
            db.grants.complete(TaskKind.INVENTORY, id, it, GrantEventType.INVENTORY_CLOSE, payload = payload)
            db.metaDao().put(MetaEntity(key, it))
        }
        val evidence = GrantEvidenceTransport(db)
        return evidence.prepare("inventory-leave:$id", eventId, "/station/inventories/$id/leave", payload, mapOf("/#inventory.close.v1" to eventId), evidence.negotiated(eventId))
    }
}
