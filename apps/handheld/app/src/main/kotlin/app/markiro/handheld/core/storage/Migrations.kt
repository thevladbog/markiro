package app.markiro.handheld.core.storage

import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

/** Version 1 (foundation) → 2 (shift validation). Additive only; pairing and the roster survive. */
val MIGRATION_1_2 = object : Migration(1, 2) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("ALTER TABLE `device_config` ADD COLUMN `activeShiftId` TEXT")
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `shift_mirror` (`id` TEXT NOT NULL, `number` TEXT NOT NULL, `status` TEXT NOT NULL, " +
                "`mode` TEXT NOT NULL, `productId` TEXT NOT NULL, `productName` TEXT, `productPrintName` TEXT, `productGtin14` TEXT, " +
                "`lineId` TEXT, `lineName` TEXT, `counterpartyName` TEXT, `plannedQty` INTEGER, `plannedDate` TEXT, `productionDate` TEXT, " +
                "`boxCapacity` INTEGER, `palletCapacity` INTEGER, `palletsEnabled` INTEGER NOT NULL, `validationPrintMode` TEXT NOT NULL, " +
                "`closePolicyKind` TEXT, `closeOwnerDeviceId` TEXT, `openedAt` TEXT, `listFetchedAt` INTEGER NOT NULL, " +
                "`bundleFetchedAt` INTEGER, `enteredAt` INTEGER, `leftAt` INTEGER, PRIMARY KEY(`id`))",
        )
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `codes_mirror` (`codeHash` TEXT NOT NULL, `shiftId` TEXT NOT NULL, `gtin14` TEXT NOT NULL, " +
                "`serial` TEXT NOT NULL, `scannedAt` TEXT NOT NULL, PRIMARY KEY(`codeHash`))",
        )
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `scan_events` (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `shiftId` TEXT NOT NULL, " +
                "`raw` TEXT NOT NULL, `verdict` TEXT NOT NULL, `scannedAt` TEXT NOT NULL, `operatorId` TEXT, `codeHash` TEXT)",
        )
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `outbox` (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `shiftId` TEXT NOT NULL, " +
                "`raw` TEXT NOT NULL, `verdict` TEXT NOT NULL, `scannedAt` TEXT NOT NULL, `operatorId` TEXT, `codeHash` TEXT, " +
                "`gtin14` TEXT, `serial` TEXT)",
        )
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `conflicts_mirror` (`codeHash` TEXT NOT NULL, `winningTerminalId` TEXT, " +
                "`winningScannedAt` TEXT NOT NULL, `detectedAt` TEXT NOT NULL, PRIMARY KEY(`codeHash`))",
        )
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `shift_close_outbox` (`eventId` TEXT NOT NULL, `shiftId` TEXT NOT NULL, `operatorId` TEXT, " +
                "`plannedQtySnapshot` INTEGER, `actualQty` INTEGER NOT NULL, `closedBoxCount` INTEGER NOT NULL, `reasonCode` TEXT, " +
                "`closedAt` TEXT NOT NULL, `state` TEXT NOT NULL, `conflictCode` TEXT, `lastCheckedAt` TEXT, PRIMARY KEY(`eventId`))",
        )
        db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS `index_shift_close_outbox_shiftId` ON `shift_close_outbox` (`shiftId`)")
        db.execSQL("CREATE TABLE IF NOT EXISTS `meta` (`key` TEXT NOT NULL, `value` TEXT NOT NULL, PRIMARY KEY(`key`))")
    }
}
