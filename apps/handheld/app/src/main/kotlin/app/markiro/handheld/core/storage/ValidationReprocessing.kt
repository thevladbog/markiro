package app.markiro.handheld.core.storage

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Update
import kotlinx.coroutines.flow.Flow

/** A scan occurrence is independent of effective original ownership and survives release. */
@Entity(tableName = "validation_occurrences", primaryKeys = ["shiftId", "codeHash"], indices = [Index("codeHash")])
data class ValidationOccurrenceEntity(
    val shiftId: String, val codeHash: String, val scannedAt: String, val raw: String,
    val gtin14: String, val serial: String, val operatorId: String?, val deviceId: String,
    val sourceShiftId: String?, val sourceShiftNumber: String?,
    val kind: String, val outcome: String = "pending", val lastReceipt: String? = null,
    /** Prevent a late/replayed receipt restoring original ownership after a local release. */
    val originalProjected: Boolean = kind == "first_accepted",
)
/** One activation pointer per entered shift; staged pages never participate in admission. */
@Entity(tableName = "validation_history_publications")
data class ValidationHistoryPublication(
    @PrimaryKey val shiftId: String, val productId: String, val publication: String,
    val snapshot: String, val fetchedAt: String, val expiresAt: String,
)
@Entity(tableName = "validation_history", primaryKeys = ["publication", "codeHash", "kind", "shiftId"])
data class ValidationHistoryEntity(
    val publication: String, val codeHash: String, val kind: String, val shiftId: String,
    val shiftNumber: String, val shiftStatus: String, val scannedAt: String,
)

// DISTINCT union counts a provisional original only once. A released ordinary acceptance is
// evidence, not an effective blocker. Reprocessed occurrences survive release of their source.
const val EFFECTIVE_CODES = "SELECT codeHash, shiftId FROM codes_mirror c WHERE NOT EXISTS (" +
    "SELECT 1 FROM validation_occurrences o WHERE o.shiftId=c.shiftId AND o.codeHash=c.codeHash " +
    "AND o.scannedAt=c.scannedAt AND o.outcome='conflict') UNION SELECT codeHash, shiftId FROM " +
    "validation_occurrences WHERE kind='reprocessed' AND outcome<>'conflict'"

@Dao
interface ValidationDao {
    @Insert suspend fun insert(row: ValidationOccurrenceEntity)
    @Update suspend fun update(row: ValidationOccurrenceEntity)
    @Query("SELECT * FROM validation_occurrences WHERE shiftId=:shiftId AND codeHash=:hash")
    suspend fun get(shiftId: String, hash: String): ValidationOccurrenceEntity?
    @Query("SELECT * FROM validation_occurrences WHERE (shiftId>:afterShift OR (shiftId=:afterShift AND codeHash>:afterHash)) ORDER BY shiftId, codeHash LIMIT :limit")
    suspend fun page(afterShift: String, afterHash: String, limit: Int): List<ValidationOccurrenceEntity>
    @Query("SELECT COUNT(*) FROM validation_occurrences WHERE outcome='pending'")
    fun pendingCount(): Flow<Int>
    @Query("SELECT COUNT(*) FROM validation_occurrences WHERE shiftId=:shiftId AND outcome=:outcome")
    fun observeCount(shiftId: String, outcome: String): Flow<Int>
    @Query("SELECT EXISTS(SELECT 1 FROM (" + EFFECTIVE_CODES + ") e LEFT JOIN shift_mirror s ON s.id=e.shiftId WHERE e.codeHash=:hash AND e.shiftId<>:shiftId AND COALESCE(s.status,'active')<>'closed' AND e.shiftId<>COALESCE(:closedSource,''))")
    suspend fun otherActive(shiftId: String, hash: String, closedSource: String?): Boolean
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun stage(rows: List<ValidationHistoryEntity>)
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun publish(row: ValidationHistoryPublication)
    @Query("SELECT * FROM validation_history_publications WHERE shiftId=:shiftId")
    suspend fun publication(shiftId: String): ValidationHistoryPublication?
    @Query("SELECT * FROM validation_history_publications WHERE shiftId=:shiftId")
    fun observePublication(shiftId: String): Flow<ValidationHistoryPublication?>
    @Query("SELECT h.* FROM validation_history h JOIN validation_history_publications p ON p.publication=h.publication WHERE p.shiftId=:shiftId AND h.codeHash=:hash")
    suspend fun history(shiftId: String, hash: String): List<ValidationHistoryEntity>
    @Query("DELETE FROM validation_history WHERE publication=:publication AND publication NOT IN (SELECT publication FROM validation_history_publications)")
    suspend fun dropStage(publication: String)
    @Query("DELETE FROM validation_history WHERE publication NOT IN (SELECT publication FROM validation_history_publications)")
    suspend fun dropUnpublished()
}
