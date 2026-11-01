package app.markiro.handheld.core.storage

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.print.PrinterEntity
import app.markiro.handheld.core.print.PrintDestinationEntity
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class PrinterOutputModeMigrationTest {
    @Test fun room25PreservesLegacyPrinterDestinationsAndUnknownJobs() = runTest {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val name = "output-mode-${UUID.randomUUID()}"
        val printer = PrinterEntity("p", "Original", "wifi", "p:9100", "zpl", 203, true, null, null)
        val original = Room.databaseBuilder(context, HandheldDatabase::class.java, name).allowMainThreadQueries().build()
        original.printerDao().upsert(printer)
        original.printerDao().saveDestination(PrintDestinationEntity("box", "box", "initial", printer))
        original.boxDao().insert(BoxEntity("box", "s", "046800899000000018", "t", "t", "operator", "unknown", "link lost", null))
        original.metaDao().put(MetaEntity("frozen-bytes", "AAH+/w=="))
        original.openHelper.writableDatabase.apply {
            removeOutputModeColumn(this, "printers", "outputMode")
            removeOutputModeColumn(this, "print_destinations", "printer_outputMode")
            version = 25
        }
        original.close()
        val upgraded = Room.databaseBuilder(context, HandheldDatabase::class.java, name)
            .addMigrations(MIGRATION_25_26).allowMainThreadQueries().build()
        try {
            assertEquals(26, upgraded.openHelper.readableDatabase.version)
            assertEquals(printer, upgraded.printerDao().get("p"))
            assertEquals(printer, upgraded.printerDao().destination("box", "box", "initial")?.printer)
            assertEquals("unknown", upgraded.boxDao().get("box")?.printState)
            assertEquals("AAH+/w==", upgraded.metaDao().get("frozen-bytes"))
            upgraded.printerDao().upsert(printer.copy(outputMode = "peel"))
            assertEquals("peel", upgraded.printerDao().get("p")?.outputMode)
            assertNull(upgraded.printerDao().destination("box", "box", "initial")?.printer?.outputMode)
        } finally { upgraded.close(); context.deleteDatabase(name) }
    }
}

/** Android 28 SQLite cannot DROP COLUMN; rebuild the exact historical table instead. */
private fun removeOutputModeColumn(db: androidx.sqlite.db.SupportSQLiteDatabase, table: String, column: String) {
    val columns = db.query("PRAGMA table_info(`$table`)").use { rows ->
        buildList { while (rows.moveToNext()) {
            val name = rows.getString(rows.getColumnIndexOrThrow("name"))
            if (name != column) add(name)
        } }
    }
    val sql = db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", arrayOf<Any>(table)).use { rows ->
        check(rows.moveToFirst()); rows.getString(0)
    }
    val historical = sql.replace(Regex(",\\s*`?$column`? TEXT"), "")
    check(historical != sql)
    db.execSQL("ALTER TABLE `$table` RENAME TO `${table}_current`")
    db.execSQL(historical)
    val selection = columns.joinToString(",") { "`$it`" }
    db.execSQL("INSERT INTO `$table` ($selection) SELECT $selection FROM `${table}_current`")
    db.execSQL("DROP TABLE `${table}_current`")
}
