package app.markiro.handheld.core.host

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.box.SsccPool
import app.markiro.handheld.core.host.HostPalletFixtures.ok
import app.markiro.handheld.core.host.HostPalletFixtures.routes
import app.markiro.handheld.core.network.host.HostApi
import app.markiro.handheld.core.network.host.HostResult
import app.markiro.handheld.core.network.host.TransportFailure
import app.markiro.handheld.core.pallets.SsccBlockApplier
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class HostHeartbeatTest {
    private lateinit var db: HandheldDatabase
    private lateinit var meta: MetaStore
    private val monitor = HostLinkMonitor(now = { java.time.Instant.parse("2026-10-15T09:00:00Z").toEpochMilli() }, onRestore = {})

    @Before
    fun open() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java).allowMainThreadQueries().build()
        runBlocking { db.deviceConfigDao().upsert(HostFactsFixtures.config(db)) }
        db.initializeRecoveryForTest()
        meta = MetaStore(db)
    }

    @After
    fun close() = db.close()

    private fun hello(epoch: String) =
        ok("""{"product":"markiro-host","protocol":6,"minProtocol":1,"hostId":"h","time":"2026-10-15T09:00:00Z","initialized":true,"restoreEpoch":"$epoch"}""")

    private fun heartbeat(transport: HostPalletFixtures.Routes): HostHeartbeat {
        val api = HostApi(transport)
        val pool = SsccPool(db)
        return HostHeartbeat(db, monitor, { api }, db.deviceConfigDao(), HostBlockSupplier(db, meta, api, pool, SsccBlockApplier(pool)), meta)
    }

    @Test
    fun aBeatMakesTheLinkStateReal() = runTest {
        val up = routes("/v1/hello" to listOf(hello("e1")))
        heartbeat(up).beat()
        assertEquals(HostLinkStatus.Online, HostLinkStatus.of(monitor.state.value))
        val down = routes("/v1/hello" to listOf(HostResult.Failed(TransportFailure.UNREACHABLE)))
        heartbeat(down).beat()
        assertEquals(HostLinkStatus.Offline, HostLinkStatus.of(monitor.state.value))
    }

    @Test
    fun aRestoredHostIsToldTheBlocksThisDeviceHoldsAndTheRegistryWalksFromScratch() = runTest {
        HostFactsFixtures.pool(db)
        // the pool of the fixture has no host block ids: give the ranges theirs, as a host-paired device holds them
        db.ssccPoolDao().clear()
        SsccPool(db).addRange(app.markiro.handheld.core.box.ServerRange(HostFactsFixtures.PREFIX, 0, 1500, 3499, null, HostFactsFixtures.BOX_BLOCK))
        meta.put(MetaStore.BOX_REGISTRY_UNTIL, "2026-10-08T07:30:00Z")
        val first = routes("/v1/hello" to listOf(hello("e1")))
        heartbeat(first).beat()
        assertEquals("e1", db.deviceConfigDao().get()!!.hostRestoreEpoch)
        assertEquals("the first epoch is only remembered", "2026-10-08T07:30:00Z", meta.get(MetaStore.BOX_REGISTRY_UNTIL))

        val restored = routes(
            "/v1/hello" to listOf(hello("e2")),
            "/v1/device/sscc/blocks/known" to listOf(ok("""{"results":[{"id":"${HostFactsFixtures.BOX_BLOCK}","outcome":"registered"}]}""")),
        )
        heartbeat(restored).beat()
        assertEquals(1, restored.requests.count { it.startsWith("/v1/device/sscc/blocks/known") })
        assertEquals("e2", db.deviceConfigDao().get()!!.hostRestoreEpoch)
        assertNull(meta.get(MetaStore.BOX_REGISTRY_UNTIL))
    }

    @Test
    fun aCloudDeviceIsNeverAskedAnything() = runTest {
        db.deviceConfigDao().upsert(HostFactsFixtures.config(db, backend = "cloud"))
        val transport = routes("/v1/hello" to listOf(hello("e1")))
        heartbeat(transport).beat()
        assertEquals(emptyList<String>(), transport.requests)
    }

    @Test
    fun theSyncLoopBeatsOnEveryTurnBeforeItSendsTheQueue() = runBlocking {
        val beats = java.util.concurrent.atomic.AtomicInteger()
        val engine = HostSyncEngine(
            db, { HostApi(routes("/v1/device/facts" to listOf(ok("""{"receipts":[]}""")))) }, HostAckMapper(db), HostCalls { }, db.deviceConfigDao(),
            heartbeatMs = 10, beat = { beats.incrementAndGet() },
        )
        engine.start()
        kotlinx.coroutines.withTimeout(5_000) { while (beats.get() < 3) kotlinx.coroutines.delay(10) }
        assertEquals(true, beats.get() >= 3)
    }

    @Test
    fun aBeatThatFailsInItsOwnWayDoesNotStopTheLoop() = runBlocking {
        val beats = java.util.concurrent.atomic.AtomicInteger()
        val engine = HostSyncEngine(
            db, { HostApi(routes("/v1/device/facts" to listOf(ok("""{"receipts":[]}""")))) }, HostAckMapper(db), HostCalls { }, db.deviceConfigDao(),
            heartbeatMs = 10, beat = { beats.incrementAndGet(); error("boom") },
        )
        engine.start()
        kotlinx.coroutines.withTimeout(5_000) { while (beats.get() < 3) kotlinx.coroutines.delay(10) }
        assertEquals(true, beats.get() >= 3)
    }

    @Test
    fun aBeatThatReachedTheHostAsksForTheDeviceRecordSoALaterLineAssignmentIsTaken() = runTest {
        val api = HostApi(routes("/v1/hello" to listOf(hello("e1")), "/v1/device" to listOf(ok("""{"id":"d1","kind":"handheld","name":"ТСД","lineId":"line-7"}"""))))
        val pool = SsccPool(db)
        val reference = HostReferenceSync(db, db.deviceConfigDao(), meta, api)
        HostHeartbeat(db, monitor, { api }, db.deviceConfigDao(), HostBlockSupplier(db, meta, api, pool, SsccBlockApplier(pool)), meta) { reference.refreshDevice() }.beat()
        assertEquals("line-7", db.deviceConfigDao().get()!!.lineId)
    }
}
