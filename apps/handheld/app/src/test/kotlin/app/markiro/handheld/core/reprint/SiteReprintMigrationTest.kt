package app.markiro.handheld.core.reprint

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MIGRATION_23_24
import app.markiro.handheld.core.storage.MIGRATION_24_25
import app.markiro.handheld.core.storage.MIGRATION_25_26
import app.markiro.handheld.core.storage.MIGRATION_26_27
import app.markiro.handheld.core.storage.MIGRATION_27_28
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
            val upgraded = Room.databaseBuilder(context, HandheldDatabase::class.java, name).addMigrations(MIGRATION_23_24, MIGRATION_24_25, MIGRATION_25_26, MIGRATION_26_27, MIGRATION_27_28).allowMainThreadQueries().build()
            try {
                assertEquals("existing", upgraded.metaDao().get("kept-setting"))
                assertTrue(upgraded.siteReprintDao().owed("owner", 1).isEmpty())
                assertTrue(upgraded.siteReprintDao().unresolved("owner", 1).isEmpty())
                assertEquals(28, upgraded.openHelper.readableDatabase.version)
            } finally { upgraded.close() }
        } finally { context.deleteDatabase(name) }
    }
    @Test fun upgradingRoom24AddsIndexesWithoutChangingFrozenAudit() = runTest {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val name = "reprint-index-migration-${UUID.randomUUID()}"
        val saved = SiteReprintAudit("event", "job", "original-owner", 7, "host", 3, "2026-11-01T10:00:00Z", "exact-frozen-envelope")
        val old = Room.databaseBuilder(context, HandheldDatabase::class.java, name).allowMainThreadQueries().build()
        old.siteReprintDao().append(saved)
        old.openHelper.writableDatabase.apply {
            execSQL("DROP INDEX index_site_reprint_audit_jobId")
            execSQL("DROP INDEX index_site_reprint_audit_ownerJson_generation_state")
            execSQL("PRAGMA user_version = 24")
        }
        old.close()
        try {
            val upgraded = Room.databaseBuilder(context, HandheldDatabase::class.java, name)
                .addMigrations(MIGRATION_24_25, MIGRATION_25_26, MIGRATION_26_27, MIGRATION_27_28).allowMainThreadQueries().build()
            try {
                assertEquals(saved, upgraded.siteReprintDao().audit(saved.recordId))
                assertEquals(listOf(saved), upgraded.siteReprintDao().history(saved.jobId))
                assertEquals(ReprintAuditCounts(1, 0), upgraded.siteReprintDao().counts(saved.ownerJson, saved.generation))
                assertEquals(28, upgraded.openHelper.readableDatabase.version)
            } finally { upgraded.close() }
        } finally { context.deleteDatabase(name) }
    }

}
