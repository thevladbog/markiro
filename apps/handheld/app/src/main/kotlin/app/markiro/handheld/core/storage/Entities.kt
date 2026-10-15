package app.markiro.handheld.core.storage

import androidx.room.Entity
import androidx.room.PrimaryKey

/** Exactly one row (`id = 1`): the device is paired to one organisation at a time. */
@Entity(tableName = "device_config")
data class DeviceConfigEntity(
    @PrimaryKey val id: Int = 1,
    val deviceId: String,
    val deviceName: String,
    val tenantId: String,
    val organizationName: String,
    val lineId: String?,
    val lineName: String?,
    val kind: String,
    val serverUrl: String,
    val pairedAt: Long,
    val rosterFetchedAt: Long? = null,
    val lastOperatorId: String? = null,
    val shiftsCount: Int? = null,
    val inventoryCount: Int? = null,
    val countsAt: Long? = null,
    /** Shift this handheld is working in or paused from; the hub pins «Продолжить» on it. */
    val activeShiftId: String? = null,
    /** Inventory task this handheld is working in or paused from. */
    val activeInventoryId: String? = null,
    /** `cloud` (the default, every device paired before plan ТСД-А) or `host`: a device is one or the other for life (spec Д2). */
    @androidx.room.ColumnInfo(defaultValue = "'cloud'")
    val backend: String = "cloud",
    /** The lower-case hex SHA-256 of the host's certificate this device was paired with; only for `host`. */
    val pinSha256: String? = null,
    val hostId: String? = null,
    /** The addresses of the pairing payload, comma-separated, active one first. */
    val hostAddresses: String? = null,
    /** The host's `restoreEpoch` last seen: a change means a restore from a copy (spec 8.5). */
    val hostRestoreEpoch: String? = null,
    /** The last revision of `GET /v1/changes` applied. */
    val hostRev: Long? = null,
)

/** Roster mirror; hashes are PHC verifiers, never plaintext. */
@Entity(tableName = "operators")
data class OperatorEntity(
    @PrimaryKey val operatorId: String,
    val name: String,
    val login: String,
    val role: String,
    val pinHash: String,
    val badgeHash: String?,
    val active: Boolean,
)
