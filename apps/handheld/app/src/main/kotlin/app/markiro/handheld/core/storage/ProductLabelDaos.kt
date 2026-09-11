package app.markiro.handheld.core.storage

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.Query
import androidx.room.Update
import kotlinx.coroutines.flow.Flow

@Dao
interface ProductLabelJobDao {
    @Insert
    suspend fun insert(job: ProductLabelJobEntity)

    @Update
    suspend fun update(job: ProductLabelJobEntity)

    @Query("SELECT * FROM product_label_jobs WHERE jobId = :jobId")
    suspend fun get(jobId: String): ProductLabelJobEntity?

    /**
     * The one job the next trigger pull is about.
     *
     * A `completed` job is at rest -- the protocol still accepts a reprint of
     * one, but nothing a scan does concerns it -- and every other status is
     * outstanding, which is why this is a negative test rather than a list of
     * live statuses.
     */
    @Query("SELECT * FROM product_label_jobs WHERE shiftId = :shiftId AND status <> 'completed' ORDER BY acceptedAt LIMIT 1")
    suspend fun openJob(shiftId: String): ProductLabelJobEntity?

    @Query("SELECT * FROM product_label_jobs WHERE shiftId = :shiftId AND status <> 'completed' ORDER BY acceptedAt LIMIT 1")
    fun observeOpen(shiftId: String): Flow<ProductLabelJobEntity?>

    /** Anything the app left mid-send is unknown, never resumable. */
    @Query("SELECT * FROM product_label_jobs WHERE attemptState = 'sending'")
    suspend fun interrupted(): List<ProductLabelJobEntity>

    /** Retention, step one: the bytes exist only for a reprint, and a closed shift takes none. */
    @Query("UPDATE product_label_jobs SET bytesBase64 = NULL WHERE shiftId = :shiftId")
    suspend fun dropBytesForShift(shiftId: String)

    /**
     * Retention, step two: the row goes once the server holds every one of its
     * events. A quarantined event counts as settled -- the server will never
     * take it, so waiting for it would keep the row forever.
     */
    @Query(
        "DELETE FROM product_label_jobs WHERE shiftId = :shiftId AND status = 'completed' AND NOT EXISTS (" +
            "SELECT 1 FROM product_label_events WHERE product_label_events.jobId = product_label_jobs.jobId " +
            "AND ackedAt IS NULL AND quarantineCode IS NULL)",
    )
    suspend fun purgeSettled(shiftId: String)

    @Query("DELETE FROM product_label_jobs")
    suspend fun clear()
}

@Dao
interface ProductLabelEventDao {
    @Insert
    suspend fun insert(event: ProductLabelEventEntity)

    /**
     * Oldest first across every job, and within a job strictly by sequence: the
     * server refuses a gap, so the order is the contract rather than a
     * preference. `occurredAt` alone is not enough -- two events of one job can
     * land in the same millisecond.
     */
    @Query(
        "SELECT * FROM product_label_events WHERE ackedAt IS NULL AND quarantineCode IS NULL " +
            "ORDER BY occurredAt, jobId, sequence LIMIT :limit",
    )
    suspend fun unacked(limit: Int): List<ProductLabelEventEntity>

    @Query("SELECT COUNT(*) FROM product_label_events WHERE ackedAt IS NULL AND quarantineCode IS NULL")
    fun observeUnackedCount(): Flow<Int>

    @Query("UPDATE product_label_events SET ackedAt = :at WHERE eventId IN (:eventIds)")
    suspend fun markAcked(eventIds: List<String>, at: String)

    /** Quarantine is not delivery; the code stays so the operator can be told. */
    @Query("UPDATE product_label_events SET quarantineCode = :code, ackedAt = :at WHERE eventId = :eventId")
    suspend fun markQuarantined(eventId: String, code: String, at: String)

    @Query("SELECT * FROM product_label_events WHERE jobId = :jobId ORDER BY sequence")
    suspend fun bySequence(jobId: String): List<ProductLabelEventEntity>

    @Query("SELECT COUNT(*) FROM product_label_events WHERE quarantineCode IS NOT NULL")
    fun observeQuarantinedCount(): Flow<Int>

    @Query("DELETE FROM product_label_events")
    suspend fun clear()
}
