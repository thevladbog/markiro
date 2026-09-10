package app.markiro.handheld.core.storage

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

@Dao
interface DeviceConfigDao {
    @Query("SELECT * FROM device_config WHERE id = 1")
    fun observe(): Flow<DeviceConfigEntity?>

    @Query("SELECT * FROM device_config WHERE id = 1")
    suspend fun get(): DeviceConfigEntity?

    @Query("SELECT COUNT(*) FROM device_config")
    suspend fun count(): Int

    @Upsert
    suspend fun upsert(config: DeviceConfigEntity)

    @Query("DELETE FROM device_config")
    suspend fun clear()
}

@Dao
interface OperatorDao {
    @Query("SELECT * FROM operators")
    suspend fun all(): List<OperatorEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(rows: List<OperatorEntity>)

    @Query("DELETE FROM operators")
    suspend fun clear()

    @Transaction
    suspend fun replaceAll(rows: List<OperatorEntity>) {
        clear()
        insertAll(rows)
    }
}
