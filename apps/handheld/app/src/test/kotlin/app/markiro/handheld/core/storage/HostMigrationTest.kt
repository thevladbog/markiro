package app.markiro.handheld.core.storage

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

/** A cloud terminal of version 20 with a live queue upgrades to 21 and loses nothing (spec 10: "облачный остаётся облачным"). */
@RunWith(AndroidJUnit4::class)
class HostMigrationTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()

    private fun database(name: String) = Room.databaseBuilder(context, HandheldDatabase::class.java, name)
        .allowMainThreadQueries()
        .addMigrations(
            MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4, MIGRATION_4_5, MIGRATION_5_6, MIGRATION_6_7, MIGRATION_7_8,
            MIGRATION_8_9, MIGRATION_9_10, MIGRATION_10_11, MIGRATION_11_12, MIGRATION_12_13, MIGRATION_13_14,
            MIGRATION_14_15, MIGRATION_15_16, MIGRATION_16_17, MIGRATION_17_18, MIGRATION_18_19, MIGRATION_19_20,
            MIGRATION_20_21,
        ).build()

    @Test
    fun aCloudTerminalWithAQueueKeepsItAndGetsTheHostColumnsEmpty() = runTest {
        val name = "host-migration.db"
        context.deleteDatabase(name)
        database(name).apply { openHelper.writableDatabase }.close()
        SQLiteDatabase.openOrCreateDatabase(context.getDatabasePath(name), null).use { raw ->
            // Rewind to version 20. The SQLite behind Robolectric has no `DROP COLUMN`, so the three altered tables are
            // rebuilt with their v20 DDL; the two new tables go away.
            for (table in listOf("device_config", "device_recovery", "sscc_pool", "operator_badges", "host_outbox")) {
                raw.execSQL("DROP TABLE $table")
            }
            raw.execSQL(
                "CREATE TABLE `device_config` (`id` INTEGER NOT NULL, `deviceId` TEXT NOT NULL, `deviceName` TEXT NOT NULL, " +
                    "`tenantId` TEXT NOT NULL, `organizationName` TEXT NOT NULL, `lineId` TEXT, `lineName` TEXT, `kind` TEXT NOT NULL, " +
                    "`serverUrl` TEXT NOT NULL, `pairedAt` INTEGER NOT NULL, `rosterFetchedAt` INTEGER, `lastOperatorId` TEXT, " +
                    "`shiftsCount` INTEGER, `inventoryCount` INTEGER, `countsAt` INTEGER, `activeShiftId` TEXT, `activeInventoryId` TEXT, " +
                    "PRIMARY KEY(`id`))",
            )
            raw.execSQL(
                "CREATE TABLE `device_recovery` (`id` INTEGER NOT NULL, `serverOrigin` TEXT, `tenantId` TEXT, `deviceId` TEXT, `kind` TEXT, " +
                    "`generation` INTEGER NOT NULL, `phase` TEXT NOT NULL, `pendingId` TEXT, PRIMARY KEY(`id`))",
            )
            raw.execSQL(
                "CREATE TABLE `sscc_pool` (`issuerPrefix` TEXT NOT NULL, `extensionDigit` INTEGER NOT NULL, `fromSerial` INTEGER NOT NULL, " +
                    "`toSerial` INTEGER NOT NULL, `nextSerial` INTEGER NOT NULL, PRIMARY KEY(`issuerPrefix`, `extensionDigit`, `fromSerial`))",
            )
            raw.execSQL(
                "INSERT INTO device_recovery (id, serverOrigin, tenantId, deviceId, kind, generation, phase) " +
                    "VALUES (1, 'https://admin.markiro.app', 't-1', 'dev-1', 'handheld', 1, 'SEALED')",
            )
            raw.execSQL(
                "INSERT INTO device_config (id, deviceId, deviceName, tenantId, organizationName, kind, serverUrl, pairedAt) " +
                    "VALUES (1, 'dev-1', 'ТСД 1', 't-1', 'ООО', 'handheld', 'https://admin.markiro.app', 1)",
            )
            raw.execSQL("INSERT INTO outbox (shiftId, raw, verdict, scannedAt, operatorId, codeHash, gtin14, serial, boxId) VALUES ('s1', 'raw', 'ok', '2026-10-08T06:00:00.000Z', 'op', 'h', 'g', 's', NULL)")
            raw.execSQL("INSERT INTO sscc_pool (issuerPrefix, extensionDigit, fromSerial, toSerial, nextSerial) VALUES ('460068200', 0, 1500, 3499, 1502)")
            raw.execSQL("PRAGMA user_version = 20")
        }
        val db = database(name)
        try {
            val config = db.deviceConfigDao().get()!!
            assertEquals("cloud", config.backend)
            assertNull(config.pinSha256)
            assertNull(config.hostId)
            assertEquals(1, db.outboxDao().countNow())
            val range = db.ssccPoolDao().lowestWithRoom("460068200", 0)!!
            assertEquals(1502L, range.nextSerial)
            assertNull(range.blockId)
            assertEquals("t-1", db.deviceRecoveryDao().get()!!.tenantId)
            assertNull(db.deviceRecoveryDao().get()!!.pinSha256)
            assertEquals(HANDHELD_DATABASE_VERSION, db.openHelper.readableDatabase.version)
            assertEquals(21, HANDHELD_DATABASE_VERSION)
            assertEquals(0, db.hostOutboxDao().queuedCount())
        } finally {
            db.close()
            context.deleteDatabase(name)
        }
    }
}
