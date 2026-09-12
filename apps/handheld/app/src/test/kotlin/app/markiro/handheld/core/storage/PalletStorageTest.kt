package app.markiro.handheld.core.storage

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import androidx.room.Room
import androidx.sqlite.db.SupportSQLiteDatabase
import androidx.sqlite.db.SupportSQLiteOpenHelper
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PalletStorageTest {
    private lateinit var db: HandheldDatabase

    @Before
    fun open() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries()
            .build()
    }

    @After
    fun close() = db.close()

    private fun pallet(id: String, shiftId: String, closedAt: String? = null) = PalletEntity(
        palletId = id,
        shiftId = shiftId,
        terminalId = null,
        sscc = null,
        openedAt = "2026-09-11T08:00:00.000Z",
        closedAt = closedAt,
        operatorId = null,
        printState = PalletPrint.PENDING,
        printReason = null,
        ackedAt = null,
    )

    private fun box(id: String, shiftId: String) = BoxEntity(
        boxId = id,
        shiftId = shiftId,
        sscc = null,
        openedAt = "2026-09-11T08:00:00.000Z",
        closedAt = null,
        operatorId = null,
        printState = "pending",
        printReason = null,
        ackedAt = null,
    )

    /**
     * Not an in-memory round trip: the whole point is that a pallet the
     * operator already opened is still the shift's open one after the app
     * (or the test process) dies and Room reopens the same file.
     */
    @Test
    fun keepsOneOpenPalletPerShiftAcrossAReopen() = runTest {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val name = "pallet-reopen-test.db"
        context.deleteDatabase(name)
        try {
            val first = Room.databaseBuilder(context, HandheldDatabase::class.java, name)
                .allowMainThreadQueries()
                .build()
            first.palletDao().insert(pallet("p1", "s1"))
            first.close()

            val reopened = Room.databaseBuilder(context, HandheldDatabase::class.java, name)
                .allowMainThreadQueries()
                .build()
            try {
                assertEquals("p1", reopened.palletDao().open("s1")?.palletId)
            } finally {
                reopened.close()
            }
        } finally {
            context.deleteDatabase(name)
        }
    }

    /**
     * Seeded first, migration driven directly -- same reasoning as
     * `MigrationTest`'s v4-to-v5 and v5-to-v6 cases: a database Room builds
     * from the current entities is already v10, so the migration would never
     * run at all if it went through Room.
     */
    @Test
    fun migratesAnExistingDatabaseWithoutLosingBoxes() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val name = "migration-9-10-test.db"
        context.deleteDatabase(name)
        val file = context.getDatabasePath(name).also { it.parentFile?.mkdirs() }
        SQLiteDatabase.openOrCreateDatabase(file, null).use { legacy ->
            legacy.execSQL(
                "CREATE TABLE `boxes` (`boxId` TEXT NOT NULL, `shiftId` TEXT NOT NULL, `sscc` TEXT, " +
                    "`openedAt` TEXT NOT NULL, `closedAt` TEXT, `operatorId` TEXT, `printState` TEXT NOT NULL, " +
                    "`printReason` TEXT, `ackedAt` TEXT, PRIMARY KEY(`boxId`))",
            )
            legacy.execSQL(
                "CREATE TABLE `shift_mirror` (`id` TEXT NOT NULL, `number` TEXT NOT NULL, PRIMARY KEY(`id`))",
            )
            legacy.execSQL(
                "INSERT INTO boxes VALUES ('b1','s1',NULL,'2026-09-11T08:00:00.000Z',NULL,NULL,'pending',NULL,NULL)",
            )
            legacy.execSQL("INSERT INTO shift_mirror VALUES ('s1','SEP26-001')")
            legacy.version = 9
        }
        val helper = FrameworkSQLiteOpenHelperFactory().create(
            SupportSQLiteOpenHelper.Configuration.builder(context).name(name).callback(
                object : SupportSQLiteOpenHelper.Callback(9) {
                    override fun onCreate(db: SupportSQLiteDatabase) = Unit
                    override fun onUpgrade(db: SupportSQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
                },
            ).build(),
        )
        try {
            val migrated = helper.writableDatabase
            MIGRATION_9_10.migrate(migrated)
            migrated.query("SELECT boxId, palletId FROM boxes WHERE boxId = 'b1'").use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals("b1", cursor.getString(0))
                // A box that predates pallets joins none of them.
                assertTrue(cursor.isNull(1))
            }
            migrated.query("SELECT palletLabelTemplateSpec FROM shift_mirror WHERE id = 's1'").use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertTrue(cursor.isNull(0))
            }
            migrated.query("SELECT COUNT(*) FROM pallets").use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals(0, cursor.getInt(0))
            }
            migrated.query("SELECT COUNT(*) FROM pallet_exceptions").use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals(0, cursor.getInt(0))
            }
        } finally {
            helper.close()
            context.deleteDatabase(name)
        }
    }

    @Test
    fun countsOnlyBoxesThatJoinedThePallet() = runTest {
        db.palletDao().insert(pallet("p1", "s1"))
        db.boxDao().insert(box("b1", "s1").copy(palletId = "p1"))
        db.boxDao().insert(box("b2", "s1"))
        assertEquals(1, db.palletDao().boxCount("p1"))
    }

    /**
     * Same reasoning as `BoxEntity`/`BoxDao.demoteInterruptedPrints`: the app
     * died between handing bytes to the printer and hearing back, so a
     * `printing` row found at startup is unknown, never resumed.
     */
    @Test
    fun aPrintingPalletFoundAtStartupIsDemotedToUnknown() = runTest {
        db.palletDao().insert(pallet("p1", "s1", closedAt = "2026-09-11T09:00:00.000Z").copy(printState = PalletPrint.PRINTING))
        db.palletDao().insert(pallet("p2", "s1", closedAt = "2026-09-11T09:00:00.000Z").copy(printState = PalletPrint.PENDING))
        db.palletDao().demoteInterruptedPrints()
        assertEquals(PalletPrint.UNKNOWN, db.palletDao().get("p1")?.printState)
        assertEquals(PalletPrint.PENDING, db.palletDao().get("p2")?.printState)
    }

    /**
     * `PalletPrinter` mirrors `BoxPrinter`, so a deferred or failed pallet
     * label must ride the same label queue a box's does -- this is the query
     * the queue screen's pallet half is built on.
     */
    @Test
    fun theUnprintedQueueListsOnlyClosedPalletsWhoseLabelIsNotResolved() = runTest {
        db.palletDao().insert(pallet("p1", "s1", closedAt = "2026-09-11T09:00:00.000Z").copy(printState = PalletPrint.FAILED))
        db.palletDao().insert(pallet("p2", "s1", closedAt = "2026-09-11T09:10:00.000Z").copy(printState = PalletPrint.PRINTED))
        db.palletDao().insert(pallet("p3", "s1", closedAt = "2026-09-11T09:20:00.000Z").copy(printState = PalletPrint.DEFERRED))
        assertEquals(2, db.palletDao().observeUnprintedCount().first())
        assertEquals(listOf("p1", "p3"), db.palletDao().observeUnprinted().first().map { it.palletId })
    }

    /**
     * Was `aWipeClearsPallets` before same-device recovery landed. A rejected
     * credential no longer empties the operational tables: recovery on the SAME
     * device keeps the work, and `StorageTest`\'s
     * `rejectionPreservesEveryOperationalChannelAndRemovesSecrets` asserts that
     * for every table generically. Pallets are operational data exactly as
     * boxes are, so this pins the same answer for them by name -- a future
     * change that starts clearing pallets on rejection loses a closed,
     * physically labelled pallet that the server has not yet acknowledged.
     */
    @Test
    fun aCredentialRejectionKeepsPalletsForTheSameDevice() = runTest {
        val credential = InMemoryCredentialStore().apply { write("mk_live_secret") }
        val recovery = db.initializeRecoveryForTest(credential)
        db.palletDao().insert(pallet("p1", "s1"))
        assertTrue(DeviceWipe(recovery).reject(recovery.token()))
        assertEquals("p1", db.palletDao().get("p1")?.palletId)
        assertNull(credential.read())
    }
}
