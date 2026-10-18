package app.markiro.handheld.core.grants

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import app.markiro.handheld.core.storage.syntheticDeviceConfig
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class GrantHostModeTest {
    private fun count(db: HandheldDatabase, table: String): Long =
        db.openHelper.readableDatabase.query("SELECT COUNT(*) FROM `$table`").use { it.moveToFirst(); it.getLong(0) }

    @Test
    fun aHostDeviceWritesNoGrantEvidenceAndACloudOneStillDoes() = runTest {
        val db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        try {
            db.deviceConfigDao().upsert(syntheticDeviceConfig().copy(backend = "host"))
            db.initializeRecoveryForTest()
            db.grants.start(TaskKind.SHIFT, "s1", "shift.enter:s1")
            db.grants.complete(TaskKind.SHIFT, "s1", "shift.scan:1", GrantEventType.SHIFT_SCAN, units = 1)
            assertEquals(0L, count(db, "grant_evidence"))
            db.deviceConfigDao().upsert(syntheticDeviceConfig().copy(backend = "cloud"))
            db.grants.start(TaskKind.SHIFT, "s2", "shift.enter:s2")
            assertEquals(1L, count(db, "grant_evidence"))
        } finally {
            db.close()
        }
    }
}
