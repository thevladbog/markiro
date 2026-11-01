package app.markiro.handheld.core.reprint

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MIGRATION_23_24
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class SiteReprintMigrationTest {
    @Test fun upgradingRoom23PreservesExistingSettingsAndStartsAnEmptyJournal() = runTest {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val name = "reprint-migration-${UUID.randomUUID()}"
        val old = Room.databaseBuilder(context, HandheldDatabase::class.java, name).allowMainThreadQueries().build()
        old.openHelper.writableDatabase.apply {
            execSQL("INSERT INTO meta(`key`, value) VALUES('kept-setting', 'existing')")
            execSQL("DROP TABLE site_reprint_audit")
            execSQL("DROP TABLE site_reprint_jobs")
            execSQL("PRAGMA user_version = 23")
        }
        old.close()
        try {
            val upgraded = Room.databaseBuilder(context, HandheldDatabase::class.java, name).addMigrations(MIGRATION_23_24).allowMainThreadQueries().build()
            try {
                assertEquals("existing", upgraded.metaDao().get("kept-setting"))
                assertTrue(upgraded.siteReprintDao().owed("owner", 1).isEmpty())
                assertTrue(upgraded.siteReprintDao().unresolved("owner", 1).isEmpty())
                assertEquals(24, upgraded.openHelper.readableDatabase.version)
            } finally { upgraded.close() }
        } finally { context.deleteDatabase(name) }
    }
}
