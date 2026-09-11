package app.markiro.handheld.core.storage

import androidx.room.Database
import androidx.room.RoomDatabase
import app.markiro.handheld.core.print.PrinterDao
import app.markiro.handheld.core.print.PrinterEntity

@Database(
    entities = [
        DeviceConfigEntity::class,
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
    ],
    version = 7,
    exportSchema = false,
)
abstract class HandheldDatabase : RoomDatabase() {
    abstract fun printerDao(): PrinterDao
    abstract fun boxDao(): BoxDao
    abstract fun ssccPoolDao(): SsccPoolDao
    abstract fun productLabelJobDao(): ProductLabelJobDao
    abstract fun productLabelEventDao(): ProductLabelEventDao

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
