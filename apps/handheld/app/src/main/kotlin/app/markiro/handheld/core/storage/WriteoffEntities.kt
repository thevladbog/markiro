package app.markiro.handheld.core.storage

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * One queued write-off. The row IS the document, not an event: a write-off is
 * one atomic thing with one `deviceSeq`, so this mirrors `ShiftCloseEntity`
 * (`state` / conflicts / last attempt) rather than the per-event
 * `InventoryOutboxEntity`.
 *
 * `requestJson` is the exact body `POST /station/writeoffs` receives, frozen at
 * confirmation. The engine never rebuilds it: a retry is the same bytes under the
 * same `deviceSeq`, which is what lets the server answer a replay with the
 * original document instead of filing a second act.
 *
 * `state` is `pending` until acknowledged, then `sent` or `rejected`. Settled
 * rows stay as the history screen's data and are pruned past the newest 20;
 * pending rows are never pruned.
 */
@Entity(tableName = "writeoff_outbox", indices = [Index(value = ["deviceSeq"], unique = true)])
data class WriteoffOutboxEntity(
    @PrimaryKey val documentId: String,
    val deviceSeq: Long,
    val operatorId: String,
    val reasonId: String,
    val reasonName: String,
    val unitCount: Int,
    val boxCount: Int,
    val requestJson: String,
    val createdAt: String,
    val state: String,
    val orderNo: String?,
    val acceptedCount: Int?,
    /** The server's `conflicts` + `boxConflicts` as JSON, for «2 отклонено» in history. Null until acknowledged. */
    val conflictsJson: String?,
    val lastAttemptAt: String?,
)

/** Shared reason dictionary from `/station/writeoff-bootstrap`; replaced wholesale on each refresh. */
@Entity(tableName = "writeoff_reasons")
data class WriteoffReasonEntity(
    @PrimaryKey val id: String,
    val name: String,
    val sortOrder: Int,
)

/**
 * The tenant catalogue as the scanner sees it. `id` is what `box_registry`
 * names a product by; `gtin14` is what a unit scan resolves through.
 */
@Entity(tableName = "writeoff_products", indices = [Index(value = ["id"])])
data class WriteoffProductEntity(
    @PrimaryKey val gtin14: String,
    val id: String,
    val name: String,
)

/** Per-operator `can_writeoff`, so the mode can refuse before a scan rather than after a sync. */
@Entity(tableName = "writeoff_permissions")
data class WriteoffPermissionEntity(
    @PrimaryKey val employeeId: String,
    val canWriteoff: Boolean,
)
