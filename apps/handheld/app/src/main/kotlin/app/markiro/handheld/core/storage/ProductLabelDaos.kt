package app.markiro.handheld.core.storage

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.Query
import androidx.room.Transaction
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
    @Query("UPDATE product_label_jobs SET bytesBase64 = NULL WHERE shiftId = :shiftId AND NOT EXISTS (SELECT 1 FROM validation_occurrences o WHERE o.shiftId=product_label_jobs.shiftId AND o.codeHash=product_label_jobs.codeHash AND o.scannedAt=product_label_jobs.acceptedAt AND o.outcome IN ('pending','conflict'))")
    suspend fun dropBytesForShift(shiftId: String)

    /**
     * Retention, step two: a completed job goes once the server holds every one
     * of its events, and its events go with it.
     *
     * A quarantined event counts as settled -- the server will never take it, so
     * waiting would keep the row forever. Deleting the job without its events
     * leaves them orphaned, which is unbounded growth in the very table
     * retention exists to bound.
     */
    @Transaction
    suspend fun purgeSettled(shiftId: String) {
        val jobIds = settledJobIds(shiftId)
        if (jobIds.isEmpty()) return
        deleteEventsOf(jobIds)
        deleteJobs(jobIds)
    }

    @Query(
        "SELECT jobId FROM product_label_jobs WHERE shiftId = :shiftId AND status = 'completed' AND NOT EXISTS (" +
            "SELECT 1 FROM product_label_events WHERE product_label_events.jobId = product_label_jobs.jobId " +
            "AND ackedAt IS NULL AND quarantineCode IS NULL) AND NOT EXISTS (SELECT 1 FROM validation_occurrences o WHERE o.shiftId=product_label_jobs.shiftId AND o.codeHash=product_label_jobs.codeHash AND o.scannedAt=product_label_jobs.acceptedAt AND o.outcome IN ('pending','conflict'))",
    )
    suspend fun settledJobIds(shiftId: String): List<String>

    /** Every completed, fully-answered job on the device, whatever shift it belongs to. */
    @Transaction
    suspend fun purgeSettledEverywhere() {
        val jobIds = settledJobIdsEverywhere()
        if (jobIds.isEmpty()) return
        deleteEventsOf(jobIds)
        deleteJobs(jobIds)
    }

    @Query(
        "SELECT jobId FROM product_label_jobs WHERE status = 'completed' AND NOT EXISTS (" +
            "SELECT 1 FROM product_label_events WHERE product_label_events.jobId = product_label_jobs.jobId " +
            "AND ackedAt IS NULL AND quarantineCode IS NULL) AND NOT EXISTS (SELECT 1 FROM validation_occurrences o WHERE o.shiftId=product_label_jobs.shiftId AND o.codeHash=product_label_jobs.codeHash AND o.scannedAt=product_label_jobs.acceptedAt AND o.outcome IN ('pending','conflict'))",
    )
    suspend fun settledJobIdsEverywhere(): List<String>

    @Query("DELETE FROM product_label_events WHERE jobId IN (:jobIds)")
    suspend fun deleteEventsOf(jobIds: List<String>)

    @Query("DELETE FROM product_label_jobs WHERE jobId IN (:jobIds)")
    suspend fun deleteJobs(jobIds: List<String>)

    /** What the close screen warns about; it never blocks on them. */
    @Query("SELECT COUNT(*) FROM product_label_jobs WHERE shiftId = :shiftId AND status <> 'completed'")
    suspend fun outstandingCount(shiftId: String): Int

    @Query("UPDATE product_label_jobs SET lastFailure = :reason WHERE jobId = :jobId")
    suspend fun setLastFailure(jobId: String, reason: String?)

    @Query("DELETE FROM product_label_jobs")
    suspend fun clear()
}

@Dao
interface ProductLabelEventDao {
    @Insert
    suspend fun insert(event: ProductLabelEventEntity)

    /**
     * Grouped by job and strictly by sequence within one, so a limited batch is
     * always a PREFIX of each job's events.
     *
     * Deliberately not ordered by `occurredAt`: a device clock that steps
     * backwards -- an NTP correction mid-shift -- would then put event 2 ahead
     * of event 1, and a batch cut by the limit could carry the second without
     * the first. The server refuses a gap, so that whole job would be
     * quarantined. Order across jobs does not matter: each carries its own
     * sequence.
     */
    @Query(
        "SELECT * FROM product_label_events WHERE ackedAt IS NULL AND quarantineCode IS NULL " +
            "ORDER BY jobId, sequence LIMIT :limit",
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

    /** The newest event's payload, which is where an attention state keeps its reason. */
    @Query("SELECT payloadJson FROM product_label_events WHERE jobId = :jobId ORDER BY sequence DESC LIMIT 1")
    suspend fun lastPayload(jobId: String): String?

    @Query("SELECT COUNT(*) FROM product_label_events WHERE quarantineCode IS NOT NULL")
    fun observeQuarantinedCount(): Flow<Int>

    @Query("DELETE FROM product_label_events")
    suspend fun clear()
}
