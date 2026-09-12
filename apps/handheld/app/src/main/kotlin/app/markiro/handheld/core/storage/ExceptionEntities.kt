package app.markiro.handheld.core.storage

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * One queued operator correction: the audit fact and the outbox row at once.
 *
 * `payloadJson` is the exact wire object built when the operator confirmed, so
 * a retry resends byte-identical JSON and the shape cannot drift between the
 * moment it was validated and the moment it is sent.
 *
 * `afterOutboxId` is the ordering watermark: the outbox's highest id at that
 * same moment. The drain may not send this row until every scan up to that id
 * has been delivered, or the server would apply the correction against rows
 * that have not arrived yet and drop it without an error anywhere.
 */
@Entity(tableName = "box_exceptions", indices = [Index(value = ["ackedAt"])])
data class BoxExceptionEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val kind: String,
    val boxId: String,
    val codeHash: String?,
    val targetScannedAt: String?,
    val shiftId: String,
    val operatorId: String?,
    val reason: String?,
    val occurredAt: String,
    val payloadJson: String,
    val afterOutboxId: Long,
    val ackedAt: String?,
)

/**
 * One queued correction against a closed PALLET: `disassemble` or `reprint`.
 *
 * `payloadJson` is the exact wire object built when the operator confirmed, for
 * the identical reason [BoxExceptionEntity] carries one: a retry resends
 * byte-identical JSON, and the shape cannot drift between the moment it was
 * validated and the moment it is sent.
 *
 * `reason` is NOT nullable here, unlike the box channel's. Both pallet kinds
 * require one (`palletExceptionSchema` in `apps/api/src/modules/station-scans/
 * dto.ts` declares it `z.string().min(1)`), so a null could only ever be a
 * batch the server rejects forever.
 *
 * There is deliberately NO `afterOutboxId` watermark. A pallet exception does
 * not depend on the scan outbox at all -- it names a CLOSED PALLET, and the
 * server resolves it through the pallet closures it already holds plus the ones
 * in the same batch (`applyPalletExceptions` in `pallet-ingest.ts` silently
 * `continue`s past a pallet it cannot resolve). The ordering rule this channel
 * needs is therefore expressed against the pallet closure channel; see
 * [PalletExceptionDao.sendable].
 */
@Entity(tableName = "pallet_exceptions", indices = [Index(value = ["ackedAt"])])
data class PalletExceptionEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val kind: String,
    val palletId: String,
    val shiftId: String,
    val terminalId: String?,
    val operatorId: String?,
    val reason: String,
    val occurredAt: String,
    val payloadJson: String,
    val ackedAt: String?,
)
