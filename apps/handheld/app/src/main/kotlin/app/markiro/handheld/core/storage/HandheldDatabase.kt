package app.markiro.handheld.core.storage

import androidx.room.Database
import androidx.room.RoomDatabase
import app.markiro.handheld.core.print.PrinterDao
import app.markiro.handheld.core.print.PrinterEntity

@Database(
    entities = [
        DeviceConfigEntity::class,
        DeviceRecoveryEntity::class,
        OperatorEntity::class,
        ShiftEntity::class,
        CodeEntity::class,
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
        BoxEntity::class,
        SsccRangeEntity::class,
        ProductLabelJobEntity::class,
        ProductLabelEventEntity::class,
        BoxExceptionEntity::class,
        PalletEntity::class,
        PalletExceptionEntity::class,
    ],
    version = 11,
    exportSchema = false,
)
abstract class HandheldDatabase : RoomDatabase() {
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
    abstract fun scanEventDao(): ScanEventDao
    abstract fun outboxDao(): OutboxDao
    abstract fun conflictDao(): ConflictDao
    abstract fun shiftCloseDao(): ShiftCloseDao
    abstract fun metaDao(): MetaDao
}
