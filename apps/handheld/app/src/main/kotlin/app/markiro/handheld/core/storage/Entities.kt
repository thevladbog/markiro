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
