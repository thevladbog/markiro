package app.markiro.handheld.core.storage

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import androidx.room.Room
import androidx.sqlite.db.SupportSQLiteDatabase
import androidx.sqlite.db.SupportSQLiteOpenHelper
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.print.PrinterEntity
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
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
            .addMigrations(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4, MIGRATION_4_5, MIGRATION_5_6)
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
            db.boxDao().insert(
                BoxEntity(
                    boxId = "b1", shiftId = "s", sscc = null, openedAt = "t", closedAt = null,
                    operatorId = null, printState = "pending", printReason = null, ackedAt = null,
                ),
            )
            assertEquals("b1", db.boxDao().open("s")?.boxId)
            db.ssccPoolDao().insertIgnore(SsccRangeEntity("468008990", 0, 1, 10, 1))
            assertEquals(10L, db.ssccPoolDao().remaining("468008990", 0))
        } finally {
            db.close()
            context.deleteDatabase(name)
        }
    }

    /**
     * The v4 → v5 ALTERs run straight over rows that already exist.
     *
     * The test above proves the whole chain leaves a schema Room accepts, but
     * every row in it is written after the migrations. This one seeds first,
     * which is the only way to see what an installed device actually goes
     * through. It drives the migration directly rather than through Room,
     * because a database Room builds from the entities is already v5 and the
     * migration would never run at all.
     */
    @Test
    fun theBoxMigrationLeavesExistingRowsIntactAndTheirBoxesUnset() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val name = "migration-4-5-test.db"
        context.deleteDatabase(name)
        val file = context.getDatabasePath(name).also { it.parentFile?.mkdirs() }
        SQLiteDatabase.openOrCreateDatabase(file, null).use { legacy ->
            legacy.execSQL(
                "CREATE TABLE `codes_mirror` (`codeHash` TEXT NOT NULL, `shiftId` TEXT NOT NULL, " +
                    "`gtin14` TEXT NOT NULL, `serial` TEXT NOT NULL, `scannedAt` TEXT NOT NULL, PRIMARY KEY(`codeHash`))",
            )
            legacy.execSQL(
                "CREATE TABLE `outbox` (`id` INTEGER PRIMARY KEY AUTOINCREMENT, `shiftId` TEXT NOT NULL, " +
                    "`raw` TEXT NOT NULL, `verdict` TEXT NOT NULL, `scannedAt` TEXT NOT NULL, `operatorId` TEXT, " +
                    "`codeHash` TEXT, `gtin14` TEXT, `serial` TEXT)",
            )
            legacy.execSQL("CREATE TABLE `shift_mirror` (`id` TEXT NOT NULL, `number` TEXT NOT NULL, PRIMARY KEY(`id`))")
            legacy.execSQL(
                "INSERT INTO codes_mirror VALUES ('h1','s1','04680089900000','abc','2026-09-10T08:00:00.000Z')",
            )
            legacy.execSQL("INSERT INTO outbox (shiftId, raw, verdict, scannedAt) VALUES ('s1','raw','ok','t')")
            legacy.execSQL("INSERT INTO shift_mirror VALUES ('s1','SEP26-001')")
            legacy.version = 4
        }
        val helper = FrameworkSQLiteOpenHelperFactory().create(
            SupportSQLiteOpenHelper.Configuration.builder(context).name(name).callback(
                object : SupportSQLiteOpenHelper.Callback(4) {
                    override fun onCreate(db: SupportSQLiteDatabase) = Unit
                    override fun onUpgrade(db: SupportSQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
                },
            ).build(),
        )
        try {
            val db = helper.writableDatabase
            MIGRATION_4_5.migrate(db)
            db.query("SELECT shiftId, boxId FROM codes_mirror WHERE codeHash = 'h1'").use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals("s1", cursor.getString(0))
                // A scan that predates boxes joins none of them.
                assertTrue(cursor.isNull(1))
            }
            db.query("SELECT boxId FROM outbox").use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertTrue(cursor.isNull(0))
            }
            db.query("SELECT number, boxLabelTemplate, ssccIssuerPrefix FROM shift_mirror").use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals("SEP26-001", cursor.getString(0))
                assertTrue(cursor.isNull(1))
                assertTrue(cursor.isNull(2))
            }
            db.query("SELECT COUNT(*) FROM boxes").use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals(0, cursor.getInt(0))
            }
            db.query("SELECT COUNT(*) FROM sscc_pool").use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals(0, cursor.getInt(0))
            }
        } finally {
            helper.close()
            context.deleteDatabase(name)
        }
    }

    /**
     * Same shape and same reason as the box migration above: seeded first, driven
     * directly, because a database Room builds from the entities is already v6
     * and the migration would never run at all.
     */
    @Test
    fun theDuplicateMigrationLeavesShiftsIntactAndOpensTheTwoTables() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val name = "migration-5-6-test.db"
        context.deleteDatabase(name)
        val file = context.getDatabasePath(name).also { it.parentFile?.mkdirs() }
        SQLiteDatabase.openOrCreateDatabase(file, null).use { legacy ->
            legacy.execSQL(
                "CREATE TABLE `shift_mirror` (`id` TEXT NOT NULL, `number` TEXT NOT NULL, " +
                    "`ssccIssuerPrefix` TEXT, PRIMARY KEY(`id`))",
            )
            legacy.execSQL("INSERT INTO shift_mirror VALUES ('s1','SEP26-001','468008990')")
            legacy.version = 5
        }
        val helper = FrameworkSQLiteOpenHelperFactory().create(
            SupportSQLiteOpenHelper.Configuration.builder(context).name(name).callback(
                object : SupportSQLiteOpenHelper.Callback(5) {
                    override fun onCreate(db: SupportSQLiteDatabase) = Unit
                    override fun onUpgrade(db: SupportSQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
                },
            ).build(),
        )
        try {
            val db = helper.writableDatabase
            MIGRATION_5_6.migrate(db)
            db.query("SELECT number, ssccIssuerPrefix, duplicateVerification, duplicateTemplate FROM shift_mirror").use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals("SEP26-001", cursor.getString(0))
                // What the shift already had survives...
                assertEquals("468008990", cursor.getString(1))
                // ...and a shift that predates duplicate printing carries no policy.
                assertTrue(cursor.isNull(2))
                assertTrue(cursor.isNull(3))
            }
            db.execSQL(
                "INSERT INTO product_label_jobs VALUES ('j1','s1','hash','raw','t','op','rev','dig','pay','AAEC','byt','zpl',203,1,'att',1," +
                    "'prepared','none','not_required','prepared')",
            )
            db.execSQL("INSERT INTO product_label_events VALUES ('e1','j1',1,'prepared','{}','t',NULL,NULL)")
            db.query("SELECT COUNT(*) FROM product_label_jobs").use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals(1, cursor.getInt(0))
            }
            // The server refuses a gap in a job's sequence; the device must not be
            // able to produce two events claiming the same place in one.
            var duplicateRejected = false
            try {
                db.execSQL("INSERT INTO product_label_events VALUES ('e2','j1',1,'sending','{}','t',NULL,NULL)")
            } catch (_: android.database.SQLException) {
                duplicateRejected = true
            }
            assertTrue("a second event took sequence 1 of the same job", duplicateRejected)
        } finally {
            helper.close()
            context.deleteDatabase(name)
        }
    }
}
