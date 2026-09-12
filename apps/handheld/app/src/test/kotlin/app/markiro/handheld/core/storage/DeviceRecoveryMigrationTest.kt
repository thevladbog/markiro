package app.markiro.handheld.core.storage

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.network.CredentialDto
import app.markiro.handheld.core.network.DeviceDto
import app.markiro.handheld.core.network.PairResponse
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class DeviceRecoveryMigrationTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private fun database(name: String) = Room.databaseBuilder(context, HandheldDatabase::class.java, name)
        .allowMainThreadQueries()
        .addMigrations(MIGRATION_7_8, MIGRATION_8_9, MIGRATION_9_10, MIGRATION_10_11).build()

    /**
     * Turns the file Room just built at the CURRENT version back into a real v7
     * one, so the upgrade under test is the one an installed v7 terminal takes.
     *
     * Everything added after v7 comes off: `device_recovery` (v8), and 06d's
     * pallet tables and columns (v9, v10, v11). The two ALTERed tables are dropped
     * and recreated at their v7 shape rather than losing columns, because the
     * SQLite behind Robolectric has no `ALTER TABLE ... DROP COLUMN`; both are
     * empty in this fixture, and the DDL below is the v1/v4-to-v5/v5-to-v6/
     * v6-to-v7 statements from `Migrations.kt` verbatim, so what is rebuilt is
     * byte-for-byte what an installed terminal would be holding.
     */
    private fun rewindToVersionSeven(db: androidx.sqlite.db.SupportSQLiteDatabase) {
        db.execSQL("DROP TABLE device_recovery")
        // `IF EXISTS` is kept rather than tightened: `pallet_exceptions` gained
        // its entity only at v11 (`MIGRATION_10_11`), so a file built by an
        // older Room -- or rewound by an earlier revision of this helper -- may
        // not have it, and a rewind that throws would fail the case it is
        // setting up rather than the behaviour under test.
        db.execSQL("DROP TABLE IF EXISTS pallet_exceptions")
        db.execSQL("DROP TABLE pallets")
        db.execSQL("DROP TABLE boxes")
        db.execSQL(
            "CREATE TABLE `boxes` (`boxId` TEXT NOT NULL, `shiftId` TEXT NOT NULL, `sscc` TEXT, " +
                "`openedAt` TEXT NOT NULL, `closedAt` TEXT, `operatorId` TEXT, `printState` TEXT NOT NULL, " +
                "`printReason` TEXT, `ackedAt` TEXT, PRIMARY KEY(`boxId`))",
        )
        db.execSQL("CREATE INDEX `index_boxes_shiftId_closedAt` ON `boxes` (`shiftId`, `closedAt`)")
        db.execSQL("ALTER TABLE `boxes` ADD COLUMN `disassembledAt` TEXT")
        db.execSQL("DROP TABLE shift_mirror")
        db.execSQL(
            "CREATE TABLE `shift_mirror` (`id` TEXT NOT NULL, `number` TEXT NOT NULL, `status` TEXT NOT NULL, " +
                "`mode` TEXT NOT NULL, `productId` TEXT NOT NULL, `productName` TEXT, `productPrintName` TEXT, `productGtin14` TEXT, " +
                "`lineId` TEXT, `lineName` TEXT, `counterpartyName` TEXT, `plannedQty` INTEGER, `plannedDate` TEXT, `productionDate` TEXT, " +
                "`boxCapacity` INTEGER, `palletCapacity` INTEGER, `palletsEnabled` INTEGER NOT NULL, `validationPrintMode` TEXT NOT NULL, " +
                "`closePolicyKind` TEXT, `closeOwnerDeviceId` TEXT, `openedAt` TEXT, `listFetchedAt` INTEGER NOT NULL, " +
                "`bundleFetchedAt` INTEGER, `enteredAt` INTEGER, `leftAt` INTEGER, PRIMARY KEY(`id`))",
        )
        for (column in listOf("boxLabelTemplate", "shelfLifeDays", "egaisCode", "ssccIssuerPrefix")) {
            db.execSQL("ALTER TABLE `shift_mirror` ADD COLUMN `$column` ${if (column == "shelfLifeDays") "INTEGER" else "TEXT"}")
        }
        for (column in listOf("duplicateVerification", "duplicateTemplate", "duplicateTemplateDigest", "duplicatePolicyRevision")) {
            db.execSQL("ALTER TABLE `shift_mirror` ADD COLUMN `$column` TEXT")
        }
    }

    @Test fun realVersionSevenUpgradePreservesPayloadsAndBindsOnlyObservedConfig() = runTest {
        for (withConfig in listOf(true, false)) {
            val name = "recovery-migration-${UUID.randomUUID()}.db"
            val config = syntheticDeviceConfig()
            val credentials = InMemoryCredentialStore().apply { write("old-key") }
            try {
                database(name).useDb { old ->
                    if (withConfig) old.deviceConfigDao().upsert(config)
                    old.metaDao().put(MetaEntity("inventory_pending_batch:i1", "{\"batch\":\"saved\\u001dbytes\"}"))
                    old.outboxDao().insert(OutboxEntity(shiftId = "s1", raw = "exact\u001dscan", verdict = "invalid", scannedAt = "2026-09-11T00:00:00Z", operatorId = "op", codeHash = null, gtin14 = null, serial = null))
                    old.openHelper.writableDatabase.let(::rewindToVersionSeven)
                    old.openHelper.writableDatabase.version = 7
                }
                database(name).useDb { upgraded ->
                    val recovery = DeviceRecovery(upgraded, credentials)
                    recovery.initialize()
                    assertEquals(if (withConfig) RecoveryPhase.ACTIVE else RecoveryPhase.OWNER_UNRESOLVED, recovery.current().phase)
                    assertEquals("exact\u001dscan", upgraded.outboxDao().head(5).single().raw)
                    assertEquals(1L, upgraded.outboxDao().head(5).single().id)
                    assertEquals("{\"batch\":\"saved\\u001dbytes\"}", upgraded.metaDao().get("inventory_pending_batch:i1"))
                    assertEquals(11, upgraded.openHelper.readableDatabase.version)
                }
                database(name).useDb { restarted ->
                    val recovery = DeviceRecovery(restarted, credentials)
                    recovery.initialize()
                    assertEquals(if (withConfig) RecoveryPhase.ACTIVE else RecoveryPhase.OWNER_UNRESOLVED, recovery.current().phase)
                    assertEquals(1L, restarted.outboxDao().head(5).single().id)
                }
            } finally { context.deleteDatabase(name) }
        }
    }

    @Test fun restartCompletesCandidateAfterConfigTransactionFailureAndDetectsConflictingConfig() = runTest {
        val name = "recovery-restart-${UUID.randomUUID()}.db"
        val config = syntheticDeviceConfig()
        val credentials = InMemoryCredentialStore().apply { write("old-key") }
        try {
            database(name).useDb { db ->
                db.deviceConfigDao().upsert(config)
                val recovery = DeviceRecovery(db, credentials)
                recovery.initialize()
                recovery.reject(recovery.token())
                db.openHelper.writableDatabase.execSQL("CREATE TRIGGER fail_config BEFORE UPDATE ON device_config BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
                val response = PairResponse(DeviceDto(config.deviceId, config.deviceName, "handheld", config.tenantId, config.organizationName), CredentialDto("new-key", config.serverUrl), emptyList())
                assertTrue(runCatching { recovery.restore(response, config.serverUrl) }.isFailure)
                db.openHelper.writableDatabase.execSQL("DROP TRIGGER fail_config")
            }
            database(name).useDb { db ->
                val recovery = DeviceRecovery(db, credentials)
                recovery.initialize()
                assertEquals(RecoveryPhase.ACTIVE, recovery.current().phase)
                assertEquals("new-key", credentials.read())
                assertEquals(2L, recovery.current().generation)
                db.deviceConfigDao().upsert(config.copy(tenantId = "contradictory-owner"))
            }
            database(name).useDb { db ->
                val recovery = DeviceRecovery(db, credentials)
                recovery.initialize()
                assertEquals(RecoveryPhase.OWNER_UNRESOLVED, recovery.current().phase)
                assertNull(credentials.read())
            }
        } finally { context.deleteDatabase(name) }
    }
    @Test fun reopenedSealedAndRestoringOwnersAreReconciledBeforePublication() = runTest {
        for (phase in listOf("sealed-config", "sealed-anchor", "restoring-config", "restoring-anchor", "sealed-missing", "sealed-malformed")) {
            val name = "recovery-owner-${UUID.randomUUID()}.db"
            val config = syntheticDeviceConfig()
            val secrets = InMemoryCredentialStore().apply { write("old-key") }
            var failWrite = true
            val credential = object : CredentialStore by secrets {
                override fun write(apiKey: String) { check(!failWrite); secrets.write(apiKey) }
            }
            try {
                database(name).useDb { db ->
                    db.deviceConfigDao().upsert(config)
                    val recovery = DeviceRecovery(db, credential)
                    recovery.initialize()
                    recovery.reject(recovery.token())
                    if (phase.startsWith("restoring")) {
                        val response = PairResponse(DeviceDto(config.deviceId, config.deviceName, "handheld", config.tenantId, config.organizationName), CredentialDto("new-key", config.serverUrl), emptyList())
                        assertTrue(runCatching { recovery.restore(response, config.serverUrl) }.isFailure)
                    }
                    when {
                        phase.endsWith("config") -> db.deviceConfigDao().upsert(config.copy(deviceId = "foreign"))
                        phase.endsWith("anchor") -> db.metaDao().put(MetaEntity(MetaStore.SYNC_PENDING_BATCH_ID, "foreign:install:7"))
                        phase.endsWith("missing") -> db.deviceRecoveryDao().put(checkNotNull(db.deviceRecoveryDao().get()).copy(tenantId = null))
                        else -> db.deviceRecoveryDao().put(checkNotNull(db.deviceRecoveryDao().get()).copy(serverOrigin = "not a URL"))
                    }
                }
                failWrite = false
                database(name).useDb { db ->
                    val recovery = DeviceRecovery(db, credential)
                    recovery.initialize()
                    assertEquals(phase, RecoveryPhase.OWNER_UNRESOLVED, recovery.current().phase)
                    assertNull(phase, credential.read())
                    assertTrue(db.operatorDao().all().isEmpty())
                }
            } finally { context.deleteDatabase(name) }
        }
    }

    @Test fun freshPublicationReopensWithoutCandidateAndEventuallyPublishesSameOwner() = runTest {
        val name = "fresh-publication-${UUID.randomUUID()}.db"
        val config = syntheticDeviceConfig()
        val secrets = InMemoryCredentialStore()
        var failStage = true
        val credential = object : CredentialStore by secrets {
            override fun stage(publication: String) { check(!failStage); secrets.stage(publication) }
        }
        val operator = app.markiro.handheld.core.network.OperatorDto("op", "Name", "123", "operator", "hash", null, true)
        val candidate = PairResponse(DeviceDto(config.deviceId, config.deviceName, config.kind, config.tenantId, config.organizationName),
            CredentialDto("fresh-key", config.serverUrl), listOf(operator))
        try {
            repeat(2) { attempt ->
                database(name).useDb { db ->
                    val recovery = DeviceRecovery(db, credential)
                    val store = app.markiro.handheld.feature.pairing.RoomProvisioningStore(recovery)
                    assertTrue(runCatching { store.persist(candidate, config.serverUrl) }.isFailure)
                    assertEquals(RecoveryPhase.RESTORING, recovery.current().phase)
                    assertEquals(attempt + 1L, recovery.current().generation)
                    assertNull(credential.staged())
                    assertNull(credential.read())
                    assertNull(db.deviceConfigDao().get())
                    assertTrue(db.operatorDao().all().isEmpty())
                }
            }
            failStage = false
            database(name).useDb { db ->
                val recovery = DeviceRecovery(db, credential)
                recovery.initialize()
                assertEquals(RecoveryPhase.SEALED, recovery.current().phase)
                val store = app.markiro.handheld.feature.pairing.RoomProvisioningStore(recovery)
                val foreign = candidate.copy(device = candidate.device.copy(id = "foreign"))
                assertTrue(runCatching { store.persist(foreign, config.serverUrl) }.exceptionOrNull() is RecoveryMismatch)
                assertNull(credential.read())
                store.persist(candidate, config.serverUrl)
                assertEquals(RecoveryPhase.ACTIVE, recovery.current().phase)
                assertEquals(3L, recovery.token().generation)
                assertEquals(config.deviceId, db.deviceConfigDao().get()?.deviceId)
                assertEquals(config.tenantId, db.deviceConfigDao().get()?.tenantId)
                assertEquals(config.kind, db.deviceConfigDao().get()?.kind)
                assertEquals(config.serverUrl, db.deviceConfigDao().get()?.serverUrl)
                assertEquals("fresh-key", credential.read())
                assertEquals(listOf(OperatorEntity("op", "Name", "123", "operator", "hash", null, true)), db.operatorDao().all())
                recovery.commit { db.metaDao().put(MetaEntity("after-publication", "work")) }
            }
            database(name).useDb { db ->
                val recovery = DeviceRecovery(db, credential)
                recovery.initialize()
                assertEquals(RecoveryPhase.ACTIVE, recovery.current().phase)
                assertEquals("fresh-key", recovery.key(recovery.token()))
                assertEquals("work", db.metaDao().get("after-publication"))
                assertEquals(1, db.operatorDao().all().size)
            }
        } finally { context.deleteDatabase(name) }
    }

}

private inline fun <T> HandheldDatabase.useDb(block: (HandheldDatabase) -> T): T = try { block(this) } finally { close() }
