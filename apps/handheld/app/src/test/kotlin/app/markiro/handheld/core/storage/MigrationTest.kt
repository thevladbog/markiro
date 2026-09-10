package app.markiro.handheld.core.storage

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.print.PrinterEntity
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/** Opens a hand-made version-1 database; Room validates every table after all three migrations run. */
@RunWith(AndroidJUnit4::class)
class MigrationTest {
    @Test
    fun migratesAPairedVersionOneDatabaseAndKeepsTheConfig() = runTest {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val name = "migration-test.db"
        context.deleteDatabase(name)
        val file = context.getDatabasePath(name).also { it.parentFile?.mkdirs() }
        SQLiteDatabase.openOrCreateDatabase(file, null).use { legacy ->
            legacy.execSQL(
                "CREATE TABLE `device_config` (`id` INTEGER NOT NULL, `deviceId` TEXT NOT NULL, `deviceName` TEXT NOT NULL, " +
                    "`tenantId` TEXT NOT NULL, `organizationName` TEXT NOT NULL, `lineId` TEXT, `lineName` TEXT, `kind` TEXT NOT NULL, " +
                    "`serverUrl` TEXT NOT NULL, `pairedAt` INTEGER NOT NULL, `rosterFetchedAt` INTEGER, `lastOperatorId` TEXT, " +
                    "`shiftsCount` INTEGER, `inventoryCount` INTEGER, `countsAt` INTEGER, PRIMARY KEY(`id`))",
            )
            legacy.execSQL(
                "CREATE TABLE `operators` (`operatorId` TEXT NOT NULL, `name` TEXT NOT NULL, `login` TEXT NOT NULL, `role` TEXT NOT NULL, " +
                    "`pinHash` TEXT NOT NULL, `badgeHash` TEXT, `active` INTEGER NOT NULL, PRIMARY KEY(`operatorId`))",
            )
            legacy.execSQL("CREATE TABLE room_master_table (id INTEGER PRIMARY KEY,identity_hash TEXT)")
            legacy.execSQL("INSERT OR REPLACE INTO room_master_table (id,identity_hash) VALUES(42, 'legacy')")
            legacy.execSQL(
                "INSERT INTO device_config VALUES (1, 'dev-1', 'ТСД 1', 't-1', 'ООО', 'l-2', 'Линия 2', 'handheld', 'http://x', 1, NULL, NULL, NULL, NULL, NULL)",
            )
            legacy.version = 1
        }
        val db = Room.databaseBuilder(context, HandheldDatabase::class.java, name)
            .addMigrations(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4)
            .allowMainThreadQueries()
            .build()
        try {
            val config = db.deviceConfigDao().get()
            assertEquals("dev-1", config?.deviceId)
            assertEquals(null, config?.activeShiftId)
            assertEquals(null, config?.activeInventoryId)
            db.outboxDao().insert(
                OutboxEntity(shiftId = "s", raw = "r", verdict = "invalid", scannedAt = "t", operatorId = null, codeHash = null, gtin14 = null, serial = null),
            )
            assertEquals(1, db.outboxDao().head(1).size)
            db.inventoryOutboxDao().insert(
                InventoryOutboxEntity(inventoryId = "i1", snapshotId = "snap", eventId = "e1", deviceSequence = 1, payloadJson = "{}", createdAt = "t"),
            )
            assertEquals(1, db.inventoryOutboxDao().head("i1", 10).size)
            db.printerDao().upsert(
                PrinterEntity(
                    id = "p1", name = "Zebra ZD421", transport = "wifi", address = "192.168.1.40:9100",
                    language = "zpl", dpi = 203, selected = true, lastStatus = null, lastSeenAt = null,
                ),
            )
            assertEquals("p1", db.printerDao().selected()?.id)
        } finally {
            db.close()
            context.deleteDatabase(name)
        }
    }
}
