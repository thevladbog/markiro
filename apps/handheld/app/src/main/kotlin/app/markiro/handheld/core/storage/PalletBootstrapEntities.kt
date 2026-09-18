package app.markiro.handheld.core.storage

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Transaction
import kotlinx.coroutines.flow.Flow

/** `GET /station/pallet-bootstrap` products; replaced wholesale on each refresh. */
@Entity(tableName = "pallet_products", indices = [Index(value = ["gtin14"])])
data class PalletProductEntity(
    @PrimaryKey val id: String,
    val gtin14: String,
    val name: String,
    val printName: String?,
    val shelfLifeDays: Int?,
    val palletBoxCapacity: Int?,
    val chzProductGroupCode: Int?,
)

@Entity(tableName = "pallet_permissions")
data class PalletPermissionEntity(@PrimaryKey val employeeId: String, val canBuildPallets: Boolean)

/** `key` is `org` or `category:<chzProductGroupCode>`; `specJson` is the label spec as the server sent it. */
@Entity(tableName = "pallet_label_templates")
data class PalletLabelTemplateEntity(@PrimaryKey val key: String, val specJson: String) {
    companion object {
        const val ORG = "org"

        fun category(code: Int) = "category:$code"
    }
}

@Dao
interface PalletProductDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(rows: List<PalletProductEntity>)

    @Query("DELETE FROM pallet_products")
    suspend fun clear()

    @Transaction
    suspend fun replaceAll(rows: List<PalletProductEntity>) {
        clear()
        insertAll(rows)
    }

    @Query("SELECT * FROM pallet_products WHERE id = :id")
    suspend fun byId(id: String): PalletProductEntity?

    @Query("SELECT COUNT(*) FROM pallet_products")
    suspend fun count(): Int
}

@Dao
interface PalletPermissionDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(rows: List<PalletPermissionEntity>)

    @Query("DELETE FROM pallet_permissions")
    suspend fun clear()

    @Transaction
    suspend fun replaceAll(rows: List<PalletPermissionEntity>) {
        clear()
        insertAll(rows)
    }

    @Query("SELECT * FROM pallet_permissions WHERE employeeId = :employeeId")
    suspend fun get(employeeId: String): PalletPermissionEntity?

    @Query("SELECT * FROM pallet_permissions WHERE employeeId = :employeeId")
    fun observe(employeeId: String): Flow<PalletPermissionEntity?>
}

@Dao
interface PalletLabelTemplateDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(rows: List<PalletLabelTemplateEntity>)

    @Query("DELETE FROM pallet_label_templates")
    suspend fun clear()

    @Transaction
    suspend fun replaceAll(rows: List<PalletLabelTemplateEntity>) {
        clear()
        insertAll(rows)
    }

    @Query("SELECT * FROM pallet_label_templates WHERE `key` = :key")
    suspend fun get(key: String): PalletLabelTemplateEntity?
}
