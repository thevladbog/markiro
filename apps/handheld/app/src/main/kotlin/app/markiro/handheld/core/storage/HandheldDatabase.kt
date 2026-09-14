package app.markiro.handheld.core.storage

import app.markiro.handheld.core.grants.*
import androidx.room.Database
import androidx.room.RoomDatabase
import app.markiro.handheld.core.print.PrinterAssignmentEntity
import app.markiro.handheld.core.print.PrintDestinationEntity
import app.markiro.handheld.core.print.PrinterDao
import app.markiro.handheld.core.print.PrinterEntity

@Database(
    entities = [
        GrantStateEntity::class, GrantTokenEntity::class, GrantCounterEntity::class, GrantEvidenceEntity::class, GrantTaskBindingEntity::class, GrantTaskProvenanceEntity::class, GrantReadinessOutboxEntity::class,
        DeviceConfigEntity::class,
        DeviceRecoveryEntity::class,
        OperatorEntity::class,
        ShiftEntity::class,
        CodeEntity::class,
        ValidationOccurrenceEntity::class,
        ValidationHistoryEntity::class,
        ValidationHistoryPublication::class,
        ScanEventEntity::class,
        OutboxEntity::class,
        ConflictEntity::class,
        ShiftCloseEntity::class,
        MetaEntity::class,
        InventoryTaskEntity::class,
        InventorySnapshotCodeEntity::class,
        InventoryTerminalStateEntity::class,
        InventoryEventEntity::class,
        InventoryResultEntity::class,
        InventoryOutboxEntity::class,
        PrinterEntity::class,
        PrinterAssignmentEntity::class,
        PrintDestinationEntity::class,
        BoxEntity::class,
        SsccRangeEntity::class,
        ProductLabelJobEntity::class,
        ProductLabelEventEntity::class,
        BoxExceptionEntity::class,
        PalletEntity::class,
        PalletExceptionEntity::class,
        WriteoffOutboxEntity::class,
        WriteoffReasonEntity::class,
        WriteoffProductEntity::class,
        WriteoffPermissionEntity::class,
        WriteoffBoxEntity::class,
    ],
    version = HANDHELD_DATABASE_VERSION,
    exportSchema = false,
)
abstract class HandheldDatabase : RoomDatabase() {
    val grants: GrantRepository by lazy { GrantRepository(this) }
    abstract fun grantDao(): GrantDao
    private var coordinator: DeviceRecovery? = null
    val recovery: DeviceRecovery get() = checkNotNull(coordinator) { "Device recovery must initialize before work" }
    internal fun attachRecovery(value: DeviceRecovery) {
        check(coordinator == null || coordinator === value)
        coordinator = value
    }
    abstract fun deviceRecoveryDao(): DeviceRecoveryDao
    abstract fun printerDao(): PrinterDao
    abstract fun boxDao(): BoxDao
    abstract fun ssccPoolDao(): SsccPoolDao
    abstract fun palletDao(): PalletDao
    abstract fun productLabelJobDao(): ProductLabelJobDao
    abstract fun productLabelEventDao(): ProductLabelEventDao
    abstract fun boxExceptionDao(): BoxExceptionDao
    abstract fun palletExceptionDao(): PalletExceptionDao

    abstract fun inventoryTaskDao(): InventoryTaskDao
    abstract fun inventorySnapshotCodeDao(): InventorySnapshotCodeDao
    abstract fun inventoryTerminalStateDao(): InventoryTerminalStateDao
    abstract fun inventoryEventDao(): InventoryEventDao
    abstract fun inventoryResultDao(): InventoryResultDao
    abstract fun inventoryOutboxDao(): InventoryOutboxDao
    abstract fun deviceConfigDao(): DeviceConfigDao
    abstract fun operatorDao(): OperatorDao
    abstract fun shiftDao(): ShiftDao
    abstract fun codeDao(): CodeDao
    abstract fun validationDao(): ValidationDao
    abstract fun scanEventDao(): ScanEventDao
    abstract fun outboxDao(): OutboxDao
    abstract fun conflictDao(): ConflictDao
    abstract fun shiftCloseDao(): ShiftCloseDao
    abstract fun metaDao(): MetaDao

    abstract fun writeoffOutboxDao(): WriteoffOutboxDao
    abstract fun writeoffReasonDao(): WriteoffReasonDao
    abstract fun writeoffProductDao(): WriteoffProductDao
    abstract fun writeoffPermissionDao(): WriteoffPermissionDao
    abstract fun writeoffBoxDao(): WriteoffBoxDao
}

const val HANDHELD_DATABASE_VERSION = 16
