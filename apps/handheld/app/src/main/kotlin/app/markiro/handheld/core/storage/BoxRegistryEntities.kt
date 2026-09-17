package app.markiro.handheld.core.storage

import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Upsert

/**
 * Closed boxes from `GET /station/box-registry`, keyed by SSCC. Shared by the
 * write-off mode (contents as `01…21…` keys) and the pallet mode (pallet
 * membership, spec §2.4). `localPalletId` is this device's own claim, set on
 * scan and cleared on removal or once the server's answer lands, so a second
 * scan before the next registry refresh is still caught.
 */
@Entity(tableName = "box_registry", indices = [Index(value = ["localPalletId"])])
data class BoxRegistryEntity(
    @PrimaryKey val sscc: String,
    val boxId: String,
    val productId: String,
    val bottleCount: Int,
    val contentKeysJson: String,
    val updatedAt: String,
    val palletId: String? = null,
    /** Raw 18 digits; null while that pallet is open. */
    val palletSscc: String? = null,
    /**
     * Declared with a SQL default because SQLite cannot add a NOT NULL column
     * without one; Room compares defaults, so the entity has to say the same.
     */
    @ColumnInfo(defaultValue = "0") val palletActive: Boolean = false,
    val closedAt: String? = null,
    /** Civil `YYYY-MM-DD` of the owner shift, or null. */
    val productionDate: String? = null,
    val localPalletId: String? = null,
)

@Dao
interface BoxRegistryDao {
    @Upsert
    suspend fun upsert(row: BoxRegistryEntity)

    @Query("DELETE FROM box_registry WHERE sscc = :sscc")
    suspend fun remove(sscc: String)

    @Query("SELECT * FROM box_registry WHERE sscc = :sscc")
    suspend fun bySscc(sscc: String): BoxRegistryEntity?

    @Query("SELECT COUNT(*) FROM box_registry")
    suspend fun count(): Int

    /** Rows this device has claimed for an open local pallet; a full re-walk must not lose them. */
    @Query("SELECT * FROM box_registry WHERE localPalletId IS NOT NULL")
    suspend fun claimed(): List<BoxRegistryEntity>

    @Query("UPDATE box_registry SET localPalletId = :localPalletId WHERE sscc = :sscc")
    suspend fun claim(sscc: String, localPalletId: String)

    @Query("UPDATE box_registry SET localPalletId = NULL WHERE sscc = :sscc")
    suspend fun release(sscc: String)

    @Query("UPDATE box_registry SET localPalletId = NULL WHERE localPalletId = :localPalletId")
    suspend fun releaseAll(localPalletId: String)

    @Query("DELETE FROM box_registry")
    suspend fun clear()
}
