package app.markiro.handheld.core.print

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

/**
 * A printer this handheld can send to. Device-local by the same rule the station states in
 * `apps/station/src/lib/hardware-config.ts`: held on the device, not the server, so it configures
 * and runs offline. Language and resolution are per printer, because a plant can run a belt printer
 * and a line printer side by side.
 */
@Entity(tableName = "printers")
data class PrinterEntity(
    @PrimaryKey val id: String,
    val name: String,
    /** `wifi` or `bluetooth`. */
    val transport: String,
    /** `host:port` for Wi-Fi, the device address for Bluetooth. */
    val address: String,
    /** `zpl` or `tspl`. */
    val language: String,
    /** 203 or 300. */
    val dpi: Int,
    val selected: Boolean,
    /** What the printer last reported, for the list subtitle. */
    val lastStatus: String?,
    val lastSeenAt: Long?,
)

@Dao
interface PrinterDao {
    @Query("SELECT * FROM printers ORDER BY name")
    fun observeAll(): Flow<List<PrinterEntity>>

    @Query("SELECT * FROM printers ORDER BY name")
    suspend fun all(): List<PrinterEntity>

    @Query("SELECT * FROM printers WHERE selected = 1 LIMIT 1")
    suspend fun selected(): PrinterEntity?

    @Query("SELECT * FROM printers WHERE selected = 1 LIMIT 1")
    fun observeSelected(): Flow<PrinterEntity?>

    @Upsert
    suspend fun upsert(printer: PrinterEntity)

    /** One statement, so exactly one row is selected and the rest are cleared together. */
    @Query("UPDATE printers SET selected = (id = :id)")
    suspend fun select(id: String)

    @Query("UPDATE printers SET lastStatus = :status, lastSeenAt = :at WHERE id = :id")
    suspend fun setStatus(id: String, status: String?, at: Long)

    @Query("DELETE FROM printers WHERE id = :id")
    suspend fun delete(id: String)

    @Query("DELETE FROM printers")
    suspend fun clear()
}
