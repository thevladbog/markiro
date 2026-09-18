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
 * `pallet_exceptions` is created here too, ahead of the channel that fills it.
 * The shape below is the one this migration shipped with and is NOT the shape
 * Room expects today: `MIGRATION_10_11` rebuilds the table against
 * `PalletExceptionEntity`. Leave this statement exactly as it is -- an
 * installed terminal has already run it, and rewriting an applied migration
 * only makes a fresh database look green.
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

/**
 * `pallet_exceptions` becomes a real Room table, so the pallet half of the
 * exceptions channel can be written and drained (`PalletExceptionEntity`,
 * `PalletExceptionDao`, `SyncEngine`).
 *
 * DROPPED AND RECREATED rather than ALTERed, and that is safe here for one
 * specific reason: nothing has ever written to this table. `MIGRATION_9_10`
 * created it ahead of a feature that had not landed, and it had no entity, no
 * DAO and no raw writer anywhere in the app, so on every installed terminal it
 * is empty by construction. There is no data to preserve and no ALTER chain
 * that could reach the new shape anyway -- it gains `payloadJson` NOT NULL and
 * `ackedAt`, and SQLite cannot add a NOT NULL column without a default.
 *
 * Doing nothing was not an option. Room validates the on-disk schema against
 * its entities every time it opens the database, so an upgraded terminal
 * holding the v10 shape while the entity declares the new one is an
 * `IllegalStateException` at startup on EVERY such device -- not a silent
 * problem. A clean install has the opposite failure: Room builds a fresh
 * database from the entity list, so before this version the table simply did
 * not exist there at all and the first write would have crashed.
 */
val MIGRATION_10_11 = object : Migration(10, 11) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("DROP TABLE IF EXISTS `pallet_exceptions`")
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `pallet_exceptions` (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, " +
                "`kind` TEXT NOT NULL, `palletId` TEXT NOT NULL, `shiftId` TEXT NOT NULL, `terminalId` TEXT, " +
                "`operatorId` TEXT, `reason` TEXT NOT NULL, `occurredAt` TEXT NOT NULL, " +
                "`payloadJson` TEXT NOT NULL, `ackedAt` TEXT)",
        )
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_pallet_exceptions_ackedAt` ON `pallet_exceptions` (`ackedAt`)")
    }
}

/** v12 retains the original registry and immutable scan/job bytes; only new occurrence facts are added. */
val MIGRATION_11_12 = object : Migration(11, 12) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("ALTER TABLE shift_mirror ADD COLUMN allowPreviouslyAcceptedCodes INTEGER NOT NULL DEFAULT 0")
        db.execSQL("CREATE TABLE IF NOT EXISTS validation_occurrences (shiftId TEXT NOT NULL, codeHash TEXT NOT NULL, scannedAt TEXT NOT NULL, raw TEXT NOT NULL, gtin14 TEXT NOT NULL, serial TEXT NOT NULL, operatorId TEXT, deviceId TEXT NOT NULL, sourceShiftId TEXT, sourceShiftNumber TEXT, kind TEXT NOT NULL, outcome TEXT NOT NULL, lastReceipt TEXT, originalProjected INTEGER NOT NULL, PRIMARY KEY(shiftId,codeHash))")
        db.execSQL("CREATE INDEX IF NOT EXISTS index_validation_occurrences_codeHash ON validation_occurrences(codeHash)")
        db.execSQL("CREATE TABLE IF NOT EXISTS validation_history_publications (shiftId TEXT NOT NULL PRIMARY KEY, productId TEXT NOT NULL, publication TEXT NOT NULL, snapshot TEXT NOT NULL, fetchedAt TEXT NOT NULL, expiresAt TEXT NOT NULL)")
        db.execSQL("CREATE TABLE IF NOT EXISTS validation_history (publication TEXT NOT NULL, codeHash TEXT NOT NULL, kind TEXT NOT NULL, shiftId TEXT NOT NULL, shiftNumber TEXT NOT NULL, shiftStatus TEXT NOT NULL, scannedAt TEXT NOT NULL, PRIMARY KEY(publication,codeHash,kind,shiftId))")
        // Prefer the effective registry occurrence after a legacy release/reacceptance.
        // Legacy intake already projected ordinary ownership locally. Preserve that marker to
        // prevent receipt replay restoring a released owner; no server receipt is invented.
        db.execSQL("INSERT OR IGNORE INTO validation_occurrences SELECT e.shiftId,e.codeHash,e.scannedAt,e.raw,COALESCE(c.gtin14,s.productGtin14,''),COALESCE(c.serial,''),e.operatorId,COALESCE((SELECT deviceId FROM device_config LIMIT 1),''),NULL,NULL,'first_accepted','pending',NULL,1 FROM scan_events e JOIN shift_mirror s ON s.id=e.shiftId LEFT JOIN codes_mirror c ON c.codeHash=e.codeHash AND c.shiftId=e.shiftId AND c.scannedAt=e.scannedAt WHERE s.validationPrintMode='duplicate_dm' AND e.verdict='ok' AND e.codeHash IS NOT NULL ORDER BY (c.codeHash IS NOT NULL) DESC,e.id DESC")
    }
}

/** Only the shipped selected profile receives roles. Jobs and print outcomes remain untouched. */
val MIGRATION_12_13 = object : Migration(12, 13) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("CREATE TABLE IF NOT EXISTS `printer_assignments` (`purpose` TEXT NOT NULL, `printerId` TEXT, PRIMARY KEY(`purpose`))")
        for (purpose in listOf("box", "duplicate", "pallet")) {
            db.execSQL("INSERT OR IGNORE INTO printer_assignments (purpose, printerId) VALUES (?, (SELECT id FROM printers WHERE selected = 1 ORDER BY id LIMIT 1))", arrayOf(purpose))
        }
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `print_destinations` (`purpose` TEXT NOT NULL, `jobId` TEXT NOT NULL, `attemptId` TEXT NOT NULL, " +
                "`printer_id` TEXT NOT NULL, `printer_name` TEXT NOT NULL, `printer_transport` TEXT NOT NULL, " +
                "`printer_address` TEXT NOT NULL, `printer_language` TEXT NOT NULL, `printer_dpi` INTEGER NOT NULL, " +
                "`printer_selected` INTEGER NOT NULL, `printer_lastStatus` TEXT, `printer_lastSeenAt` INTEGER, " +
                "PRIMARY KEY(`purpose`, `jobId`, `attemptId`))",
        )
    }
}

/** Add grant authorization state without rewriting any business journal or print bytes. */
val MIGRATION_13_14 = object : Migration(13, 14) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("CREATE TABLE IF NOT EXISTS grant_state (id INTEGER NOT NULL PRIMARY KEY, ownerKey TEXT NOT NULL, generation INTEGER NOT NULL, epoch INTEGER NOT NULL, mode TEXT NOT NULL, requestedSequence INTEGER NOT NULL, installedSequence INTEGER NOT NULL, keysetRevision TEXT NOT NULL, retiredKids TEXT NOT NULL, keysetJson TEXT NOT NULL, serverMs INTEGER NOT NULL, monotonicMs INTEGER NOT NULL, bootId TEXT NOT NULL, serverHighWater INTEGER NOT NULL, wallHighWater INTEGER NOT NULL, clockValid INTEGER NOT NULL)")
        db.execSQL("CREATE TABLE IF NOT EXISTS grant_tokens (slot TEXT NOT NULL PRIMARY KEY, ownerKey TEXT NOT NULL, generation INTEGER NOT NULL, epoch INTEGER NOT NULL, taskKind TEXT NOT NULL, taskId TEXT NOT NULL, snapshotDigest TEXT NOT NULL, kid TEXT NOT NULL, compact TEXT NOT NULL)")
        db.execSQL("CREATE TABLE IF NOT EXISTS grant_counters (ownerKey TEXT NOT NULL, taskKind TEXT NOT NULL, taskId TEXT NOT NULL, snapshotDigest TEXT NOT NULL, budgetId TEXT NOT NULL, consumed INTEGER NOT NULL, PRIMARY KEY(ownerKey,taskKind,taskId,snapshotDigest,budgetId))")
        db.execSQL("CREATE TABLE IF NOT EXISTS grant_evidence (ownerKey TEXT NOT NULL, eventId TEXT NOT NULL, taskKind TEXT NOT NULL, taskId TEXT NOT NULL, snapshotDigest TEXT NOT NULL, payloadDigest TEXT NOT NULL, costs TEXT NOT NULL, grantId TEXT, compact TEXT, mode TEXT NOT NULL, reason TEXT, trustedTime INTEGER, generation INTEGER NOT NULL, epoch INTEGER NOT NULL, PRIMARY KEY(ownerKey,eventId))")
        db.execSQL("CREATE TABLE IF NOT EXISTS grant_task_bindings (ownerKey TEXT NOT NULL, taskKind TEXT NOT NULL, taskId TEXT NOT NULL, snapshotDigest TEXT NOT NULL, canonical TEXT NOT NULL, executionFingerprint TEXT NOT NULL, PRIMARY KEY(ownerKey,taskKind,taskId))")
        db.execSQL("CREATE TABLE IF NOT EXISTS grant_task_provenance (taskKind TEXT NOT NULL, taskId TEXT NOT NULL, ownerKey TEXT NOT NULL, generation INTEGER NOT NULL, original TEXT NOT NULL, PRIMARY KEY(taskKind,taskId))")
    }
}

/** Add a durable retry identity for authenticated offline-grant readiness reports. */
val MIGRATION_14_15 = object : Migration(14, 15) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("CREATE TABLE IF NOT EXISTS grant_readiness_outbox (requestId TEXT NOT NULL PRIMARY KEY, ownerKey TEXT NOT NULL, generation INTEGER NOT NULL, bodyJson TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)")
        db.execSQL("CREATE INDEX IF NOT EXISTS index_grant_readiness_outbox_ownerKey_generation ON grant_readiness_outbox (ownerKey, generation)")
    }
}

/**
 * The write-off contour: one outbox of whole documents plus four caches the
 * bootstrap and box-registry mirror replace. Column names and nullability must
 * match `WriteoffEntities.kt` exactly — Room validates the migrated schema
 * against the entities at open and fails loudly on a mismatch, which is the
 * point of writing this by hand rather than trusting a generated diff.
 */
val MIGRATION_15_16 = object : Migration(15, 16) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS writeoff_outbox (documentId TEXT NOT NULL PRIMARY KEY, deviceSeq INTEGER NOT NULL, " +
                "operatorId TEXT NOT NULL, reasonId TEXT NOT NULL, reasonName TEXT NOT NULL, unitCount INTEGER NOT NULL, " +
                "boxCount INTEGER NOT NULL, requestJson TEXT NOT NULL, createdAt TEXT NOT NULL, state TEXT NOT NULL, " +
                "orderNo TEXT, acceptedCount INTEGER, conflictsJson TEXT, lastAttemptAt TEXT)",
        )
        db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS index_writeoff_outbox_deviceSeq ON writeoff_outbox (deviceSeq)")
        db.execSQL("CREATE TABLE IF NOT EXISTS writeoff_reasons (id TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL, sortOrder INTEGER NOT NULL)")
        db.execSQL("CREATE TABLE IF NOT EXISTS writeoff_products (gtin14 TEXT NOT NULL PRIMARY KEY, id TEXT NOT NULL, name TEXT NOT NULL)")
        db.execSQL("CREATE INDEX IF NOT EXISTS index_writeoff_products_id ON writeoff_products (id)")
        db.execSQL("CREATE TABLE IF NOT EXISTS writeoff_permissions (employeeId TEXT NOT NULL PRIMARY KEY, canWriteoff INTEGER NOT NULL)")
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS writeoff_boxes (sscc TEXT NOT NULL PRIMARY KEY, boxId TEXT NOT NULL, productId TEXT NOT NULL, " +
                "bottleCount INTEGER NOT NULL, contentKeysJson TEXT NOT NULL, updatedAt TEXT NOT NULL)",
        )
    }
}

/**
 * The bundle's own reason for a missing SSCC block, so the device can warn
 * from entry. Nullable, so existing rows need nothing.
 *
 * Guarded the way the table migrations above use `IF NOT EXISTS`: the upgrade
 * suites build a current-schema database, drop only the tables a later
 * migration creates and re-run from an older version, and SQLite has no
 * `ADD COLUMN IF NOT EXISTS`.
 */
val MIGRATION_16_17 = object : Migration(16, 17) {
    override fun migrate(db: SupportSQLiteDatabase) {
        val present = db.query("PRAGMA table_info(`shift_mirror`)").use { cursor ->
            val name = cursor.getColumnIndexOrThrow("name")
            generateSequence { if (cursor.moveToNext()) cursor.getString(name) else null }.any { it == "ssccIssuerProblem" }
        }
        if (!present) db.execSQL("ALTER TABLE shift_mirror ADD COLUMN ssccIssuerProblem TEXT")
    }
}

/** Column names of [table], or empty when it does not exist. */
private fun SupportSQLiteDatabase.columnsOf(table: String): List<String> =
    query("PRAGMA table_info(`$table`)").use { cursor ->
        val name = cursor.getColumnIndexOrThrow("name")
        generateSequence { if (cursor.moveToNext()) cursor.getString(name) else null }.toList()
    }

private fun SupportSQLiteDatabase.tableExists(table: String): Boolean =
    query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", arrayOf<Any>(table)).use { it.moveToNext() }

/** True when [table] declares [column] NOT NULL; false when it is nullable or absent. */
private fun SupportSQLiteDatabase.isNotNull(table: String, column: String): Boolean =
    query("PRAGMA table_info(`$table`)").use { cursor ->
        val name = cursor.getColumnIndexOrThrow("name")
        val notNull = cursor.getColumnIndexOrThrow("notnull")
        generateSequence { if (cursor.moveToNext()) cursor.getString(name) to cursor.getInt(notNull) else null }
            .any { it.first == column && it.second == 1 }
    }

/**
 * Warehouse pallets (spec §3.1). SQLite cannot widen a NOT NULL column, so
 * `pallets` and `pallet_exceptions` are rebuilt; `writeoff_boxes` becomes the
 * shared `box_registry` with the station feed's pallet fields; three bootstrap
 * caches and the membership table are new. Every DDL string matches the
 * entities exactly -- Room validates at open.
 *
 * Every step is guarded the way `MIGRATION_16_17` guards its `ADD COLUMN`: the
 * upgrade suites build a database at the CURRENT schema, drop only what a later
 * migration creates and rewind `user_version`, so this migration can meet
 * tables that are already in their v18 shape. `kind` on `pallets`, a NOT NULL
 * `shiftId` on `pallet_exceptions` and the presence of `box_registry` are the
 * three facts that say which side of the rebuild the file is on.
 *
 * `kind` deliberately carries NO SQL default: the entity declares none, Room
 * compares defaults exactly, and the backfill supplies the literal instead.
 */
val MIGRATION_17_18 = object : Migration(17, 18) {
    override fun migrate(db: SupportSQLiteDatabase) {
        if ("kind" !in db.columnsOf("pallets")) {
            db.execSQL(
                "CREATE TABLE IF NOT EXISTS `pallets_new` (`palletId` TEXT NOT NULL, `shiftId` TEXT, `terminalId` TEXT, `sscc` TEXT, " +
                    "`openedAt` TEXT NOT NULL, `closedAt` TEXT, `operatorId` TEXT, `printState` TEXT NOT NULL, `printReason` TEXT, " +
                    "`ackedAt` TEXT, `kind` TEXT NOT NULL, `productId` TEXT, `deviceId` TEXT, `disassembledAt` TEXT, PRIMARY KEY(`palletId`))",
            )
            db.execSQL(
                "INSERT INTO `pallets_new` (palletId, shiftId, terminalId, sscc, openedAt, closedAt, operatorId, printState, printReason, ackedAt, kind) " +
                    "SELECT palletId, shiftId, terminalId, sscc, openedAt, closedAt, operatorId, printState, printReason, ackedAt, 'production' FROM `pallets`",
            )
            db.execSQL("DROP TABLE `pallets`")
            db.execSQL("ALTER TABLE `pallets_new` RENAME TO `pallets`")
        }
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_pallets_shiftId_closedAt` ON `pallets` (`shiftId`, `closedAt`)")
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_pallets_deviceId_kind_closedAt` ON `pallets` (`deviceId`, `kind`, `closedAt`)")

        if (db.isNotNull("pallet_exceptions", "shiftId")) {
            db.execSQL(
                "CREATE TABLE IF NOT EXISTS `pallet_exceptions_new` (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `kind` TEXT NOT NULL, " +
                    "`palletId` TEXT NOT NULL, `shiftId` TEXT, `terminalId` TEXT, `operatorId` TEXT, `reason` TEXT NOT NULL, " +
                    "`occurredAt` TEXT NOT NULL, `payloadJson` TEXT NOT NULL, `ackedAt` TEXT)",
            )
            db.execSQL(
                "INSERT INTO `pallet_exceptions_new` (id, kind, palletId, shiftId, terminalId, operatorId, reason, occurredAt, payloadJson, ackedAt) " +
                    "SELECT id, kind, palletId, shiftId, terminalId, operatorId, reason, occurredAt, payloadJson, ackedAt FROM `pallet_exceptions`",
            )
            db.execSQL("DROP TABLE `pallet_exceptions`")
            db.execSQL("ALTER TABLE `pallet_exceptions_new` RENAME TO `pallet_exceptions`")
        }
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_pallet_exceptions_ackedAt` ON `pallet_exceptions` (`ackedAt`)")

        // The rename is the real upgrade path; a rewound fixture already holds
        // `box_registry` and only needs the table to exist, never a second one.
        if (!db.tableExists("box_registry") && db.tableExists("writeoff_boxes")) {
            db.execSQL("ALTER TABLE `writeoff_boxes` RENAME TO `box_registry`")
        }
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `box_registry` (`sscc` TEXT NOT NULL, `boxId` TEXT NOT NULL, `productId` TEXT NOT NULL, " +
                "`bottleCount` INTEGER NOT NULL, `contentKeysJson` TEXT NOT NULL, `updatedAt` TEXT NOT NULL, `palletId` TEXT, " +
                "`palletSscc` TEXT, `palletActive` INTEGER NOT NULL DEFAULT 0, `closedAt` TEXT, `productionDate` TEXT, " +
                "`localPalletId` TEXT, PRIMARY KEY(`sscc`))",
        )
        val registryColumns = db.columnsOf("box_registry")
        for (column in listOf(
            "palletId" to "TEXT",
            "palletSscc" to "TEXT",
            "palletActive" to "INTEGER NOT NULL DEFAULT 0",
            "closedAt" to "TEXT",
            "productionDate" to "TEXT",
            "localPalletId" to "TEXT",
        )) {
            if (column.first !in registryColumns) db.execSQL("ALTER TABLE `box_registry` ADD COLUMN `${column.first}` ${column.second}")
        }
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_box_registry_localPalletId` ON `box_registry` (`localPalletId`)")

        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `pallet_memberships` (`palletId` TEXT NOT NULL, `sscc` TEXT NOT NULL, `addedAt` TEXT NOT NULL, " +
                "`operatorId` TEXT, `status` TEXT NOT NULL, `reason` TEXT, `winningPalletSscc` TEXT, `ackedAt` TEXT, `acknowledgedAt` TEXT, " +
                "`bottleCount` INTEGER, `productionDate` TEXT, PRIMARY KEY(`palletId`, `sscc`))",
        )
        // Guarded the same way the registry's columns are: a fixture rewound to
        // v17 after this migration first shipped already holds the table in its
        // earlier v18 shape, without the two snapshot columns.
        val membershipColumns = db.columnsOf("pallet_memberships")
        for (column in listOf("bottleCount" to "INTEGER", "productionDate" to "TEXT")) {
            if (column.first !in membershipColumns) db.execSQL("ALTER TABLE `pallet_memberships` ADD COLUMN `${column.first}` ${column.second}")
        }
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_pallet_memberships_status_addedAt` ON `pallet_memberships` (`status`, `addedAt`)")
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `pallet_products` (`id` TEXT NOT NULL, `gtin14` TEXT NOT NULL, `name` TEXT NOT NULL, `printName` TEXT, " +
                "`shelfLifeDays` INTEGER, `palletBoxCapacity` INTEGER, `chzProductGroupCode` INTEGER, PRIMARY KEY(`id`))",
        )
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_pallet_products_gtin14` ON `pallet_products` (`gtin14`)")
        db.execSQL("CREATE TABLE IF NOT EXISTS `pallet_permissions` (`employeeId` TEXT NOT NULL, `canBuildPallets` INTEGER NOT NULL, PRIMARY KEY(`employeeId`))")
        db.execSQL("CREATE TABLE IF NOT EXISTS `pallet_label_templates` (`key` TEXT NOT NULL, `specJson` TEXT NOT NULL, PRIMARY KEY(`key`))")
    }
}
