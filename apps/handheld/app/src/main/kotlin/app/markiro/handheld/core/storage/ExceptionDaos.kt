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
