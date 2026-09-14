package app.markiro.handheld.core.storage

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.print.PrintPurpose
import app.markiro.handheld.core.print.PrinterAssignmentEntity
import app.markiro.handheld.core.print.PrinterEntity
import app.markiro.handheld.core.print.assigned
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PrinterRoutingMigrationTest {
    @Test fun noSelectedProfileLeavesAllPurposesUnassigned() = runTest {
        val db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        try {
            db.printerDao().upsert(PrinterEntity("a", "A", "wifi", "a:9100", "zpl", 203, false, null, null))
            MIGRATION_12_13.migrate(db.openHelper.writableDatabase)
            PrintPurpose.entries.forEach { assertNull(db.printerDao().assigned(it)) }
        } finally { db.close() }
    }

    @Test fun selectedLegacyProfileReceivesAllPurposesOnceAndJobsRemainUnknown() = runTest {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val name = "printer-routing-upgrade.db"
        context.deleteDatabase(name)
        val old = Room.databaseBuilder(context, HandheldDatabase::class.java, name).allowMainThreadQueries().build()
        old.printerDao().upsert(PrinterEntity("a", "A", "wifi", "a:9100", "zpl", 203, false, null, null))
        old.printerDao().upsert(PrinterEntity("b", "B", "wifi", "b:9100", "tspl", 300, true, null, null))
        old.boxDao().insert(BoxEntity("box", "s", "000000000000000017", "t", "t", "operator", "unknown", "link lost", null))
        old.openHelper.writableDatabase.apply {
            execSQL("DROP TABLE printer_assignments")
            execSQL("DROP TABLE print_destinations")
            listOf("grant_state", "grant_tokens", "grant_counters", "grant_evidence", "grant_task_bindings", "grant_task_provenance").forEach { execSQL("DROP TABLE $it") }
            version = 12
        }
        old.close()
        val upgraded = Room.databaseBuilder(context, HandheldDatabase::class.java, name)
            .addMigrations(MIGRATION_12_13, MIGRATION_13_14, MIGRATION_14_15).allowMainThreadQueries().build()
        try {
            assertEquals(HANDHELD_DATABASE_VERSION, upgraded.openHelper.readableDatabase.version)
            PrintPurpose.entries.forEach { assertEquals("b", upgraded.printerDao().assigned(it)?.id) }
            assertEquals(listOf("a", "b"), upgraded.printerDao().all().map { it.id })
            assertEquals("unknown", upgraded.boxDao().get("box")?.printState)
            assertEquals("link lost", upgraded.boxDao().get("box")?.printReason)
            assertNull(upgraded.printerDao().destination("box", "box", "initial"))
            upgraded.printerDao().assign(PrinterAssignmentEntity("pallet", null))
            MIGRATION_12_13.migrate(upgraded.openHelper.writableDatabase)
            assertNull(upgraded.printerDao().assigned(PrintPurpose.PALLET))
            assertEquals("b", upgraded.printerDao().assigned(PrintPurpose.BOX)?.id)
        } finally {
            upgraded.close()
            context.deleteDatabase(name)
        }
    }
}
