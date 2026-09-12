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
     *
     * A DISASSEMBLED box does not count. It keeps its `palletId` -- the 06d
     * spec (§1.3, and again in the disaggregation-document section) is explicit
     * that membership is never cleared, because it is the historical fact that
     * this box stood on this pallet, mirroring `box_items`, which are marked
     * rather than deleted. So the exclusion belongs in the COUNT, not in a
     * second writer clearing the pointer: the box is physically off the stack,
     * and counting it closes the pallet one box short of full, overstates
     * `qty.boxes` on the printed label, and leaves a goods-in clerk counting
     * boxes against that label one box down.
     *
     * `apps/station/src/lib/pallets.ts` answers this the same way in
     * `currentPallet`, `listClosedPallets` and `findUnresolvedPalletPrint`.
     * Two surfaces closing pallets off the same physical event must not
     * disagree about what that event means.
     */
    @Query("SELECT COUNT(*) FROM boxes WHERE palletId = :palletId AND disassembledAt IS NULL")
    suspend fun boxCount(palletId: String): Int

    @Query("SELECT COUNT(*) FROM boxes WHERE palletId = :palletId AND disassembledAt IS NULL")
    fun observeBoxCount(palletId: String): Flow<Int>

    /**
     * Units across every box this pallet still carries, derived rather than
     * stored for the same reason `boxCount` is: it cannot disagree with what
     * the pallet's boxes actually carry. Feeds the pallet label's own `qty`,
     * which is a unit count, not the box count `qty.boxes` carries.
     *
     * Excludes a disassembled box explicitly rather than relying on its codes
     * having been released. `ExceptionEngine.disassemble` does both in one
     * transaction today, so the two agree -- but a count that is only correct
     * while that holds is a count waiting to disagree with `boxCount` beside
     * it, which is precisely how one label came to overstate boxes and
     * understate units at the same time. The station's `palletItemCount`
     * carries the same filter.
     */
    @Query(
        "SELECT COUNT(*) FROM codes_mirror WHERE boxId IN " +
            "(SELECT boxId FROM boxes WHERE palletId = :palletId AND disassembledAt IS NULL)",
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

    /** The deferred-label queue's pallet half: closed pallets whose label is not resolved, oldest first. */
    @Query("SELECT * FROM pallets WHERE closedAt IS NOT NULL AND printState <> 'printed' ORDER BY closedAt, palletId")
    fun observeUnprinted(): Flow<List<PalletEntity>>

    @Query("SELECT COUNT(*) FROM pallets WHERE closedAt IS NOT NULL AND printState <> 'printed'")
    fun observeUnprintedCount(): Flow<Int>

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

    /** Closures still owed to the server; the sync indicator counts these too. */
    @Query("SELECT COUNT(*) FROM pallets WHERE closedAt IS NOT NULL AND ackedAt IS NULL")
    fun observeUnackedCount(): Flow<Int>

    @Query("UPDATE pallets SET ackedAt = :at WHERE palletId IN (:palletIds)")
    suspend fun markAcked(palletIds: List<String>, at: String)

    @Query("DELETE FROM pallets")
    suspend fun clear()
}
