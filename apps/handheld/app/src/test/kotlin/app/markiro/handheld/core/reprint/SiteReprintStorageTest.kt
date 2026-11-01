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
    @Test fun freshSchemaIndexesTheAuditLookups() {
        val db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        try {
            val columns = db.openHelper.readableDatabase.query("PRAGMA index_list('site_reprint_audit')").use { rows ->
                buildList {
                    while (rows.moveToNext()) {
                        val name = rows.getString(rows.getColumnIndexOrThrow("name"))
                        if (name.startsWith("index_")) add(db.openHelper.readableDatabase.query("PRAGMA index_info('$name')").use { info ->
                            buildList { while (info.moveToNext()) add(info.getString(info.getColumnIndexOrThrow("name"))) }
                        })
                    }
                }
            }
            org.junit.Assert.assertEquals(setOf(listOf("jobId"), listOf("ownerJson", "generation", "state")), columns.toSet())
        } finally { db.close() }
    }

}
