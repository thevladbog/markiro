package app.markiro.handheld.core.storage

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

@Dao
interface PalletDao {
    @Insert
    suspend fun insert(pallet: PalletEntity)

    @Query("SELECT * FROM pallets WHERE shiftId = :shiftId AND closedAt IS NULL LIMIT 1")
    suspend fun open(shiftId: String): PalletEntity?

    @Query("SELECT * FROM pallets WHERE shiftId = :shiftId AND closedAt IS NULL LIMIT 1")
    fun observeOpen(shiftId: String): Flow<PalletEntity?>

    @Query("SELECT * FROM pallets WHERE palletId = :palletId")
    suspend fun get(palletId: String): PalletEntity?

    /**
     * Derived, never stored, and correlated by pallet rather than by shift: a
     * box that joined a different pallet must never inflate this one's count.
     */
    @Query("SELECT COUNT(*) FROM boxes WHERE palletId = :palletId")
    suspend fun boxCount(palletId: String): Int

    @Query("SELECT COUNT(*) FROM boxes WHERE palletId = :palletId")
    fun observeBoxCount(palletId: String): Flow<Int>

    /**
     * Units across every box this pallet holds, derived rather than stored for
     * the same reason `boxCount` is: it cannot disagree with what the pallet's
     * boxes actually carry. Feeds the pallet label's own `qty`, which is a unit
     * count, not the box count `qty.boxes` carries.
     */
    @Query(
        "SELECT COUNT(*) FROM codes_mirror WHERE boxId IN " +
            "(SELECT boxId FROM boxes WHERE palletId = :palletId)",
    )
    suspend fun itemCount(palletId: String): Int

    /** Guarded by `closedAt IS NULL` so a replayed close cannot reclose a pallet. */
    @Query(
        "UPDATE pallets SET sscc = :sscc, closedAt = :closedAt, operatorId = :operatorId, " +
            "printState = 'pending', printReason = NULL WHERE palletId = :palletId AND closedAt IS NULL",
    )
    suspend fun close(palletId: String, sscc: String, closedAt: String, operatorId: String?): Int

    @Query("UPDATE pallets SET printState = :state, printReason = :reason WHERE palletId = :palletId")
    suspend fun setPrintState(palletId: String, state: String, reason: String?)

    /** Anything the app left mid-print is unknown, never resumed -- same reasoning as `BoxDao.demoteInterruptedPrints`. */
    @Query("UPDATE pallets SET printState = 'unknown', printReason = NULL WHERE printState = 'printing'")
    suspend fun demoteInterruptedPrints(): Int

    /**
     * Closed and unacknowledged, oldest first, for the sync batch. The
     * ordering is what lets a retry re-read the same first N rows: nothing can
     * close earlier than a pallet that already closed.
     */
    @Query("SELECT * FROM pallets WHERE closedAt IS NOT NULL AND ackedAt IS NULL ORDER BY closedAt, palletId LIMIT :limit")
    suspend fun unacked(limit: Int): List<PalletEntity>

    @Query("UPDATE pallets SET ackedAt = :at WHERE palletId IN (:palletIds)")
    suspend fun markAcked(palletIds: List<String>, at: String)

    @Query("DELETE FROM pallets")
    suspend fun clear()
}
