package app.markiro.handheld.core.storage

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query

/**
 * A record for the host, frozen: `body` is the JSON of one record exactly as it will be sent (and sent again), `recordId` its UUID
 * (the host's idempotency key), `seq` its place in the queue. `sourceKind` + `sourceKey` name the Room row it was made of, so the
 * freezer never makes two records of one row. `state`: `queued`, or `quarantined` with the host's `reason` (a refused record stays
 * for support, it never blocks the others). An acknowledged record is deleted together with the acknowledgement of its source row.
 */
@Entity(
    tableName = "host_outbox",
    indices = [
        Index(value = ["recordId"], unique = true),
        Index(value = ["sourceKind", "sourceKey"], unique = true),
        Index(value = ["state", "seq"]),
    ],
)
data class HostOutboxEntity(
    @PrimaryKey(autoGenerate = true) val seq: Long = 0,
    val recordId: String,
    /** `facts` (`POST /v1/device/facts`) or `events` (`POST /v1/device/pallet-events`). */
    val target: String,
    val kind: String,
    val sourceKind: String,
    val sourceKey: String,
    val body: String,
    val state: String,
    val reason: String?,
    val createdAt: String,
)

@Dao
interface HostOutboxDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(row: HostOutboxEntity): Long

    @Query("SELECT * FROM host_outbox WHERE state = 'queued' ORDER BY seq LIMIT :limit")
    suspend fun queued(limit: Int): List<HostOutboxEntity>

    @Query("SELECT COUNT(*) FROM host_outbox WHERE state = 'queued'")
    suspend fun queuedCount(): Int

    @Query("SELECT COUNT(*) FROM host_outbox WHERE state = 'quarantined'")
    fun observeQuarantinedCount(): kotlinx.coroutines.flow.Flow<Int>

    @Query("SELECT * FROM host_outbox WHERE state = 'quarantined' ORDER BY seq")
    fun observeQuarantined(): kotlinx.coroutines.flow.Flow<List<HostOutboxEntity>>

    @Query("SELECT COUNT(*) FROM host_outbox WHERE sourceKind = :kind AND sourceKey = :key")
    suspend fun frozen(kind: String, key: String): Int

    @Query("SELECT sourceKey FROM host_outbox WHERE sourceKind = :kind")
    suspend fun frozenKeys(kind: String): List<String>

    @Query("UPDATE host_outbox SET state = 'quarantined', reason = :reason WHERE recordId = :recordId")
    suspend fun quarantine(recordId: String, reason: String)

    @Query("DELETE FROM host_outbox WHERE recordId = :recordId")
    suspend fun delete(recordId: String)

    @Query("DELETE FROM host_outbox WHERE state = 'quarantined' AND recordId = :recordId")
    suspend fun dismiss(recordId: String)

    @Query("DELETE FROM host_outbox")
    suspend fun clear()
}
