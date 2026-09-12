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

/** Version 2 (shift validation) → 3 (inventory check). Additive; shift tables are untouched. */
val MIGRATION_2_3 = object : Migration(2, 3) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("ALTER TABLE `device_config` ADD COLUMN `activeInventoryId` TEXT")
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `inventory_tasks` (`inventoryId` TEXT NOT NULL, `inventoryNumber` TEXT NOT NULL, " +
                "`productId` TEXT NOT NULL, `productName` TEXT NOT NULL, `productPrintName` TEXT, `gtin14` TEXT NOT NULL, " +
                "`mode` TEXT NOT NULL, `lineId` TEXT NOT NULL, `lineName` TEXT NOT NULL, `productionDateFrom` TEXT NOT NULL, " +
                "`productionDateTo` TEXT NOT NULL, `boxCapacity` INTEGER NOT NULL, `snapshotId` TEXT NOT NULL, " +
                "`snapshotFixedAt` TEXT NOT NULL, `contentDigest` TEXT NOT NULL, `combinedDigest` TEXT NOT NULL, " +
                "`codeCount` INTEGER NOT NULL, `expectedCount` INTEGER NOT NULL, `state` TEXT NOT NULL, `stagingCursor` TEXT, " +
                "`stagedCount` INTEGER NOT NULL, `joinedAt` INTEGER, `leftAt` INTEGER, PRIMARY KEY(`inventoryId`))",
        )
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `inventory_snapshot_codes` (`snapshotId` TEXT NOT NULL, `codeHash` TEXT NOT NULL, " +
                "`canonicalRaw` TEXT NOT NULL, `gtin14` TEXT NOT NULL, `serial` TEXT NOT NULL, `sourceStatus` TEXT NOT NULL, " +
                "`sourceState` TEXT, `sourceProductionDate` TEXT, `parentSscc` TEXT, `expected` INTEGER NOT NULL, " +
                "`protected` INTEGER NOT NULL, PRIMARY KEY(`snapshotId`, `codeHash`))",
        )
        db.execSQL(
            "CREATE INDEX IF NOT EXISTS `index_inventory_snapshot_codes_snapshotId_parentSscc` " +
                "ON `inventory_snapshot_codes` (`snapshotId`, `parentSscc`)",
        )
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `inventory_terminal_state` (`inventoryId` TEXT NOT NULL, `snapshotId` TEXT NOT NULL, " +
                "`operatorId` TEXT, `activeProductionDate` TEXT, `nextDeviceSequence` INTEGER NOT NULL, `progressCursor` TEXT, " +
                "`progressResultRevision` INTEGER NOT NULL, `updatedAt` TEXT NOT NULL, PRIMARY KEY(`inventoryId`))",
        )
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `inventory_events` (`eventId` TEXT NOT NULL, `inventoryId` TEXT NOT NULL, " +
                "`snapshotId` TEXT NOT NULL, `deviceSequence` INTEGER NOT NULL, `operatorId` TEXT NOT NULL, `scannedAt` TEXT NOT NULL, " +
                "`kind` TEXT NOT NULL, `normalizedIdentity` TEXT NOT NULL, `codeHash` TEXT, `canonicalRaw` TEXT, " +
                "`activeProductionDate` TEXT NOT NULL, `localVerdict` TEXT NOT NULL, `claimedCount` INTEGER NOT NULL, " +
                "`winnerEventId` TEXT, `winnerDeviceId` TEXT, `winnerScannedAt` TEXT, `serverStatus` TEXT, PRIMARY KEY(`eventId`))",
        )
        db.execSQL(
            "CREATE UNIQUE INDEX IF NOT EXISTS `index_inventory_events_inventoryId_deviceSequence` " +
                "ON `inventory_events` (`inventoryId`, `deviceSequence`)",
        )
        db.execSQL(
            "CREATE INDEX IF NOT EXISTS `index_inventory_events_inventoryId_normalizedIdentity` " +
                "ON `inventory_events` (`inventoryId`, `normalizedIdentity`)",
        )
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `inventory_results` (`inventoryId` TEXT NOT NULL, `snapshotId` TEXT NOT NULL, " +
                "`codeHash` TEXT NOT NULL, `firstAcceptedEventId` TEXT NOT NULL, `winningDeviceId` TEXT NOT NULL, " +
                "`winningScannedAt` TEXT NOT NULL, `observedProductionDate` TEXT, `classification` TEXT NOT NULL, " +
                "`source` TEXT NOT NULL, `updatedAt` TEXT NOT NULL, PRIMARY KEY(`inventoryId`, `codeHash`))",
        )
        db.execSQL(
            "CREATE INDEX IF NOT EXISTS `index_inventory_results_inventoryId_firstAcceptedEventId` " +
                "ON `inventory_results` (`inventoryId`, `firstAcceptedEventId`)",
        )
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `inventory_outbox` (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, " +
                "`inventoryId` TEXT NOT NULL, `snapshotId` TEXT NOT NULL, `eventId` TEXT NOT NULL, `deviceSequence` INTEGER NOT NULL, " +
                "`payloadJson` TEXT NOT NULL, `createdAt` TEXT NOT NULL)",
        )
        db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS `index_inventory_outbox_eventId` ON `inventory_outbox` (`eventId`)")
    }
}

/** Version 3 (inventory check) → 4 (printing). Additive only; printers are new and nothing else moves. */
val MIGRATION_3_4 = object : Migration(3, 4) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `printers` (`id` TEXT NOT NULL, `name` TEXT NOT NULL, `transport` TEXT NOT NULL, " +
                "`address` TEXT NOT NULL, `language` TEXT NOT NULL, `dpi` INTEGER NOT NULL, `selected` INTEGER NOT NULL, " +
                "`lastStatus` TEXT, `lastSeenAt` INTEGER, PRIMARY KEY(`id`))",
        )
    }
}

/** Aggregation: boxes, the device's own SSCC ranges, and the columns both need. */
val MIGRATION_4_5 = object : Migration(4, 5) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `boxes` (`boxId` TEXT NOT NULL, `shiftId` TEXT NOT NULL, `sscc` TEXT, " +
                "`openedAt` TEXT NOT NULL, `closedAt` TEXT, `operatorId` TEXT, `printState` TEXT NOT NULL, " +
                "`printReason` TEXT, `ackedAt` TEXT, PRIMARY KEY(`boxId`))",
        )
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_boxes_shiftId_closedAt` ON `boxes` (`shiftId`, `closedAt`)")
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `sscc_pool` (`issuerPrefix` TEXT NOT NULL, `extensionDigit` INTEGER NOT NULL, " +
                "`fromSerial` INTEGER NOT NULL, `toSerial` INTEGER NOT NULL, `nextSerial` INTEGER NOT NULL, " +
                "PRIMARY KEY(`issuerPrefix`, `extensionDigit`, `fromSerial`))",
        )
        db.execSQL("ALTER TABLE `codes_mirror` ADD COLUMN `boxId` TEXT")
        db.execSQL("ALTER TABLE `outbox` ADD COLUMN `boxId` TEXT")
        db.execSQL("ALTER TABLE `shift_mirror` ADD COLUMN `boxLabelTemplate` TEXT")
        db.execSQL("ALTER TABLE `shift_mirror` ADD COLUMN `shelfLifeDays` INTEGER")
        db.execSQL("ALTER TABLE `shift_mirror` ADD COLUMN `egaisCode` TEXT")
        db.execSQL("ALTER TABLE `shift_mirror` ADD COLUMN `ssccIssuerPrefix` TEXT")
    }
}

/** Duplicate printing: the shift's policy snapshot, its jobs and their events. */
val MIGRATION_5_6 = object : Migration(5, 6) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("ALTER TABLE `shift_mirror` ADD COLUMN `duplicateVerification` TEXT")
        db.execSQL("ALTER TABLE `shift_mirror` ADD COLUMN `duplicateTemplate` TEXT")
        db.execSQL("ALTER TABLE `shift_mirror` ADD COLUMN `duplicateTemplateDigest` TEXT")
        db.execSQL("ALTER TABLE `shift_mirror` ADD COLUMN `duplicatePolicyRevision` TEXT")
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `product_label_jobs` (`jobId` TEXT NOT NULL, `shiftId` TEXT NOT NULL, " +
                "`codeHash` TEXT NOT NULL, `canonicalRaw` TEXT NOT NULL, `acceptedAt` TEXT NOT NULL, " +
                "`operatorId` TEXT NOT NULL, `policyRevision` TEXT NOT NULL, `templateDigest` TEXT NOT NULL, " +
                "`payloadDigest` TEXT NOT NULL, `bytesBase64` TEXT, `bytesDigest` TEXT NOT NULL, " +
                "`language` TEXT NOT NULL, `dpi` INTEGER NOT NULL, `latestSequence` INTEGER NOT NULL, " +
                "`attemptId` TEXT NOT NULL, `attemptNo` INTEGER NOT NULL, `attemptState` TEXT NOT NULL, " +
                "`verification` TEXT NOT NULL, `verificationOutcome` TEXT NOT NULL, `status` TEXT NOT NULL, " +
                "`lastFailure` TEXT, PRIMARY KEY(`jobId`))",
        )
        db.execSQL(
            "CREATE INDEX IF NOT EXISTS `index_product_label_jobs_shiftId_status` ON `product_label_jobs` (`shiftId`, `status`)",
        )
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `product_label_events` (`eventId` TEXT NOT NULL, `jobId` TEXT NOT NULL, " +
                "`sequence` INTEGER NOT NULL, `kind` TEXT NOT NULL, `payloadJson` TEXT NOT NULL, " +
                "`occurredAt` TEXT NOT NULL, `ackedAt` TEXT, `quarantineCode` TEXT, PRIMARY KEY(`eventId`))",
        )
        db.execSQL(
            "CREATE UNIQUE INDEX IF NOT EXISTS `index_product_label_events_jobId_sequence` " +
                "ON `product_label_events` (`jobId`, `sequence`)",
        )
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_product_label_events_ackedAt` ON `product_label_events` (`ackedAt`)")
    }
}

val MIGRATION_6_7 = object : Migration(6, 7) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("ALTER TABLE `boxes` ADD COLUMN `disassembledAt` TEXT")
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `box_exceptions` (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, " +
                "`kind` TEXT NOT NULL, `boxId` TEXT NOT NULL, `codeHash` TEXT, `targetScannedAt` TEXT, " +
                "`shiftId` TEXT NOT NULL, `operatorId` TEXT, `reason` TEXT, `occurredAt` TEXT NOT NULL, " +
                "`payloadJson` TEXT NOT NULL, `afterOutboxId` INTEGER NOT NULL, `ackedAt` TEXT)",
        )
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_box_exceptions_ackedAt` ON `box_exceptions` (`ackedAt`)")
    }
}

/** Recovery metadata is additive: operational payloads and local sequence are untouched. */
val MIGRATION_7_8 = object : Migration(7, 8) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("CREATE TABLE IF NOT EXISTS `device_recovery` (`id` INTEGER NOT NULL, `serverOrigin` TEXT, `tenantId` TEXT, `deviceId` TEXT, `kind` TEXT, `generation` INTEGER NOT NULL, `phase` TEXT NOT NULL, `pendingId` TEXT, PRIMARY KEY(`id`))")
    }
}

/**
 * Pallets (06d): boxes per pallet. Additive only -- `palletCapacity`'s old
 * units-valued column is left in place and unread; see `ShiftEntities.kt`.
 *
 * Numbered 8 -> 9 rather than 6 -> 7: versions 7 and 8 belong to the shipped
 * box-exceptions and device-recovery migrations above, and an installed
 * terminal has already applied them.
 */
val MIGRATION_8_9 = object : Migration(8, 9) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("ALTER TABLE `shift_mirror` ADD COLUMN `palletBoxCapacity` INTEGER")
    }
}

/**
 * Pallets (06d) continued: the pallets table itself, `boxes.palletId`, and the
 * pallet label template spec the close screen will read. `palletBoxCapacity`
 * already landed in MIGRATION_8_9 -- this migration does not touch it, and it
 * does not rename or drop the dead `palletCapacity` column either; see
 * `ShiftEntities.kt` for why leaving that column in place, unread, is the
 * chosen trade over rebuilding the table.
 *
 * `pallet_exceptions` is created here too, ahead of the handheld's exceptions
 * screen (a later task in this slice). Nothing reads or writes it yet --
 * deliberately, not an oversight -- so there is no Room entity or DAO for it
 * until that screen lands and actually needs one.
 */
val MIGRATION_9_10 = object : Migration(9, 10) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `pallets` (`palletId` TEXT NOT NULL, `shiftId` TEXT NOT NULL, " +
                "`terminalId` TEXT, `sscc` TEXT, `openedAt` TEXT NOT NULL, `closedAt` TEXT, `operatorId` TEXT, " +
                "`printState` TEXT NOT NULL, `printReason` TEXT, `ackedAt` TEXT, PRIMARY KEY(`palletId`))",
        )
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_pallets_shiftId_closedAt` ON `pallets` (`shiftId`, `closedAt`)")
        db.execSQL("ALTER TABLE `boxes` ADD COLUMN `palletId` TEXT")
        db.execSQL("ALTER TABLE `shift_mirror` ADD COLUMN `palletLabelTemplateSpec` TEXT")
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `pallet_exceptions` (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, " +
                "`kind` TEXT NOT NULL, `palletId` TEXT NOT NULL, `shiftId` TEXT NOT NULL, `terminalId` TEXT, " +
                "`operatorId` TEXT, `reason` TEXT NOT NULL, `occurredAt` TEXT NOT NULL)",
        )
    }
}
