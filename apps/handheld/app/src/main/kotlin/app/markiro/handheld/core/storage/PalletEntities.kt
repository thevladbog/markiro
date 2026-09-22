package app.markiro.handheld.core.storage

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

object PalletKind {
    const val PRODUCTION = "production"

    /** Built from closed boxes of any shift; belongs to this device, not to a shift (spec §3). */
    const val WAREHOUSE = "warehouse"
}

/**
 * A pallet on this device.
 *
 * `palletId` is device-generated for the same reason `boxId` is: the server
 * identifies a closure by all of `(tenant, shiftId, terminalId,
 * devicePalletId)`, and a device-local id is not globally unique.
 *
 * There is deliberately no `boxCount` column: the count is derived by counting
 * `boxes` rows that name this pallet, so it cannot disagree with what the
 * pallet holds.
 *
 * `printState` follows `PalletPrint` (identical to `BoxPrint`, see below). A
 * `printing` row found at startup is read as `unknown` and never resumed --
 * the app died between handing bytes to the printer and hearing back, which
 * is exactly what "we do not know whether paper moved" means, and resuming
 * would be an automatic resend.
 */
@Entity(tableName = "pallets", indices = [Index(value = ["shiftId", "closedAt"]), Index(value = ["deviceId", "kind", "closedAt"])])
data class PalletEntity(
    @PrimaryKey val palletId: String,
    /** Null for a warehouse pallet. */
    val shiftId: String?,
    val terminalId: String?,
    val sscc: String?,
    val openedAt: String,
    val closedAt: String?,
    val operatorId: String?,
    val printState: String,
    val printReason: String?,
    val ackedAt: String?,
    val kind: String = PalletKind.PRODUCTION,
    /** The one product every member box carries; set only for a warehouse pallet. */
    val productId: String? = null,
    /** This device, for a warehouse pallet; the server keys the pallet on it. */
    val deviceId: String? = null,
    /** Set when this closed pallet was taken apart on the device (Task 9). */
    val disassembledAt: String? = null,
)

/**
 * Print states a pallet row can hold. Identical to `BoxPrint`
 * (`core/box/BoxRepository.kt`) and stored as text for the same reason: a
 * migration should never have to renumber them.
 */
object PalletPrint {
    const val PENDING = "pending"
    const val PRINTING = "printing"
    const val PRINTED = "printed"
    const val FAILED = "failed"

    /** The bytes may or may not have reached the printer. Only a person resolves this. */
    const val UNKNOWN = "unknown"
    const val DEFERRED = "deferred"
}
