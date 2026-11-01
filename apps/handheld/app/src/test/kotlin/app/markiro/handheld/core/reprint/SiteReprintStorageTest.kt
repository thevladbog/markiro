package app.markiro.handheld.core.reprint

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.storage.HandheldDatabase
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SiteReprintStorageTest {
    @Test fun printJobsAndAuditHaveIndependentDurableTables() {
        val db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        try {
            val names = db.openHelper.readableDatabase.query("SELECT name FROM sqlite_master WHERE type='table'").use { rows ->
                buildSet { while (rows.moveToNext()) add(rows.getString(0)) }
            }
            assertTrue("prepared print jobs must survive process recreation", "site_reprint_jobs" in names)
            assertTrue("audit upload must be independent of physical print state", "site_reprint_audit" in names)
        } finally { db.close() }
    }
}
