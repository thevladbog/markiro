package app.markiro.handheld.core.storage

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * A transport box on this device.
 *
 * `boxId` is device-generated because the server identifies a closure by all
 * four of `(tenant, shiftId, terminalId, deviceBoxId)` — a device-local id is
 * not globally unique.
 *
 * There is deliberately no `itemCount` column: the count is always derived by
 * counting `codes_mirror` rows that name this box, so it cannot disagree with
 * what the box actually holds.
 *
 * `printState` is one of `pending`, `printing`, `printed`, `failed`, `unknown`,
 * `deferred`. A `printing` row found at startup is read as `unknown` and never
 * resumed: the app died between handing bytes to the printer and hearing back,
 * which is exactly what "we do not know whether paper moved" means, and
 * resuming would be an automatic resend.
 */
@Entity(tableName = "boxes", indices = [Index(value = ["shiftId", "closedAt"])])
data class BoxEntity(
    @PrimaryKey val boxId: String,
    val shiftId: String,
    /** Null while the box is open; assigned at close, bare 18 digits. */
    val sscc: String?,
    val openedAt: String,
    /** The box's own closure moment, and the source of the label's dates. */
    val closedAt: String?,
    val operatorId: String?,
    val printState: String,
    val printReason: String?,
    /** Null until the server has accepted the closure. */
    val ackedAt: String?,
)

/**
 * One block of SSCC serials the server granted this device.
 *
 * Keyed by the 9-digit GS1 issuer PREFIX rather than a GLN: one GS1 member
 * commonly holds several GLNs that differ only in location digits and share one
 * serial space, so keying by GLN would let a device treat that single space as
 * two independent ones. `extensionDigit` keeps box ranges (0) and pallet ranges
 * (1) from ever mixing.
 *
 * Ranges are disjoint BY CONTRACT and this device does not re-check it. Every
 * one comes from the server, which cuts blocks from a single per-tenant counter;
 * the device never invents a range. Validating the intervals here would
 * duplicate a server invariant on a device holding no authority to reject a
 * block the server granted — refusing one would only stop a line. What is owned
 * here is the consequence: `SsccPool.burn` takes the lowest range with room and
 * advances that row's cursor, so no serial is issued twice from what is held.
 */
@Entity(tableName = "sscc_pool", primaryKeys = ["issuerPrefix", "extensionDigit", "fromSerial"])
data class SsccRangeEntity(
    val issuerPrefix: String,
    val extensionDigit: Int,
    /** The block's ORIGINAL bounds, as the server always reports them. */
    val fromSerial: Long,
    val toSerial: Long,
    val nextSerial: Long,
)
