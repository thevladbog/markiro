package app.markiro.handheld.core.storage

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.cash.turbine.test
import app.markiro.handheld.core.auth.OperatorRecord
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class StorageTest {
    private lateinit var db: HandheldDatabase

    @Before
    fun open() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries()
            .build()
    }

    @After
    fun close() = db.close()

    @Test
    fun configIsASingletonRowObservedAsAFlow() = runTest {
        val dao = db.deviceConfigDao()
        dao.observe().test {
            assertNull(awaitItem())
            dao.upsert(sampleConfig())
            assertEquals("dev-1", awaitItem()?.deviceId)
            dao.upsert(sampleConfig().copy(deviceName = "ТСД 2"))
            assertEquals("ТСД 2", awaitItem()?.deviceName)
            cancelAndIgnoreRemainingEvents()
        }
        assertEquals(1, db.deviceConfigDao().count())
    }

    @Test
    fun rosterStoreReplacesTheWholeMirror() = runTest {
        val store = RosterStore(db.operatorDao(), db.initializeRecoveryForTest())
        store.replace(listOf(record("op-1", "Анна"), record("op-2", "Пётр")))
        store.replace(listOf(record("op-3", "Ольга")))
        assertEquals(listOf("Ольга"), store.operators().map { it.name })
    }

    @Test
    fun rejectionPreservesEveryOperationalChannelAndRemovesSecrets() = runTest {
        val credential = InMemoryCredentialStore().apply { write("mk_live_secret") }
        db.deviceConfigDao().upsert(sampleConfig())
        RosterStore(db.operatorDao(), db.initializeRecoveryForTest(credential)).replace(listOf(record("op-1", "Анна")))
        val sqlite = db.openHelper.writableDatabase
        val tables = sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('room_master_table','android_metadata','device_config','operators','device_recovery')").use { cursor ->
            buildList { while (cursor.moveToNext()) add(cursor.getString(0)) }
        }
        for (table in tables) {
            val values = android.content.ContentValues()
            sqlite.query("PRAGMA table_info(`$table`)").use { columns ->
                while (columns.moveToNext()) {
                    val name = columns.getString(1)
                    if (columns.getString(2) == "INTEGER") values.put(name, 7L)
                    else values.put(name, "saved:$table:$name\u001d")
                }
            }
            sqlite.insert(table, android.database.sqlite.SQLiteDatabase.CONFLICT_ABORT, values)
        }
        fun capture() = tables.associateWith { table ->
            sqlite.query("SELECT * FROM `$table`").use { rows ->
                buildList { while (rows.moveToNext()) add((0 until rows.columnCount).map { rows.getString(it) }) }
            }
        }
        val saved = capture()
        DeviceWipe(db.recovery).reject(db.recovery.token())
        assertEquals(saved, capture())
        assertEquals(sampleConfig(), db.deviceConfigDao().get())
        assertEquals(emptyList<OperatorEntity>(), db.operatorDao().all())
        assertNull(credential.read())
    }

    private fun sampleConfig() = DeviceConfigEntity(
        deviceId = "dev-1",
        deviceName = "ТСД 1",
        tenantId = "t-1",
        organizationName = "ООО «Родник»",
        lineId = "line-2",
        lineName = "Линия 2",
        kind = "handheld",
        serverUrl = "https://admin.markiro.app",
        pairedAt = 1_757_500_000_000L,
    )

    private fun record(id: String, name: String) =
        OperatorRecord(id, name, "4127", "operator", "pbkdf2\$sha256\$100000\$x\$y", null, true)
}
