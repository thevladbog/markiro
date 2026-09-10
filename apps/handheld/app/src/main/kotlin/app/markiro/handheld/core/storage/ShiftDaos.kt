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

    @Query("SELECT COUNT(*) FROM codes_mirror WHERE shiftId = :shiftId")
    suspend fun countForShift(shiftId: String): Int

    @Query("SELECT COUNT(*) FROM codes_mirror WHERE shiftId = :shiftId")
    fun observeCountForShift(shiftId: String): Flow<Int>

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

    @Query("SELECT COUNT(*) FROM outbox")
    fun count(): Flow<Int>

    @Query("SELECT COUNT(*) FROM outbox")
    suspend fun countNow(): Int

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

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun put(row: MetaEntity)

    @Query("DELETE FROM meta WHERE `key` = :key")
    suspend fun remove(key: String)

    @Query("DELETE FROM meta")
    suspend fun clear()
}
