package app.markiro.handheld.core.storage

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

object MembershipStatus {
    const val PENDING = "pending"

    /** Pinned into a batch in flight; a retry resends exactly this row. */
    const val SENT = "sent"
    const val ACCEPTED = "accepted"
    const val REJECTED = "rejected"
}

/**
 * One closed box scanned onto a warehouse pallet (spec §3.1). Pure fact after
 * `sent`; only `status`/`reason`/`winningPalletSscc`/`ackedAt`/`acknowledgedAt`
 * change afterwards. `acknowledgedAt` is the operator's «Принято» on a rejection.
 */
@Entity(tableName = "pallet_memberships", primaryKeys = ["palletId", "sscc"], indices = [Index(value = ["status", "addedAt"])])
data class PalletMembershipEntity(
    val palletId: String,
    val sscc: String,
    val addedAt: String,
    val operatorId: String?,
    val status: String,
    val reason: String?,
    val winningPalletSscc: String?,
    val ackedAt: String?,
    val acknowledgedAt: String?,
    /**
     * The member box's unit count, SNAPSHOT at attach time rather than read
     * back through `box_registry`.
     *
     * The registry is a server mirror: a delta `remove` or a full re-walk can
     * drop the row of a box that is physically still on this pallet, and a
     * pallet label whose `qty` silently dropped by a box's worth of units is a
     * goods-in dispute nobody can reconstruct afterwards. Nullable so Room
     * needs no default and rows written before this column existed still read.
     */
    val bottleCount: Int? = null,
    /** The member box's civil `YYYY-MM-DD`, snapshot for the same reason. */
    val productionDate: String? = null,
)

@Dao
interface PalletMembershipDao {
    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insert(row: PalletMembershipEntity)

    @Query("SELECT * FROM pallet_memberships WHERE palletId = :palletId ORDER BY addedAt, sscc")
    suspend fun byPallet(palletId: String): List<PalletMembershipEntity>

    @Query("SELECT * FROM pallet_memberships WHERE palletId = :palletId ORDER BY addedAt, sscc")
    fun observeByPallet(palletId: String): Flow<List<PalletMembershipEntity>>

    /** Oldest first, so a retry re-reads the same first N rows (the pallet channel's own rule). */
    @Query("SELECT * FROM pallet_memberships WHERE status = 'pending' ORDER BY addedAt, palletId, sscc LIMIT :limit")
    suspend fun pending(limit: Int): List<PalletMembershipEntity>

    /** The rows a batch in flight pinned: exactly the `sent` ones, in the same order. */
    @Query("SELECT * FROM pallet_memberships WHERE status = 'sent' ORDER BY addedAt, palletId, sscc LIMIT :limit")
    suspend fun sent(limit: Int): List<PalletMembershipEntity>

    @Query("UPDATE pallet_memberships SET status = 'sent' WHERE status = 'pending' AND palletId = :palletId AND sscc = :sscc")
    suspend fun markSent(palletId: String, sscc: String)

    /** A batch abandoned by `clearPending` (server never applied it) gives its rows back to the queue. */
    @Query("UPDATE pallet_memberships SET status = 'pending' WHERE status = 'sent'")
    suspend fun revertSent()

    @Query(
        "UPDATE pallet_memberships SET status = 'accepted', ackedAt = :at, reason = NULL, winningPalletSscc = NULL " +
            "WHERE palletId = :palletId AND sscc = :sscc",
    )
    suspend fun markAccepted(palletId: String, sscc: String, at: String)

    @Query(
        "UPDATE pallet_memberships SET status = 'rejected', reason = :reason, winningPalletSscc = :winner, ackedAt = :at " +
            "WHERE palletId = :palletId AND sscc = :sscc",
    )
    suspend fun markRejected(palletId: String, sscc: String, reason: String, winner: String?, at: String)

    /** Only a pending row can be taken off the pallet locally; a sent one may already be on the server. */
    @Query("DELETE FROM pallet_memberships WHERE palletId = :palletId AND sscc = :sscc AND status = 'pending'")
    suspend fun deletePending(palletId: String, sscc: String): Int

    /**
     * Clears a rejected row so the operator can re-scan the box onto this same
     * pallet once the conflict is resolved. A rejected membership is not
     * "already on this pallet" -- the server refused it -- and the primary key
     * would otherwise abort the second insert forever.
     */
    @Query("DELETE FROM pallet_memberships WHERE palletId = :palletId AND sscc = :sscc AND status = 'rejected'")
    suspend fun deleteRejected(palletId: String, sscc: String): Int

    @Query("SELECT COUNT(*) FROM pallet_memberships WHERE status IN ('pending', 'sent')")
    fun observePendingCount(): Flow<Int>

    /** Boxes counted as ON the pallet: everything not rejected. */
    @Query("SELECT COUNT(*) FROM pallet_memberships WHERE palletId = :palletId AND status <> 'rejected'")
    suspend fun countOnPallet(palletId: String): Int

    @Query("SELECT COUNT(*) FROM pallet_memberships WHERE palletId = :palletId AND status <> 'rejected'")
    fun observeCountOnPallet(palletId: String): Flow<Int>

    @Query("SELECT * FROM pallet_memberships WHERE palletId = :palletId AND status = 'rejected' AND acknowledgedAt IS NULL ORDER BY addedAt")
    fun observeUnacknowledgedRejections(palletId: String): Flow<List<PalletMembershipEntity>>

    @Query("UPDATE pallet_memberships SET acknowledgedAt = :at WHERE palletId = :palletId AND status = 'rejected' AND acknowledgedAt IS NULL")
    suspend fun acknowledge(palletId: String, at: String)

    /**
     * Units on the pallet, from the membership rows' OWN snapshot rather than
     * from `box_registry`: see [PalletMembershipEntity.bottleCount].
     */
    @Query("SELECT COALESCE(SUM(bottleCount), 0) FROM pallet_memberships WHERE palletId = :palletId AND status <> 'rejected'")
    suspend fun bottleSum(palletId: String): Int

    /** Distinct civil production dates of the member boxes, snapshot at attach (null when unknown). */
    @Query("SELECT DISTINCT productionDate FROM pallet_memberships WHERE palletId = :palletId AND status <> 'rejected'")
    suspend fun productionDates(palletId: String): List<String?>

    @Query("DELETE FROM pallet_memberships")
    suspend fun clear()
}
