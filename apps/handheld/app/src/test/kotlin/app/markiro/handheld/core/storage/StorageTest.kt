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
        val store = RosterStore(db.operatorDao())
        store.replace(listOf(record("op-1", "Анна"), record("op-2", "Пётр")))
        store.replace(listOf(record("op-3", "Ольга")))
        assertEquals(listOf("Ольга"), store.operators().map { it.name })
    }

    @Test
    fun wipeClearsConfigRosterAndCredential() = runTest {
        val credential = InMemoryCredentialStore().apply { write("mk_live_secret") }
        db.deviceConfigDao().upsert(sampleConfig())
        RosterStore(db.operatorDao()).replace(listOf(record("op-1", "Анна")))
        DeviceWipe(db.deviceConfigDao(), db.operatorDao(), credential).wipeAll()
        assertNull(db.deviceConfigDao().get())
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
