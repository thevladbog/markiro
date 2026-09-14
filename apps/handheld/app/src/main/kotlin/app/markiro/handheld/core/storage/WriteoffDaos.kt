package app.markiro.handheld.core.storage

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

@Dao
interface WriteoffOutboxDao {
    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insert(row: WriteoffOutboxEntity)

    @Query("SELECT * FROM writeoff_outbox WHERE state = 'pending' ORDER BY deviceSeq")
    suspend fun pending(): List<WriteoffOutboxEntity>

    /** The engine sends one document at a time and never needs the other bodies in memory. */
    @Query("SELECT * FROM writeoff_outbox WHERE state = 'pending' ORDER BY deviceSeq LIMIT 1")
    suspend fun oldestPending(): WriteoffOutboxEntity?

    @Query("SELECT COUNT(*) FROM writeoff_outbox WHERE state = 'pending'")
    fun observePendingCount(): Flow<Int>

    @Query("SELECT * FROM writeoff_outbox ORDER BY deviceSeq DESC LIMIT :limit")
    fun observeRecent(limit: Int): Flow<List<WriteoffOutboxEntity>>

    @Query("SELECT * FROM writeoff_outbox WHERE documentId = :id")
    fun observe(id: String): Flow<WriteoffOutboxEntity?>

    @Query("SELECT * FROM writeoff_outbox WHERE documentId = :id")
    suspend fun get(id: String): WriteoffOutboxEntity?

    @Query("UPDATE writeoff_outbox SET state = 'sent', orderNo = :orderNo, acceptedCount = :accepted, conflictsJson = :conflicts, lastAttemptAt = :at WHERE documentId = :id")
    suspend fun markSent(id: String, orderNo: String, accepted: Int, conflicts: String, at: String)

    @Query("UPDATE writeoff_outbox SET state = 'rejected', conflictsJson = :conflicts, lastAttemptAt = :at WHERE documentId = :id")
    suspend fun markRejected(id: String, conflicts: String, at: String)

    @Query("UPDATE writeoff_outbox SET lastAttemptAt = :at WHERE documentId = :id")
    suspend fun touch(id: String, at: String)

    /** History keeps the newest `keep` settled rows; pending rows are never pruned. */
    @Query(
        "DELETE FROM writeoff_outbox WHERE state != 'pending' AND documentId NOT IN " +
            "(SELECT documentId FROM writeoff_outbox WHERE state != 'pending' ORDER BY deviceSeq DESC LIMIT :keep)",
    )
    suspend fun pruneSettledBeyond(keep: Int)

    @Query("DELETE FROM writeoff_outbox")
    suspend fun clear()
}

@Dao
interface WriteoffReasonDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(rows: List<WriteoffReasonEntity>)

    @Query("DELETE FROM writeoff_reasons")
    suspend fun clear()

    @Transaction
    suspend fun replaceAll(rows: List<WriteoffReasonEntity>) {
        clear()
        insertAll(rows)
    }

    @Query("SELECT * FROM writeoff_reasons ORDER BY sortOrder, name")
    suspend fun all(): List<WriteoffReasonEntity>

    @Query("SELECT * FROM writeoff_reasons ORDER BY sortOrder, name")
    fun observeAll(): Flow<List<WriteoffReasonEntity>>
}

@Dao
interface WriteoffProductDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(rows: List<WriteoffProductEntity>)

    @Query("DELETE FROM writeoff_products")
    suspend fun clear()

    @Transaction
    suspend fun replaceAll(rows: List<WriteoffProductEntity>) {
        clear()
        insertAll(rows)
    }

    @Query("SELECT * FROM writeoff_products WHERE gtin14 = :gtin14")
    suspend fun byGtin(gtin14: String): WriteoffProductEntity?

    @Query("SELECT * FROM writeoff_products WHERE id = :id")
    suspend fun byId(id: String): WriteoffProductEntity?

    @Query("SELECT COUNT(*) FROM writeoff_products")
    suspend fun count(): Int
}

@Dao
interface WriteoffPermissionDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(rows: List<WriteoffPermissionEntity>)

    @Query("DELETE FROM writeoff_permissions")
    suspend fun clear()

    @Transaction
    suspend fun replaceAll(rows: List<WriteoffPermissionEntity>) {
        clear()
        insertAll(rows)
    }

    @Query("SELECT * FROM writeoff_permissions WHERE employeeId = :employeeId")
    suspend fun get(employeeId: String): WriteoffPermissionEntity?

    @Query("SELECT * FROM writeoff_permissions WHERE employeeId = :employeeId")
    fun observe(employeeId: String): Flow<WriteoffPermissionEntity?>
}

@Dao
interface WriteoffBoxDao {
    @Upsert
    suspend fun upsert(row: WriteoffBoxEntity)

    @Query("DELETE FROM writeoff_boxes WHERE sscc = :sscc")
    suspend fun remove(sscc: String)

    @Query("SELECT * FROM writeoff_boxes WHERE sscc = :sscc")
    suspend fun bySscc(sscc: String): WriteoffBoxEntity?

    @Query("SELECT COUNT(*) FROM writeoff_boxes")
    suspend fun count(): Int

    @Query("DELETE FROM writeoff_boxes")
    suspend fun clear()
}
