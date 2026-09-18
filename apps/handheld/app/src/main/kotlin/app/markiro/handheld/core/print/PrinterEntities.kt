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

    @Query("SELECT printers.* FROM printers JOIN printer_assignments ON printers.id = printer_assignments.printerId WHERE purpose = :purpose")
    suspend fun assigned(purpose: String): PrinterEntity?

    @Query("SELECT * FROM printer_assignments ORDER BY purpose")
    fun observeAssignments(): Flow<List<PrinterAssignmentEntity>>

    @Upsert
    suspend fun assign(assignment: PrinterAssignmentEntity)

    @Query("SELECT * FROM printers WHERE id = :id")
    suspend fun get(id: String): PrinterEntity?

    @Query("SELECT * FROM print_destinations WHERE purpose = :purpose AND jobId = :jobId AND attemptId = :attemptId")
    suspend fun destination(purpose: String, jobId: String, attemptId: String): PrintDestinationEntity?

    @Query("SELECT * FROM print_destinations WHERE " +
        "(purpose = 'box' AND jobId = :boxId AND attemptId = 'initial') OR " +
        "(purpose = 'pallet' AND jobId = :palletId AND attemptId = 'initial') OR " +
        "(purpose = 'duplicate' AND jobId = :duplicateId AND attemptId = (SELECT attemptId FROM product_label_jobs WHERE jobId = :duplicateId))")
    fun observeActiveDestinations(boxId: String?, palletId: String?, duplicateId: String?): Flow<List<PrintDestinationEntity>>

    @Query("SELECT * FROM print_destinations WHERE attemptId = 'initial' AND " +
        "((purpose = 'box' AND jobId IN (SELECT boxId FROM boxes WHERE closedAt IS NOT NULL AND printState <> 'printed' AND disassembledAt IS NULL)) OR " +
        "(purpose = 'pallet' AND jobId IN (SELECT palletId FROM pallets WHERE closedAt IS NOT NULL AND printState <> 'printed' AND disassembledAt IS NULL)))")
    fun observeQueuedDestinations(): Flow<List<PrintDestinationEntity>>

    @Upsert
    suspend fun saveDestination(destination: PrintDestinationEntity)

    @Query("SELECT * FROM printers WHERE selected = 1 LIMIT 1")
    suspend fun selected(): PrinterEntity?

    @Query("SELECT * FROM printers WHERE selected = 1 LIMIT 1")
    fun observeSelected(): Flow<PrinterEntity?>

    /** The same printer added twice is the same printer; its address is what identifies it. */
    @Query("SELECT * FROM printers WHERE transport = :transport AND address = :address LIMIT 1")
    suspend fun findByAddress(transport: String, address: String): PrinterEntity?

    @Upsert
    suspend fun upsert(printer: PrinterEntity)

    /** One statement, so exactly one row is selected and the rest are cleared together. */
    @Query("UPDATE printers SET selected = (id = :id)")
    suspend fun select(id: String)

    @Query("UPDATE printers SET lastStatus = :status, lastSeenAt = :at WHERE id = :id AND address = :address AND transport = :transport AND language = :language AND dpi = :dpi")
    suspend fun setSnapshotStatus(id: String, address: String, transport: String, language: String, dpi: Int, status: String, at: Long)

    @Query("UPDATE printers SET lastStatus = :status, lastSeenAt = :at WHERE id = :id")
    suspend fun setStatus(id: String, status: String?, at: Long)

    @Query("DELETE FROM printers WHERE id = :id")
    suspend fun delete(id: String)

    @Query("DELETE FROM printers")
    suspend fun clear()
}
