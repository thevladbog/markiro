package app.markiro.handheld.core.grants

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Index

@Entity(tableName = "grant_state")
data class GrantStateEntity(
    @PrimaryKey val id: Int = 1, val ownerKey: String, val generation: Long,
    val epoch: Long, val mode: String, val requestedSequence: Long, val installedSequence: Long,
    val keysetRevision: String, val retiredKids: String, val keysetJson: String,
    val serverMs: Long, val monotonicMs: Long, val bootId: String,
    val serverHighWater: Long, val wallHighWater: Long, val clockValid: Boolean,
)
@Entity(tableName = "grant_tokens")
data class GrantTokenEntity(@PrimaryKey val slot: String, val ownerKey: String, val generation: Long, val epoch: Long,
    val taskKind: String, val taskId: String, val snapshotDigest: String, val kid: String, val compact: String)
@Entity(tableName = "grant_counters", primaryKeys = ["ownerKey", "taskKind", "taskId", "snapshotDigest", "budgetId"])
data class GrantCounterEntity(val ownerKey: String, val taskKind: String, val taskId: String, val snapshotDigest: String, val budgetId: String, val consumed: Long)
@Entity(tableName = "grant_evidence", primaryKeys = ["ownerKey", "eventId"])
data class GrantEvidenceEntity(val ownerKey: String, val eventId: String, val taskKind: String, val taskId: String,
    val snapshotDigest: String, val payloadDigest: String, val costs: String, val grantId: String?, val compact: String?,
    val mode: String, val reason: String?, val trustedTime: Long?, val generation: Long, val epoch: Long)
@Entity(tableName = "grant_task_bindings", primaryKeys = ["ownerKey", "taskKind", "taskId"])
data class GrantTaskBindingEntity(val ownerKey: String, val taskKind: String, val taskId: String, val snapshotDigest: String, val canonical: String, val executionFingerprint: String)
@Entity(tableName = "grant_task_provenance", primaryKeys = ["taskKind", "taskId"])
data class GrantTaskProvenanceEntity(val taskKind: String, val taskId: String, val ownerKey: String, val generation: Long, val original: String)
@Entity(tableName = "grant_readiness_outbox", indices = [Index(value = ["ownerKey", "generation"])])
data class GrantReadinessOutboxEntity(
    @PrimaryKey val requestId: String, val ownerKey: String, val generation: Long,
    val bodyJson: String, val attempts: Long = 0,
)

@Dao
interface GrantDao {
    @Query("SELECT * FROM grant_state WHERE id = 1") fun observeState(): kotlinx.coroutines.flow.Flow<GrantStateEntity?>
    @Query("SELECT * FROM grant_state WHERE id = 1") suspend fun state(): GrantStateEntity?
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun state(value: GrantStateEntity)
    @Query("SELECT * FROM grant_tokens WHERE slot = :slot") suspend fun token(slot: String): GrantTokenEntity?
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun token(value: GrantTokenEntity)
    @Query("SELECT * FROM grant_counters WHERE ownerKey=:owner AND taskKind=:kind AND taskId=:task AND snapshotDigest=:digest") suspend fun counters(owner: String, kind: String, task: String, digest: String): List<GrantCounterEntity>
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun counter(value: GrantCounterEntity)
    @Query("SELECT * FROM grant_evidence WHERE ownerKey=:owner AND eventId=:event") suspend fun evidence(owner: String, event: String): GrantEvidenceEntity?
    @Query("SELECT * FROM grant_evidence ORDER BY eventId") suspend fun evidence(): List<GrantEvidenceEntity>
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun evidence(value: GrantEvidenceEntity)
    @Query("SELECT * FROM grant_task_bindings WHERE ownerKey=:owner AND taskKind=:kind AND taskId=:task") suspend fun binding(owner: String, kind: String, task: String): GrantTaskBindingEntity?
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun binding(value: GrantTaskBindingEntity)
    @Query("SELECT * FROM grant_task_provenance") suspend fun provenances(): List<GrantTaskProvenanceEntity>
    @Query("SELECT * FROM grant_task_provenance WHERE taskKind=:kind AND taskId=:task") suspend fun provenance(kind: String, task: String): GrantTaskProvenanceEntity?
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun provenance(value: GrantTaskProvenanceEntity)
    @Insert(onConflict = OnConflictStrategy.IGNORE) suspend fun readiness(value: GrantReadinessOutboxEntity): Long
    @Query("SELECT * FROM grant_readiness_outbox WHERE ownerKey=:owner AND generation=:generation ORDER BY requestId") suspend fun pendingReadiness(owner: String, generation: Long): List<GrantReadinessOutboxEntity>
    @Query("UPDATE grant_readiness_outbox SET attempts=attempts+1 WHERE requestId=:requestId AND ownerKey=:owner AND generation=:generation") suspend fun markReadinessAttempt(requestId: String, owner: String, generation: Long): Int
    @Query("DELETE FROM grant_readiness_outbox WHERE requestId=:requestId AND ownerKey=:owner AND generation=:generation") suspend fun acknowledgeReadiness(requestId: String, owner: String, generation: Long): Int
}
