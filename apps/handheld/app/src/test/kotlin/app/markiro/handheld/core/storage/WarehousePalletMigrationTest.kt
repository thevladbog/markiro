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

/**
 * An installed v17 terminal holding a production pallet, a pallet exception and
 * a write-off box mirror upgrades to v18 without losing any of them, and the
 * rebuilt tables accept the warehouse shapes.
 */
@RunWith(AndroidJUnit4::class)
class WarehousePalletMigrationTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()

    private fun database(name: String) = Room.databaseBuilder(context, HandheldDatabase::class.java, name)
        .allowMainThreadQueries()
        .addMigrations(
            MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4, MIGRATION_4_5, MIGRATION_5_6, MIGRATION_6_7, MIGRATION_7_8,
            MIGRATION_8_9, MIGRATION_9_10, MIGRATION_10_11, MIGRATION_11_12, MIGRATION_12_13, MIGRATION_13_14,
            MIGRATION_14_15, MIGRATION_15_16, MIGRATION_16_17, MIGRATION_17_18,
        ).build()

    @Test
    fun aVersionSeventeenPalletExceptionAndRegistrySurviveTheRebuild() = runTest {
        val name = "wh-migration.db"
        context.deleteDatabase(name)
        // Build the current schema, then rewind the three rebuilt tables to their v17 DDL.
        // Room opens lazily, so the file only exists once something touches it.
        database(name).apply { openHelper.writableDatabase }.close()
        SQLiteDatabase.openOrCreateDatabase(context.getDatabasePath(name), null).use { raw ->
            raw.execSQL("DROP TABLE IF EXISTS pallet_memberships")
            raw.execSQL("DROP TABLE IF EXISTS pallet_products")
            raw.execSQL("DROP TABLE IF EXISTS pallet_permissions")
            raw.execSQL("DROP TABLE IF EXISTS pallet_label_templates")
            raw.execSQL("DROP TABLE IF EXISTS box_registry")
            raw.execSQL("DROP TABLE IF EXISTS pallets")
            raw.execSQL("DROP TABLE IF EXISTS pallet_exceptions")
            raw.execSQL(
                "CREATE TABLE `pallets` (`palletId` TEXT NOT NULL, `shiftId` TEXT NOT NULL, `terminalId` TEXT, `sscc` TEXT, " +
                    "`openedAt` TEXT NOT NULL, `closedAt` TEXT, `operatorId` TEXT, `printState` TEXT NOT NULL, `printReason` TEXT, " +
                    "`ackedAt` TEXT, PRIMARY KEY(`palletId`))",
            )
            raw.execSQL("CREATE INDEX `index_pallets_shiftId_closedAt` ON `pallets` (`shiftId`, `closedAt`)")
            raw.execSQL(
                "CREATE TABLE `pallet_exceptions` (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `kind` TEXT NOT NULL, " +
                    "`palletId` TEXT NOT NULL, `shiftId` TEXT NOT NULL, `terminalId` TEXT, `operatorId` TEXT, `reason` TEXT NOT NULL, " +
                    "`occurredAt` TEXT NOT NULL, `payloadJson` TEXT NOT NULL, `ackedAt` TEXT)",
            )
            raw.execSQL("CREATE INDEX `index_pallet_exceptions_ackedAt` ON `pallet_exceptions` (`ackedAt`)")
            raw.execSQL(
                "CREATE TABLE `writeoff_boxes` (`sscc` TEXT NOT NULL PRIMARY KEY, `boxId` TEXT NOT NULL, `productId` TEXT NOT NULL, " +
                    "`bottleCount` INTEGER NOT NULL, `contentKeysJson` TEXT NOT NULL, `updatedAt` TEXT NOT NULL)",
            )
            raw.execSQL(
                "INSERT INTO pallets VALUES ('p1','s1','dev-1','134600682000000017','2026-09-10T10:00:00.000Z','2026-09-10T11:00:00.000Z','op-1','printed',NULL,'2026-09-10T11:01:00.000Z')",
            )
            raw.execSQL(
                "INSERT INTO pallet_exceptions (kind,palletId,shiftId,terminalId,operatorId,reason,occurredAt,payloadJson,ackedAt) " +
                    "VALUES ('reprint','p1','s1','dev-1','op-1','Этикетка повреждена','2026-09-10T12:00:00.000Z','{}',NULL)",
            )
            raw.execSQL("INSERT INTO writeoff_boxes VALUES ('034600682000000018','b1','prod-1',12,'[]','t')")
            raw.execSQL("PRAGMA user_version = 17")
        }

        val db = database(name)
        try {
            val pallet = db.palletDao().get("p1")!!
            assertEquals("s1", pallet.shiftId)
            assertEquals(PalletKind.PRODUCTION, pallet.kind)
            assertNull(pallet.productId)
            assertEquals("134600682000000017", pallet.sscc)
            assertEquals(1, db.palletExceptionDao().queued().size)
            val box = db.boxRegistryDao().bySscc("034600682000000018")!!
            assertEquals(12, box.bottleCount)
            assertNull(box.palletId)
            assertEquals(false, box.palletActive)
            assertNull(box.localPalletId)

            db.palletDao().insert(
                PalletEntity(
                    palletId = "w1", shiftId = null, terminalId = "dev-1", sscc = null, openedAt = "t", closedAt = null,
                    operatorId = null, printState = PalletPrint.PENDING, printReason = null, ackedAt = null,
                    kind = PalletKind.WAREHOUSE, productId = "prod-1", deviceId = "dev-1",
                ),
            )
            assertEquals("w1", db.palletDao().openWarehouse("dev-1")?.palletId)
            db.palletMembershipDao().insert(
                PalletMembershipEntity("w1", "034600682000000018", "t", "op-1", MembershipStatus.PENDING, null, null, null, null),
            )
            assertEquals(1, db.palletMembershipDao().pending(10).size)
            assertEquals(12, db.palletMembershipDao().bottleSum("w1"))
        } finally {
            db.close()
        }
    }
}
