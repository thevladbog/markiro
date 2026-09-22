package app.markiro.handheld.core.storage

import androidx.room.*
import kotlinx.coroutines.flow.Flow

@Entity(tableName = "replacement_drain")
data class ReplacementDrainEntity(
    @PrimaryKey val id: Int = 1,
    val ownerKey: String, val generation: Long, val intentJson: String,
    val state: String = "active", val resumeTasksJson: String,
    val reportSequence: Long = 0, val reportJson: String? = null,
    val closureJson: String? = null, val acknowledgedAt: String? = null,
) {
    val blocked: Boolean get() = state != "cancelled" || acknowledgedAt == null
}

@Dao
interface ReplacementDao {
    @Query("SELECT * FROM replacement_drain WHERE id=1") suspend fun get(): ReplacementDrainEntity?
    @Query("SELECT * FROM replacement_drain WHERE id=1") fun observe(): Flow<ReplacementDrainEntity?>
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun put(row: ReplacementDrainEntity)
    @Query("DELETE FROM grant_tokens WHERE taskKind='device'") suspend fun retireDeviceGrants()
}
