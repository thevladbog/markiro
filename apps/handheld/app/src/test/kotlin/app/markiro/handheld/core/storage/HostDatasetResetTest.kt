package app.markiro.handheld.core.storage

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.network.CredentialDto
import app.markiro.handheld.core.network.DeviceDto
import app.markiro.handheld.core.network.PairResponse
import app.markiro.handheld.core.print.PrinterEntity
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class HostDatasetResetTest {
    private val context get() = ApplicationProvider.getApplicationContext<android.content.Context>()
    private val origin = "https://192.168.1.10:45710"
    private val host = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f"
    private val epoch = "8b134f46-5501-4ba2-931e-fde1e7251951"

    @Test fun changedDatasetBlocksOldCallbacksAndOnlyFreshStartupPurgesBusinessRows() = runTest {
        val name = "dataset-${java.util.UUID.randomUUID()}.db"
        val credential = InMemoryCredentialStore()
        var db = Room.databaseBuilder(context, HandheldDatabase::class.java, name).allowMainThreadQueries().build()
        try {
            val recovery = DeviceRecovery(db, credential).also { it.initialize() }
            recovery.restore(PairResponse(DeviceDto("d1", "ТСД", "handheld", host, "Organization", null), CredentialDto("key", origin), emptyList()), origin, HostPairing("ab".repeat(32), host, listOf("192.168.1.10")))
            val token = recovery.token()
            db.metaDao().put(MetaEntity("old-business-cursor", "saved"))
            db.boxDao().insert(BoxEntity("old-box", "old-shift", null, "2026-10-18T00:00:00Z", null, null, "none", null, null))
            val printer = PrinterEntity("printer", "Printer", "wifi", "192.168.1.20:9100", "tspl", 203, true, null, null)
            db.printerDao().upsert(printer)
            assertFalse(recovery.observeHostDataset(host, null))
            assertTrue(recovery.observeHostDataset(host, epoch))
            assertEquals(RecoveryPhase.DATASET_RESET_PENDING, recovery.current().phase)
            assertFalse(recovery.valid(token))
            assertEquals("key", credential.read())
            assertNull(recovery.processDatasetEpoch())
            assertNotNull(db.boxDao().get("old-box"))
            assertTrue(runCatching { recovery.commit(token) { db.metaDao().put(MetaEntity("late", "old")) } }.isFailure)
            db.metaDao().put(MetaEntity("late-raw-callback", "old"))
            recovery.initialize()
            assertNotNull("same process must not purge or regain authority", db.boxDao().get("old-box"))
            assertEquals(RecoveryPhase.DATASET_RESET_PENDING, recovery.current().phase)
            db.close()
            db = Room.databaseBuilder(context, HandheldDatabase::class.java, name).allowMainThreadQueries().build()
            val fresh = DeviceRecovery(db, credential).also { it.initialize() }
            assertEquals(RecoveryPhase.ACTIVE, fresh.current().phase)
            assertEquals(epoch, fresh.processDatasetEpoch())
            assertNull(db.boxDao().get("old-box"))
            assertNull(db.metaDao().get("old-business-cursor"))
            assertNull(db.metaDao().get("late-raw-callback"))
            assertEquals(listOf(printer), db.printerDao().all())
            assertEquals("d1", db.deviceConfigDao().get()!!.deviceId)
            assertEquals("key", credential.read())
            assertTrue(fresh.observeHostDataset(host, null))
            assertEquals(epoch, fresh.processDatasetEpoch())
            db.close()
            db = Room.databaseBuilder(context, HandheldDatabase::class.java, name).allowMainThreadQueries().build()
            val restored = DeviceRecovery(db, credential).also { it.initialize() }
            assertEquals(RecoveryPhase.ACTIVE, restored.current().phase)
            assertNull(restored.processDatasetEpoch())
        } finally { db.close(); context.deleteDatabase(name) }
    }
    private suspend fun pair(db: HandheldDatabase, credential: CredentialStore): DeviceRecovery {
        val recovery = DeviceRecovery(db, credential).also { it.initialize() }
        recovery.restore(PairResponse(DeviceDto("d1", "ТСД", "handheld", host, "Organization", null), CredentialDto("key", origin), emptyList()), origin, HostPairing("ab".repeat(32), host, listOf("192.168.1.10")))
        return recovery
    }

    @Test fun aFailedPendingWriteStaysFrozenAndCanRetryWithoutPurgingThisProcess() = runTest {
        val db = Room.inMemoryDatabaseBuilder(context, HandheldDatabase::class.java).allowMainThreadQueries().build()
        try {
            val credential = InMemoryCredentialStore()
            val recovery = pair(db, credential)
            db.metaDao().put(MetaEntity("old", "business"))
            db.openHelper.writableDatabase.execSQL("CREATE TRIGGER refuse_marker BEFORE INSERT ON device_recovery WHEN NEW.phase = 'DATASET_RESET_PENDING' BEGIN SELECT RAISE(ABORT, 'full'); END")
            assertTrue(runCatching { recovery.observeHostDataset(host, epoch) }.isFailure)
            assertEquals(RecoveryPhase.DATASET_RESET_PENDING, recovery.current().phase)
            assertEquals("ACTIVE", db.deviceRecoveryDao().get()!!.phase)
            assertFalse(recovery.datasetRestartReady.value)
            assertTrue(recovery.datasetResetFailed.value)
            assertTrue(runCatching { recovery.printing { error("must never start") } }.isFailure)
            assertEquals("key", credential.read())
            db.openHelper.writableDatabase.execSQL("DROP TRIGGER refuse_marker")
            recovery.retryHostDatasetReset()
            assertTrue(recovery.datasetRestartReady.value)
            assertFalse(recovery.datasetResetFailed.value)
            assertEquals("DATASET_RESET_PENDING", db.deviceRecoveryDao().get()!!.phase)
            recovery.initialize()
            assertEquals("business", db.metaDao().get("old"))
        } finally { db.close() }
    }

    @Test fun aFailedStartupPurgeRollsBackAndRetriesBeforeAnyActiveWork() = runTest {
        val name = "dataset-failure-${java.util.UUID.randomUUID()}.db"
        val credential = InMemoryCredentialStore()
        var db = Room.databaseBuilder(context, HandheldDatabase::class.java, name).allowMainThreadQueries().build()
        try {
            val old = pair(db, credential)
            db.metaDao().put(MetaEntity("old", "business"))
            old.observeHostDataset(host, epoch)
            db.close()
            db = Room.databaseBuilder(context, HandheldDatabase::class.java, name).allowMainThreadQueries().build()
            db.openHelper.writableDatabase.execSQL("CREATE TRIGGER refuse_purge BEFORE DELETE ON meta BEGIN SELECT RAISE(ABORT, 'full'); END")
            val fresh = DeviceRecovery(db, credential)
            assertTrue(runCatching { fresh.initialize() }.isFailure)
            assertEquals(RecoveryPhase.DATASET_RESET_PENDING, fresh.current().phase)
            assertTrue(fresh.datasetResetFailed.value)
            assertTrue(fresh.datasetRestartReady.value)
            assertEquals("business", db.metaDao().get("old"))
            assertNull(db.deviceConfigDao().get()!!.hostDatasetEpoch)
            assertEquals("key", credential.read())
            db.openHelper.writableDatabase.execSQL("DROP TRIGGER refuse_purge")
            fresh.retryHostDatasetReset()
            assertEquals(RecoveryPhase.ACTIVE, fresh.current().phase)
            assertEquals(epoch, fresh.processDatasetEpoch())
            assertNull(db.metaDao().get("old"))
        } finally { db.close(); context.deleteDatabase(name) }
    }

    @Test fun cloudDataAndAnUnrelatedHostNeverEnterDatasetReset() = runTest {
        val db = Room.inMemoryDatabaseBuilder(context, HandheldDatabase::class.java).allowMainThreadQueries().build()
        try {
            val credential = InMemoryCredentialStore().apply { write("cloud-key") }
            db.deviceConfigDao().upsert(syntheticDeviceConfig())
            db.metaDao().put(MetaEntity("cloud-cursor", "kept"))
            val recovery = DeviceRecovery(db, credential).also { it.initialize() }
            assertFalse(recovery.observeHostDataset(host, epoch))
            assertEquals(RecoveryPhase.ACTIVE, recovery.current().phase)
            assertEquals("kept", db.metaDao().get("cloud-cursor"))
        } finally { db.close() }
        val hostDb = Room.inMemoryDatabaseBuilder(context, HandheldDatabase::class.java).allowMainThreadQueries().build()
        try {
            val recovery = pair(hostDb, InMemoryCredentialStore())
            assertTrue(runCatching { recovery.observeHostDataset("another-host", epoch) }.isFailure)
            assertEquals(RecoveryPhase.ACTIVE, recovery.current().phase)
        } finally { hostDb.close() }
    }

    @Test fun heartbeatDetectsDatasetBeforeRegisteringOldSsccBlocksAfterRestore() = runTest {
        val db = Room.inMemoryDatabaseBuilder(context, HandheldDatabase::class.java).allowMainThreadQueries().build()
        try {
            val recovery = pair(db, InMemoryCredentialStore())
            val requests = mutableListOf<String>()
            val transport = object : app.markiro.handheld.core.network.host.HostTransport {
                override suspend fun get(path: String): app.markiro.handheld.core.network.host.HostResult {
                    requests += path
                    return app.markiro.handheld.core.network.host.HostResult.Ok(200, """{"product":"markiro-host","protocol":6,"minProtocol":1,"hostId":"$host","datasetEpoch":"$epoch","restoreEpoch":"restored"}""", null)
                }
                override suspend fun post(path: String, body: String): app.markiro.handheld.core.network.host.HostResult = error("old blocks must not be registered")
            }
            val api = app.markiro.handheld.core.network.host.HostApi(transport)
            val pool = app.markiro.handheld.core.box.SsccPool(db)
            val meta = MetaStore(db)
            val supplier = app.markiro.handheld.core.host.HostBlockSupplier(db, meta, api, pool, app.markiro.handheld.core.pallets.SsccBlockApplier(pool))
            app.markiro.handheld.core.host.HostHeartbeat(db, app.markiro.handheld.core.host.HostLinkMonitor({ 0L }, {}), { api }, db.deviceConfigDao(), supplier, meta).beat()
            assertEquals(listOf("/v1/hello"), requests)
            assertEquals(RecoveryPhase.DATASET_RESET_PENDING, recovery.current().phase)
            assertNull(db.deviceConfigDao().get()!!.hostRestoreEpoch)
        } finally { db.close() }
    }

}
