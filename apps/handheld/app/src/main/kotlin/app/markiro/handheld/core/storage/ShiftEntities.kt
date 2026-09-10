package app.markiro.handheld.core.storage

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/** Cached `GET /shifts` rows, enriched by the bundle on entry. `bundleFetchedAt` marks an offline-enterable shift. */
@Entity(tableName = "shift_mirror")
data class ShiftEntity(
    @PrimaryKey val id: String,
    val number: String,
    val status: String,
    val mode: String,
    val productId: String,
    val productName: String?,
    val productPrintName: String?,
    val productGtin14: String?,
    val lineId: String?,
    val lineName: String?,
    val counterpartyName: String?,
    val plannedQty: Int?,
    val plannedDate: String?,
    val productionDate: String?,
    val boxCapacity: Int?,
    val palletCapacity: Int?,
    val palletsEnabled: Boolean,
    val validationPrintMode: String,
    val closePolicyKind: String?,
    val closeOwnerDeviceId: String?,
    val openedAt: String?,
    val listFetchedAt: Long,
    val bundleFetchedAt: Long? = null,
    val enteredAt: Long? = null,
    val leftAt: Long? = null,
)

/** Accepted codes on this device, keyed by the KM hash device-wide (a code is one physical item). */
@Entity(tableName = "codes_mirror")
data class CodeEntity(
    @PrimaryKey val codeHash: String,
    val shiftId: String,
    val gtin14: String,
    val serial: String,
    val scannedAt: String,
)

/** Every scan with its final verdict; feeds the recent list and the counters. */
@Entity(tableName = "scan_events")
data class ScanEventEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val shiftId: String,
    val raw: String,
    val verdict: String,
    val scannedAt: String,
    val operatorId: String?,
    val codeHash: String?,
)

/** Rows waiting for `POST /station/scans`; `id` order is the batch order and ids are never reused. */
@Entity(tableName = "outbox")
data class OutboxEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val shiftId: String,
    val raw: String,
    val verdict: String,
    val scannedAt: String,
    val operatorId: String?,
    val codeHash: String?,
    val gtin14: String?,
    val serial: String?,
)

@Entity(tableName = "conflicts_mirror")
data class ConflictEntity(
    @PrimaryKey val codeHash: String,
    val winningTerminalId: String?,
    val winningScannedAt: String,
    val detectedAt: String,
)

@Entity(
    tableName = "shift_close_outbox",
    indices = [Index(value = ["shiftId"], unique = true, name = "index_shift_close_outbox_shiftId")],
)
data class ShiftCloseEntity(
    @PrimaryKey val eventId: String,
    val shiftId: String,
    val operatorId: String?,
    val plannedQtySnapshot: Int?,
    val actualQty: Int,
    val closedBoxCount: Int,
    val reasonCode: String?,
    val closedAt: String,
    val state: String,
    val conflictCode: String?,
    val lastCheckedAt: String?,
)

@Entity(tableName = "meta")
data class MetaEntity(@PrimaryKey val key: String, val value: String)
