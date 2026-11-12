package app.markiro.handheld.core.storage

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.print.PrintTemplateStore
import app.markiro.handheld.core.print.PrintPurpose
import app.markiro.handheld.feature.shift.ShiftEntityFixtures
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PrintTemplateMigrationTest {
    @Test fun upgradeKeepsUnknownJobsAndFreezesTheirOriginalSource() = runTest {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val name = "print-template-upgrade.db"
        context.deleteDatabase(name)
        val spec = """{"widthMm":100,"heightMm":100,"dpi":203,"language":"zpl","elements":[]}"""
        val old = Room.databaseBuilder(context, HandheldDatabase::class.java, name).allowMainThreadQueries().build()
        old.shiftDao().upsert(ShiftEntityFixtures.bundled("s").copy(boxLabelTemplate = spec))
        old.boxDao().insert(BoxEntity("box", "s", "046800899000000018", "t", "t", "operator", "unknown", "link lost", null))
        val original = app.markiro.handheld.core.print.PrinterEntity("original", "Original", "wifi", "original:9100", "zpl", 203, false, null, null)
        val replacement = original.copy(id = "replacement", name = "Replacement", address = "replacement:9100")
        old.printerDao().upsert(original.copy(address = "edited:9100"))
        old.printerDao().upsert(replacement)
        old.printerDao().assign(app.markiro.handheld.core.print.PrinterAssignmentEntity("box", replacement.id))
        old.printerDao().saveDestination(app.markiro.handheld.core.print.PrintDestinationEntity("box", "box", "initial", original))
        old.boxDao().insert(BoxEntity("backfill", "s", "046800899000000025", "t", "t", "operator", "deferred", null, null))
        old.openHelper.writableDatabase.apply {
            listOf("label_template_catalog", "printer_template_choices", "print_template_snapshots").forEach { execSQL("DROP TABLE $it") }
            version = 22
        }
        old.close()
        val upgraded = Room.databaseBuilder(context, HandheldDatabase::class.java, name).addMigrations(MIGRATION_22_23, MIGRATION_23_24, MIGRATION_24_25, MIGRATION_25_26, MIGRATION_26_27, MIGRATION_27_28).allowMainThreadQueries().build()
        try {
            assertEquals(28, upgraded.openHelper.readableDatabase.version)
            assertEquals(spec, upgraded.printTemplateDao().snapshot("box", "box")?.specJson)
            assertEquals("unknown", upgraded.boxDao().get("box")?.printState)
            assertEquals("link lost", upgraded.boxDao().get("box")?.printReason)
            assertEquals("original:9100", upgraded.printerDao().destination("box", "box", "initial")?.printer?.address)
            assertEquals("replacement", upgraded.printerDao().destination("box", "backfill", "initial")?.printer?.id)
            assertEquals("deferred", upgraded.boxDao().get("backfill")?.printState)
            upgraded.initializeRecoveryForTest()
            assertEquals(spec, PrintTemplateStore(upgraded).forPrint(PrintPurpose.BOX, "box", "changed source", "p").specJson)
        } finally { upgraded.close(); context.deleteDatabase(name) }
    }
}
