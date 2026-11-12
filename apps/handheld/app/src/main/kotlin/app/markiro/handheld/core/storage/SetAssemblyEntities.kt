package app.markiro.handheld.core.storage

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.PrimaryKey
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

@Entity(tableName = "set_assemblies", indices = [Index("shiftId")])
data class SetAssemblyEntity(
    @PrimaryKey val id: String,
    val shiftId: String,
    val status: String,
)

@Entity(tableName = "set_assembly_claims")
data class SetAssemblyClaimEntity(@PrimaryKey val codeHash: String, val setId: String)

data class SetAssemblyCounts(val finished: Int, val queued: Int, val conflicts: Int)

@Dao
interface SetAssemblyDao {
    @Insert
    suspend fun insert(assembly: SetAssemblyEntity)

    @Insert
    suspend fun claim(codes: List<SetAssemblyClaimEntity>)

    @Query("SELECT codeHash FROM set_assembly_claims WHERE codeHash IN (:hashes)")
    suspend fun claimed(hashes: List<String>): List<String>

    @Query("UPDATE set_assemblies SET status = :status WHERE id = :id")
    suspend fun settle(id: String, status: String)

    @Query("SELECT COUNT(*) FROM set_assemblies WHERE shiftId = :shiftId AND status IN ('queued','accepted')")
    suspend fun countFinished(shiftId: String): Int

    @Query(
        "SELECT COUNT(CASE WHEN status IN ('queued','accepted') THEN 1 END) AS finished, " +
            "COUNT(CASE WHEN status = 'queued' THEN 1 END) AS queued, " +
            "COUNT(CASE WHEN status = 'conflict' THEN 1 END) AS conflicts " +
            "FROM set_assemblies WHERE shiftId = :shiftId",
    )
    fun observeCounts(shiftId: String): Flow<SetAssemblyCounts>
}
