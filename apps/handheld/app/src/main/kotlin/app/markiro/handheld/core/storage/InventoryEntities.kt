package app.markiro.handheld.core.storage

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/** Joined inventory tasks with their manifest; `state` is `staging` (snapshot downloading), `active` or `closed`. */
@Entity(tableName = "inventory_tasks")
data class InventoryTaskEntity(
    @PrimaryKey val inventoryId: String,
    val inventoryNumber: String,
    val productId: String,
    val productName: String,
    val productPrintName: String?,
    val gtin14: String,
    val mode: String,
    val lineId: String,
    val lineName: String,
    val productionDateFrom: String,
    val productionDateTo: String,
    val boxCapacity: Int,
    val snapshotId: String,
    val snapshotFixedAt: String,
    val contentDigest: String,
    val combinedDigest: String,
    val codeCount: Int,
    /** Rows with `expected && !protected`; the «Проверено» denominator. */
    val expectedCount: Int,
    val state: String,
    val stagingCursor: String?,
    val stagedCount: Int,
    val joinedAt: Long?,
    val leftAt: Long?,
)

/** Immutable snapshot rows; `parentSscc` is indexed so a box scan finds its contents. */
@Entity(
    tableName = "inventory_snapshot_codes",
    primaryKeys = ["snapshotId", "codeHash"],
    indices = [Index(value = ["snapshotId", "parentSscc"])],
)
data class InventorySnapshotCodeEntity(
    val snapshotId: String,
    val codeHash: String,
    val canonicalRaw: String,
    val gtin14: String,
    val serial: String,
    val sourceStatus: String,
    val sourceState: String?,
    val sourceProductionDate: String?,
    val parentSscc: String?,
    val expected: Boolean,
    val protected: Boolean,
)

/** One row per task: the active production date, the next device sequence and the progress cursor. */
@Entity(tableName = "inventory_terminal_state")
data class InventoryTerminalStateEntity(
    @PrimaryKey val inventoryId: String,
    val snapshotId: String,
    val operatorId: String?,
    val activeProductionDate: String?,
    val nextDeviceSequence: Long,
    val progressCursor: String?,
    val progressResultRevision: Long,
    val updatedAt: String,
)

/** This device's inventory events; `serverStatus` is null until the batch is acknowledged. */
@Entity(
    tableName = "inventory_events",
    indices = [
        Index(value = ["inventoryId", "deviceSequence"], unique = true),
        Index(value = ["inventoryId", "normalizedIdentity"]),
    ],
)
data class InventoryEventEntity(
    @PrimaryKey val eventId: String,
    val inventoryId: String,
    val snapshotId: String,
    val deviceSequence: Long,
    val operatorId: String,
    val scannedAt: String,
    val kind: String,
    val normalizedIdentity: String,
    val codeHash: String?,
    val canonicalRaw: String?,
    val activeProductionDate: String,
    val localVerdict: String,
    val claimedCount: Int,
    val winnerEventId: String?,
    val winnerDeviceId: String?,
    val winnerScannedAt: String?,
    val serverStatus: String?,
)

/** Who counted a code first, locally or per the server (`source`); a row makes later scans duplicates. */
@Entity(
    tableName = "inventory_results",
    primaryKeys = ["inventoryId", "codeHash"],
    indices = [Index(value = ["inventoryId", "firstAcceptedEventId"])],
)
data class InventoryResultEntity(
    val inventoryId: String,
    val snapshotId: String,
    val codeHash: String,
    val firstAcceptedEventId: String,
    val winningDeviceId: String,
    val winningScannedAt: String,
    val observedProductionDate: String?,
    val classification: String,
    val source: String,
    val updatedAt: String,
)

/** Canonical event JSON waiting for `POST /station/inventories/:id/event-batches`. */
@Entity(tableName = "inventory_outbox", indices = [Index(value = ["eventId"], unique = true)])
data class InventoryOutboxEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val inventoryId: String,
    val snapshotId: String,
    val eventId: String,
    val deviceSequence: Long,
    val payloadJson: String,
    val createdAt: String,
)
