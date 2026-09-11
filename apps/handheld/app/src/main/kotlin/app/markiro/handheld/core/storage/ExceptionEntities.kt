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
