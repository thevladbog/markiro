package app.markiro.handheld.core.storage

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

object RemovalStatus {
    const val PENDING = "pending"
    const val SENT = "sent"
}

/**
 * A box taken off an open warehouse pallet (design spec §3.1). Rows are
 * events, not a per-box state: a box can be removed, re-scanned and removed
 * again, and a removal already `sent` belongs to a pinned batch that must
 * resend it unchanged, so a later removal of the same box is a NEW row. A
 * `pending` removal for the same `(palletId, sscc)` is reused instead -- the
 * membership between the two removals never left the device.
 */
@Entity(tableName = "pallet_membership_removals", indices = [Index(value = ["status", "id"])])
data class PalletMembershipRemovalEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val palletId: String,
    val sscc: String,
    val removedAt: String,
    val operatorId: String?,
    val status: String,
)

@Dao
interface PalletMembershipRemovalDao {
    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insert(row: PalletMembershipRemovalEntity): Long

    @Query("SELECT * FROM pallet_membership_removals WHERE status = 'pending' AND palletId = :palletId AND sscc = :sscc LIMIT 1")
    suspend fun pendingFor(palletId: String, sscc: String): PalletMembershipRemovalEntity?

    /**
     * The reused `pending` row takes the LATEST removal's clock and operator:
     * the record the server eventually applies must name who actually took the
     * box off and when, not the first of a remove/re-scan/remove sequence.
     */
    @Query("UPDATE pallet_membership_removals SET removedAt = :removedAt, operatorId = :operatorId WHERE id = :id")
    suspend fun refresh(id: Long, removedAt: String, operatorId: String?)

    /**
     * Both `pending` and `sent`: a removal in flight still means the registry's
     * claim on this box is ours and is being released.
     */
    @Query("SELECT COUNT(*) FROM pallet_membership_removals WHERE sscc = :sscc")
    suspend fun queuedFor(sscc: String): Int

    /** Oldest first, so a retry re-reads the same first N rows (the pallet channel's own rule). */
    @Query("SELECT * FROM pallet_membership_removals WHERE status = 'pending' ORDER BY id LIMIT :limit")
    suspend fun pending(limit: Int): List<PalletMembershipRemovalEntity>

    /** The rows a batch in flight pinned: exactly the `sent` ones, in the same order. */
    @Query("SELECT * FROM pallet_membership_removals WHERE status = 'sent' ORDER BY id LIMIT :limit")
    suspend fun sent(limit: Int): List<PalletMembershipRemovalEntity>

    @Query("UPDATE pallet_membership_removals SET status = 'sent' WHERE status = 'pending' AND id = :id")
    suspend fun markSent(id: Long)

    /** A batch abandoned by `clearPending` (server never applied it) gives its rows back to the queue. */
    @Query("UPDATE pallet_membership_removals SET status = 'pending' WHERE status = 'sent'")
    suspend fun revertSent()

    @Query("DELETE FROM pallet_membership_removals WHERE id = :id")
    suspend fun delete(id: Long)

    @Query("SELECT COUNT(*) FROM pallet_membership_removals WHERE status IN ('pending', 'sent')")
    fun observePendingCount(): Flow<Int>

    @Query("SELECT * FROM pallet_membership_removals ORDER BY id")
    suspend fun all(): List<PalletMembershipRemovalEntity>

    @Query("DELETE FROM pallet_membership_removals")
    suspend fun clear()
}
