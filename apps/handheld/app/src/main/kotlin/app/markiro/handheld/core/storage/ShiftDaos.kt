package app.markiro.handheld.core.storage

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

@Dao
interface ShiftDao {
    @Query("SELECT * FROM shift_mirror ORDER BY plannedDate DESC, number DESC")
    fun observeAll(): Flow<List<ShiftEntity>>

    @Query("SELECT * FROM shift_mirror")
    suspend fun all(): List<ShiftEntity>

    @Query("SELECT * FROM shift_mirror WHERE id = :id")
    suspend fun get(id: String): ShiftEntity?

    @Query("SELECT * FROM shift_mirror WHERE id = :id")
    fun observe(id: String): Flow<ShiftEntity?>

    @Upsert
    suspend fun upsert(shift: ShiftEntity)

    @Upsert
    suspend fun upsertAll(shifts: List<ShiftEntity>)

    @Query("UPDATE shift_mirror SET status = :status WHERE id = :id")
    suspend fun setStatus(id: String, status: String)

    @Query("UPDATE shift_mirror SET leftAt = :at WHERE id = :id")
    suspend fun setLeftAt(id: String, at: Long?)

    @Query("DELETE FROM shift_mirror WHERE bundleFetchedAt IS NULL AND id NOT IN (:keep)")
    suspend fun dropListedExcept(keep: List<String>)

    @Query("DELETE FROM shift_mirror")
    suspend fun clear()
}

@Dao
interface CodeDao {
    @Query("SELECT * FROM codes_mirror WHERE codeHash = :hash")
    suspend fun get(hash: String): CodeEntity?

    /** ABORT on a duplicate hash: the caller turns the constraint failure into a `duplicate` verdict. */
    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insert(code: CodeEntity)

    @Query("SELECT COUNT(*) FROM (" + EFFECTIVE_CODES + ") WHERE shiftId = :shiftId")
    suspend fun countForShift(shiftId: String): Int

    /**
     * The codes THIS shift's own scans hold that the host does not count for this device (the station's `SHIFT_LOST_CODES_SQL`): the host gave the
     * code to another terminal (`conflict`: the hash is in `conflicts_mirror`, the code stays in `codes_mirror`) or refused the record (`rejected`:
     * its `host_outbox` record is quarantined and the scan stays in `outbox`). They are inside the others' part of a shared shift's total or in
     * nobody's, so `SharedShiftRules` takes them off this device's own count (its `lost`). A code is the shift's own when `codes_mirror` holds it
     * for this shift: the same hash accepted in another shift, or only reprocessed here, never counts. A code in both kinds counts once.
     * The station's third kind, a code the host displaced since, has no counterpart: the handheld reads no displacement notices.
     */
    @Query(
        "SELECT COUNT(*) FROM (" + EFFECTIVE_CODES + ") e WHERE e.shiftId = :shiftId " +
            "AND EXISTS (SELECT 1 FROM codes_mirror c WHERE c.codeHash = e.codeHash AND c.shiftId = e.shiftId) " +
            "AND (e.codeHash IN (SELECT codeHash FROM conflicts_mirror) " +
            "OR e.codeHash IN (SELECT o.codeHash FROM outbox o JOIN host_outbox h ON h.sourceKind = 'scan' AND h.sourceKey = CAST(o.id AS TEXT) " +
            "WHERE h.state = 'quarantined' AND o.shiftId = :shiftId AND o.codeHash IS NOT NULL))",
    )
    suspend fun lostForShift(shiftId: String): Int

    /** [lostForShift] kept current: the work screen's strip must move when the host answers `conflict` or `rejected` for a scan. */
    @Query(
        "SELECT COUNT(*) FROM (" + EFFECTIVE_CODES + ") e WHERE e.shiftId = :shiftId " +
            "AND EXISTS (SELECT 1 FROM codes_mirror c WHERE c.codeHash = e.codeHash AND c.shiftId = e.shiftId) " +
            "AND (e.codeHash IN (SELECT codeHash FROM conflicts_mirror) " +
            "OR e.codeHash IN (SELECT o.codeHash FROM outbox o JOIN host_outbox h ON h.sourceKind = 'scan' AND h.sourceKey = CAST(o.id AS TEXT) " +
            "WHERE h.state = 'quarantined' AND o.shiftId = :shiftId AND o.codeHash IS NOT NULL))",
    )
    fun observeLostForShift(shiftId: String): Flow<Int>

    @Query("SELECT COUNT(*) FROM (" + EFFECTIVE_CODES + ") WHERE shiftId = :shiftId")
    fun observeCountForShift(shiftId: String): Flow<Int>

    /** The undo target: the most recent accepted code of this box. */
    @Query("SELECT * FROM codes_mirror WHERE boxId = :boxId ORDER BY scannedAt DESC, codeHash DESC LIMIT 1")
    suspend fun lastIn(boxId: String): CodeEntity?

    @Query("DELETE FROM codes_mirror WHERE codeHash=:hash AND shiftId=:shiftId AND scannedAt=:at")
    suspend fun deleteExact(shiftId: String, hash: String, at: String)

    @Query("DELETE FROM codes_mirror WHERE codeHash = :codeHash")
    suspend fun delete(codeHash: String)

    @Query("DELETE FROM codes_mirror WHERE boxId = :boxId")
    suspend fun deleteInBox(boxId: String): Int

    @Query("DELETE FROM codes_mirror")
    suspend fun clear()
}

@Dao
interface ScanEventDao {
    @Insert
    suspend fun insert(event: ScanEventEntity): Long

    @Query("SELECT * FROM scan_events WHERE shiftId = :shiftId ORDER BY id DESC LIMIT :limit")
    fun observeRecent(shiftId: String, limit: Int): Flow<List<ScanEventEntity>>

    @Query("SELECT COUNT(*) FROM scan_events WHERE shiftId = :shiftId AND verdict = :verdict")
    fun observeCount(shiftId: String, verdict: String): Flow<Int>

    @Query("SELECT COUNT(*) FROM scan_events WHERE shiftId = :shiftId AND verdict = :verdict")
    suspend fun count(shiftId: String, verdict: String): Int

    @Query("DELETE FROM scan_events")
    suspend fun clear()
}

@Dao
interface OutboxDao {
    @Insert
    suspend fun insert(row: OutboxEntity): Long

    @Query("SELECT * FROM outbox ORDER BY id LIMIT :limit")
    suspend fun head(limit: Int): List<OutboxEntity>

    @Query("SELECT * FROM outbox WHERE id <= :ceiling ORDER BY id LIMIT :limit")
    suspend fun headThrough(ceiling: Long, limit: Int): List<OutboxEntity>

    @Query("DELETE FROM outbox WHERE id <= :ceiling")
    suspend fun deleteThrough(ceiling: Long)

    /** One acknowledged row (the host answers per record, not per prefix). */
    @Query("DELETE FROM outbox WHERE id = :id")
    suspend fun delete(id: Long)

    @Query("SELECT COUNT(*) FROM outbox")
    fun count(): Flow<Int>

    @Query("SELECT COUNT(*) FROM outbox")
    suspend fun countNow(): Int

    /** The watermark a correction records: everything queued before it. */
    @Query("SELECT COALESCE(MAX(id), 0) FROM outbox")
    suspend fun maxId(): Long

    @Query("DELETE FROM outbox")
    suspend fun clear()
}

@Dao
interface ConflictDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertIgnore(rows: List<ConflictEntity>)

    @Query("SELECT * FROM conflicts_mirror ORDER BY detectedAt DESC")
    fun observeAll(): Flow<List<ConflictEntity>>

    @Query("SELECT COUNT(*) FROM conflicts_mirror")
    fun count(): Flow<Int>

    @Query("SELECT codeHash FROM conflicts_mirror WHERE codeHash > :after ORDER BY codeHash LIMIT :limit")
    suspend fun pageHashes(after: String, limit: Int): List<String>

    @Query("DELETE FROM conflicts_mirror WHERE codeHash IN (:hashes)")
    suspend fun delete(hashes: List<String>)

    @Query("DELETE FROM conflicts_mirror")
    suspend fun clear()
}

@Dao
interface ShiftCloseDao {
    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insert(row: ShiftCloseEntity)

    @Query("SELECT * FROM shift_close_outbox WHERE shiftId = :shiftId")
    suspend fun forShift(shiftId: String): ShiftCloseEntity?

    /** The close a host receipt names: the host knows it by this id (`HostOutboxEntity.sourceKey`). */
    @Query("SELECT * FROM shift_close_outbox WHERE eventId = :eventId")
    suspend fun forEvent(eventId: String): ShiftCloseEntity?

    @Query("SELECT * FROM shift_close_outbox WHERE shiftId = :shiftId")
    fun observeForShift(shiftId: String): Flow<ShiftCloseEntity?>

    @Query("SELECT * FROM shift_close_outbox WHERE state = 'pending' ORDER BY closedAt")
    suspend fun pending(): List<ShiftCloseEntity>

    @Query("DELETE FROM shift_close_outbox WHERE eventId = :eventId")
    suspend fun delete(eventId: String)

    @Query("UPDATE shift_close_outbox SET state = 'accepted', lastCheckedAt = :at WHERE eventId = :eventId")
    suspend fun markAccepted(eventId: String, at: String)

    @Query("UPDATE shift_close_outbox SET state = 'conflict', conflictCode = :code, lastCheckedAt = :at WHERE eventId = :eventId")
    suspend fun markConflict(eventId: String, code: String, at: String)

    @Query("DELETE FROM shift_close_outbox")
    suspend fun clear()
}

@Dao
interface MetaDao {
    @Query("SELECT value FROM meta WHERE `key` = :key")
    suspend fun get(key: String): String?

    /** Same row as [get], watched: a stamp the UI shows must move when the mirror refreshes. */
    @Query("SELECT value FROM meta WHERE `key` = :key")
    fun observe(key: String): Flow<String?>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun put(row: MetaEntity)

    @Query("DELETE FROM meta WHERE `key` = :key")
    suspend fun remove(key: String)

    @Query("SELECT * FROM meta WHERE `key` LIKE :prefix || '%'")
    suspend fun withPrefix(prefix: String): List<MetaEntity>

    @Query("DELETE FROM meta")
    suspend fun clear()
}
