package app.markiro.handheld.core.storage

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Transaction

/** One badge of an operator on the host (an operator may hold several; the cloud's `operators.badgeHash` is one). A PHC verifier, never the code. */
@Entity(tableName = "operator_badges", indices = [Index(value = ["operatorId"])])
data class OperatorBadgeEntity(
    @PrimaryKey val badgeId: String,
    val operatorId: String,
    val badgePhc: String,
    val label: String?,
)

@Dao
interface OperatorBadgeDao {
    @Query("SELECT * FROM operator_badges")
    suspend fun all(): List<OperatorBadgeEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(row: OperatorBadgeEntity)

    @Query("DELETE FROM operator_badges WHERE badgeId = :badgeId")
    suspend fun delete(badgeId: String)

    @Query("DELETE FROM operator_badges WHERE operatorId = :operatorId")
    suspend fun deleteOf(operatorId: String)

    @Query("DELETE FROM operator_badges")
    suspend fun clear()
}
