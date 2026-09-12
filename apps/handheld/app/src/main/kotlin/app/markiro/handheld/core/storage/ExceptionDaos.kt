package app.markiro.handheld.core.storage

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

@Dao
interface BoxExceptionDao {
    @Insert
    suspend fun insert(row: BoxExceptionEntity): Long

    /**
     * Facts whose targets the server already has, oldest first.
     *
     * `through` is the outbox ceiling of the batch being built, so a fact whose
     * watermark is at or below it rides the same request as the scans it
     * corrects -- the server applies `items` before `exceptions` within one
     * transaction. A fact above the ceiling waits for a later batch.
     *
     * `disassemble` and `reprint` additionally wait for their box's closure to
     * be acknowledged: those two name a closed box, and the box channel has its
     * own per-batch limit, so sharing a request is not guaranteed.
     */
    @Query(
        "SELECT * FROM box_exceptions WHERE ackedAt IS NULL AND afterOutboxId <= :through " +
            "AND (kind IN ('undo', 'clear') OR EXISTS (" +
            "SELECT 1 FROM boxes WHERE boxes.boxId = box_exceptions.boxId AND boxes.ackedAt IS NOT NULL)) " +
            "ORDER BY id LIMIT :limit",
    )
    suspend fun sendable(through: Long, limit: Int): List<BoxExceptionEntity>

    /**
     * Everything still owed, in send order, whether or not it may leave yet.
     *
     * `sendable` is the drain's view and deliberately withholds a fact whose
     * targets the server has not seen; this is the queue itself. The two answer
     * different questions and a caller that confuses them will read an empty
     * list as an empty queue.
     */
    @Query("SELECT * FROM box_exceptions WHERE ackedAt IS NULL ORDER BY id")
    suspend fun queued(): List<BoxExceptionEntity>

    @Query("UPDATE box_exceptions SET ackedAt = :at WHERE id IN (:ids)")
    suspend fun markAcked(ids: List<Long>, at: String)

    @Query("SELECT COUNT(*) FROM box_exceptions WHERE ackedAt IS NULL")
    suspend fun unackedCount(): Int

    @Query("SELECT COUNT(*) FROM box_exceptions WHERE ackedAt IS NULL")
    fun observeUnackedCount(): Flow<Int>

    @Query("DELETE FROM box_exceptions WHERE ackedAt IS NOT NULL")
    suspend fun purgeAcked()

    @Query("DELETE FROM box_exceptions")
    suspend fun clear()
}

@Dao
interface PalletExceptionDao {
    @Insert
    suspend fun insert(row: PalletExceptionEntity): Long

    /**
     * Facts the server can actually resolve, oldest first.
     *
     * `applyPalletExceptions` (`apps/api/src/modules/station-scans/
     * pallet-ingest.ts`) looks its pallet up in the map `upsertPallets` built
     * from THIS batch's `pallets[]` plus the pallets the server already holds,
     * and when the lookup misses it does `if (id === undefined) continue` --
     * no error, no receipt, nothing. A fact sent too early is therefore not
     * retried, not quarantined and not reported: it is silently dropped, and
     * this device acknowledges it anyway.
     *
     * So a fact may leave only once its pallet's CLOSURE is acknowledged, or is
     * carried by the same request -- which is what `carried` names. This is
     * reachable in ordinary use, not a corner case: the pallet channel is
     * capped at `MAX_PALLET_CLOSURES` per batch, so on a device holding more
     * unacknowledged closures than that, a pallet past the cap has its closure
     * deferred to a later batch while a reprint for it is already queued.
     *
     * The dependency is on the PALLET CLOSURE channel, not on the scan outbox,
     * which is why there is no `afterOutboxId` watermark here the way
     * [BoxExceptionDao.sendable] has one.
     */
    @Query(
        "SELECT * FROM pallet_exceptions WHERE ackedAt IS NULL AND EXISTS (" +
            "SELECT 1 FROM pallets WHERE pallets.palletId = pallet_exceptions.palletId " +
            "AND (pallets.ackedAt IS NOT NULL OR pallets.palletId IN (:carried))) " +
            "ORDER BY id LIMIT :limit",
    )
    suspend fun sendable(carried: List<String>, limit: Int): List<PalletExceptionEntity>

    /**
     * Everything still owed, in send order, whether or not it may leave yet.
     *
     * The counterpart of [BoxExceptionDao.queued] and the same trap: `sendable`
     * is the drain's view and deliberately withholds a fact whose pallet the
     * server cannot resolve yet, so reading it as "the queue" reports an empty
     * queue while work is still owed.
     */
    @Query("SELECT * FROM pallet_exceptions WHERE ackedAt IS NULL ORDER BY id")
    suspend fun queued(): List<PalletExceptionEntity>

    @Query("UPDATE pallet_exceptions SET ackedAt = :at WHERE id IN (:ids)")
    suspend fun markAcked(ids: List<Long>, at: String)

    @Query("SELECT COUNT(*) FROM pallet_exceptions WHERE ackedAt IS NULL")
    suspend fun unackedCount(): Int

    @Query("SELECT COUNT(*) FROM pallet_exceptions WHERE ackedAt IS NULL")
    fun observeUnackedCount(): Flow<Int>

    @Query("DELETE FROM pallet_exceptions WHERE ackedAt IS NOT NULL")
    suspend fun purgeAcked()

    @Query("DELETE FROM pallet_exceptions")
    suspend fun clear()
}
