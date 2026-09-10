package app.markiro.handheld.core.storage

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

@Dao
interface InventoryTaskDao {
    @Query("SELECT * FROM inventory_tasks ORDER BY inventoryNumber")
    fun observeAll(): Flow<List<InventoryTaskEntity>>

    @Query("SELECT * FROM inventory_tasks WHERE inventoryId = :id")
    suspend fun get(id: String): InventoryTaskEntity?

    @Query("SELECT * FROM inventory_tasks WHERE inventoryId = :id")
    fun observe(id: String): Flow<InventoryTaskEntity?>

    @Upsert
    suspend fun upsert(task: InventoryTaskEntity)

    @Query("UPDATE inventory_tasks SET stagingCursor = :cursor, stagedCount = :staged WHERE inventoryId = :id")
    suspend fun setStaging(id: String, cursor: String?, staged: Int)

    @Query(
        "UPDATE inventory_tasks SET state = 'active', expectedCount = :expectedCount, stagingCursor = NULL, joinedAt = :joinedAt, leftAt = NULL " +
            "WHERE inventoryId = :id",
    )
    suspend fun activate(id: String, expectedCount: Int, joinedAt: Long)

    @Query("UPDATE inventory_tasks SET state = :state WHERE inventoryId = :id")
    suspend fun setState(id: String, state: String)

    @Query("UPDATE inventory_tasks SET joinedAt = :at, leftAt = NULL WHERE inventoryId = :id")
    suspend fun setJoinedAt(id: String, at: Long)

    @Query("UPDATE inventory_tasks SET leftAt = :at WHERE inventoryId = :id")
    suspend fun setLeftAt(id: String, at: Long?)

    @Query("DELETE FROM inventory_tasks WHERE inventoryId = :id")
    suspend fun delete(id: String)

    @Query("DELETE FROM inventory_tasks")
    suspend fun clear()
}

@Dao
interface InventorySnapshotCodeDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertAll(rows: List<InventorySnapshotCodeEntity>)

    @Query("SELECT * FROM inventory_snapshot_codes WHERE snapshotId = :snapshotId AND codeHash = :hash")
    suspend fun get(snapshotId: String, hash: String): InventorySnapshotCodeEntity?

    @Query("SELECT * FROM inventory_snapshot_codes WHERE snapshotId = :snapshotId AND parentSscc = :sscc ORDER BY codeHash")
    suspend fun children(snapshotId: String, sscc: String): List<InventorySnapshotCodeEntity>

    @Query("SELECT COUNT(*) FROM inventory_snapshot_codes WHERE snapshotId = :snapshotId")
    suspend fun count(snapshotId: String): Int

    @Query("SELECT COUNT(*) FROM inventory_snapshot_codes WHERE snapshotId = :snapshotId AND expected = 1 AND protected = 0")
    suspend fun countExpected(snapshotId: String): Int

    /** Strict `codeHash` order after `after` (pass "" for the first page): the content digest is recomputed in this order. */
    @Query("SELECT * FROM inventory_snapshot_codes WHERE snapshotId = :snapshotId AND codeHash > :after ORDER BY codeHash LIMIT :limit")
    suspend fun pageAfter(snapshotId: String, after: String, limit: Int): List<InventorySnapshotCodeEntity>

    @Query("DELETE FROM inventory_snapshot_codes WHERE snapshotId = :snapshotId")
    suspend fun deleteSnapshot(snapshotId: String)

    @Query("DELETE FROM inventory_snapshot_codes")
    suspend fun clear()
}

@Dao
interface InventoryTerminalStateDao {
    @Query("SELECT * FROM inventory_terminal_state WHERE inventoryId = :id")
    suspend fun get(id: String): InventoryTerminalStateEntity?

    @Query("SELECT * FROM inventory_terminal_state WHERE inventoryId = :id")
    fun observe(id: String): Flow<InventoryTerminalStateEntity?>

    @Upsert
    suspend fun upsert(state: InventoryTerminalStateEntity)

    @Query("UPDATE inventory_terminal_state SET activeProductionDate = :date, operatorId = :operatorId, updatedAt = :at WHERE inventoryId = :id")
    suspend fun setActiveDate(id: String, date: String, operatorId: String, at: String)

    @Query("UPDATE inventory_terminal_state SET progressCursor = :cursor, progressResultRevision = :revision WHERE inventoryId = :id")
    suspend fun setProgress(id: String, cursor: String?, revision: Long)

    @Query("DELETE FROM inventory_terminal_state WHERE inventoryId = :id")
    suspend fun delete(id: String)

    @Query("DELETE FROM inventory_terminal_state")
    suspend fun clear()
}

@Dao
interface InventoryEventDao {
    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insert(event: InventoryEventEntity)

    @Query("SELECT * FROM inventory_events WHERE eventId = :eventId")
    suspend fun get(eventId: String): InventoryEventEntity?

    @Query("SELECT EXISTS(SELECT 1 FROM inventory_events WHERE inventoryId = :id)")
    suspend fun hasAny(id: String): Boolean

    /** Earliest unknown observation of an identity (the winner a later scan duplicates). */
    @Query(
        "SELECT * FROM inventory_events WHERE inventoryId = :id AND normalizedIdentity = :identity AND localVerdict = 'unknown' " +
            "ORDER BY deviceSequence LIMIT 1",
    )
    suspend fun firstUnknown(id: String, identity: String): InventoryEventEntity?

    @Query("SELECT * FROM inventory_events WHERE inventoryId = :id ORDER BY deviceSequence DESC LIMIT :limit")
    fun observeRecent(id: String, limit: Int): Flow<List<InventoryEventEntity>>

    @Query("UPDATE inventory_events SET serverStatus = :status WHERE eventId = :eventId")
    suspend fun setServerStatus(eventId: String, status: String)

    @Query("SELECT COUNT(*) FROM inventory_events WHERE inventoryId = :id AND serverStatus = :status")
    fun observeCountByServerStatus(id: String, status: String): Flow<Int>

    /** Unknown identities of this device not (yet) explained by a result row from the server. */
    @Query(
        "SELECT COUNT(DISTINCT normalizedIdentity) FROM inventory_events WHERE inventoryId = :id AND localVerdict = 'unknown' " +
            "AND (codeHash IS NULL OR codeHash NOT IN (SELECT codeHash FROM inventory_results WHERE inventoryId = :id))",
    )
    fun observeUnknownIdentities(id: String): Flow<Int>

    @Query("DELETE FROM inventory_events WHERE inventoryId = :id")
    suspend fun deleteForInventory(id: String)

    @Query("DELETE FROM inventory_events")
    suspend fun clear()
}

@Dao
interface InventoryResultDao {
    /** -1 when the code already has a winner. */
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertIgnore(row: InventoryResultEntity): Long

    @Upsert
    suspend fun upsert(row: InventoryResultEntity)

    @Query("SELECT * FROM inventory_results WHERE inventoryId = :id AND codeHash = :hash")
    suspend fun get(id: String, hash: String): InventoryResultEntity?

    @Query("SELECT * FROM inventory_results WHERE inventoryId = :id AND codeHash IN (:hashes)")
    suspend fun forHashes(id: String, hashes: List<String>): List<InventoryResultEntity>

    @Query("SELECT * FROM inventory_results WHERE inventoryId = :id AND firstAcceptedEventId = :eventId")
    suspend fun forEvent(id: String, eventId: String): List<InventoryResultEntity>

    @Query("DELETE FROM inventory_results WHERE inventoryId = :id AND codeHash = :hash")
    suspend fun delete(id: String, hash: String)

    @Query("SELECT COUNT(*) FROM inventory_results WHERE inventoryId = :id AND classification = :classification")
    fun observeCount(id: String, classification: String): Flow<Int>

    @Query("SELECT COUNT(*) FROM inventory_results WHERE inventoryId = :id AND winningDeviceId = :deviceId")
    fun observeCountForDevice(id: String, deviceId: String): Flow<Int>

    @Query("DELETE FROM inventory_results WHERE inventoryId = :id")
    suspend fun deleteForInventory(id: String)

    @Query("DELETE FROM inventory_results")
    suspend fun clear()
}

@Dao
interface InventoryOutboxDao {
    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insert(row: InventoryOutboxEntity): Long

    @Query("SELECT * FROM inventory_outbox WHERE inventoryId = :id ORDER BY deviceSequence LIMIT :limit")
    suspend fun head(id: String, limit: Int): List<InventoryOutboxEntity>

    @Query("SELECT * FROM inventory_outbox WHERE inventoryId = :id AND id <= :ceiling ORDER BY deviceSequence LIMIT :limit")
    suspend fun headThrough(id: String, ceiling: Long, limit: Int): List<InventoryOutboxEntity>

    @Query("SELECT COUNT(*) FROM inventory_outbox WHERE inventoryId = :id AND id > :afterId")
    suspend fun countAfter(id: String, afterId: Long): Int

    @Query("SELECT COUNT(*) FROM inventory_outbox WHERE inventoryId = :id")
    fun observeCount(id: String): Flow<Int>

    @Query("SELECT COUNT(*) FROM inventory_outbox")
    fun observeTotal(): Flow<Int>

    @Query("SELECT COUNT(*) FROM inventory_outbox WHERE inventoryId = :id")
    suspend fun count(id: String): Int

    @Query("DELETE FROM inventory_outbox WHERE id IN (:ids)")
    suspend fun deleteIds(ids: List<Long>)

    @Query("DELETE FROM inventory_outbox WHERE inventoryId = :id")
    suspend fun deleteForInventory(id: String)

    @Query("DELETE FROM inventory_outbox")
    suspend fun clear()
}
