package app.markiro.handheld.core.sync

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.cash.turbine.test
import app.markiro.handheld.core.network.NetworkModule
import app.markiro.handheld.core.network.RevocationBus
import app.markiro.handheld.core.network.RevocationInterceptor
import app.markiro.handheld.core.storage.ConflictEntity
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.storage.OutboxEntity
import app.markiro.handheld.core.storage.ShiftCloseEntity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SyncEngineTest {
    private lateinit var db: HandheldDatabase
    private lateinit var server: MockWebServer
    private val bus = RevocationBus()
    private val strict = NetworkModule.strictJson()
    private var clock = 1_757_500_000_000L

    @Before
    fun setUp() = runTest {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        server = MockWebServer().also { it.start() }
        db.deviceConfigDao().upsert(
            DeviceConfigEntity(
                deviceId = "dev-1", deviceName = "ТСД 1", tenantId = "t-1", organizationName = "ООО", lineId = "l1",
                lineName = "Линия 2", kind = "handheld", serverUrl = server.url("/").toString(), pairedAt = 1L,
            ),
        )
    }

    @After
    fun tearDown() {
        server.shutdown()
        db.close()
    }

    private fun engine(): SyncEngine {
        val client = OkHttpClient.Builder().addInterceptor(RevocationInterceptor(bus, Json { ignoreUnknownKeys = true })).build()
        val transport = SyncTransport(client) { server.url("/").toString() }
        return SyncEngine(
            db = db, meta = MetaStore(db.metaDao()), config = db.deviceConfigDao(), transport = transport, json = strict,
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined), clock = { clock },
        )
    }

    private suspend fun outbox(raw: String, verdict: String = "ok") = db.outboxDao().insert(
        OutboxEntity(
            shiftId = "s1", raw = raw, verdict = verdict, scannedAt = "2026-09-10T10:00:00.000Z", operatorId = "op-1",
            codeHash = if (verdict == "ok") "a".repeat(64) else null,
            gtin14 = if (verdict == "ok") "04600682000013" else null,
            serial = if (verdict == "ok") raw else null,
        ),
    )

    private fun ok(applied: Int, conflicts: String = "[]") =
        MockResponse().setResponseCode(201).setBody("""{"applied":$applied,"alreadyApplied":false,"conflicts":$conflicts}""")

    @Test
    fun postsAContiguousPrefixAndAcksIt() = runTest {
        outbox("a")
        outbox("b", "invalid")
        outbox("c")
        server.enqueue(ok(3))
        assertTrue(engine().drainAll())
        val request = server.takeRequest()
        assertEquals("/station/scans", request.path)
        val body = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
        val installId = MetaStore(db.metaDao()).installId()
        assertEquals("dev-1:$installId:3", body.getValue("batchId").jsonPrimitive.content)
        val items = body.getValue("items").jsonArray
        assertEquals(3, items.size)
        assertEquals("dev-1", items[0].jsonObject.getValue("terminalId").jsonPrimitive.content)
        assertEquals("null", items[1].jsonObject.getValue("code").toString())
        assertEquals("a".repeat(64), items[0].jsonObject.getValue("code").jsonObject.getValue("codeHash").jsonPrimitive.content)
        assertEquals(0, db.outboxDao().countNow())
        assertNull(db.metaDao().get(MetaStore.SYNC_PENDING_BATCH_ID))
        assertEquals(clock, db.metaDao().get(MetaStore.SYNC_LAST_SUCCESS_AT)?.toLong())
    }

    @Test
    fun retryResendsThePinnedBatchUnchangedEvenAfterNewScans() = runTest {
        outbox("a")
        outbox("b")
        server.enqueue(MockResponse().setResponseCode(500))
        val e = engine()
        assertFalse(e.drainAll())
        assertNotNull(db.metaDao().get(MetaStore.SYNC_PENDING_CEILING))
        outbox("late")
        server.enqueue(ok(2))
        server.enqueue(ok(1))
        assertTrue(e.drainAll())
        val first = server.takeRequest().body.readUtf8()
        val second = server.takeRequest().body.readUtf8()
        val third = server.takeRequest().body.readUtf8()
        assertEquals(first, second)
        assertEquals(2, Json.parseToJsonElement(second).jsonObject.getValue("items").jsonArray.size)
        assertEquals(1, Json.parseToJsonElement(third).jsonObject.getValue("items").jsonArray.size)
        assertEquals(0, db.outboxDao().countNow())
    }

    @Test
    fun aPartialAckIsNotAcked() = runTest {
        outbox("a")
        outbox("b")
        server.enqueue(ok(1))
        assertFalse(engine().drainAll())
        assertEquals(2, db.outboxDao().countNow())
        assertNotNull(db.metaDao().get(MetaStore.SYNC_PENDING_CEILING))
    }

    @Test
    fun alreadyAppliedIsSuccess() = runTest {
        outbox("a")
        server.enqueue(MockResponse().setResponseCode(201).setBody("""{"applied":0,"alreadyApplied":true,"conflicts":[]}"""))
        assertTrue(engine().drainAll())
        assertEquals(0, db.outboxDao().countNow())
    }

    @Test
    fun aMalformedOkIsNotAcked() = runTest {
        outbox("a")
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"status":"ok"}"""))
        assertFalse(engine().drainAll())
        assertEquals(1, db.outboxDao().countNow())
        assertNotNull(db.metaDao().get(MetaStore.SYNC_PENDING_BATCH_ID))
    }

    @Test
    fun conflictsAreRecordedAndBadOnesIgnored() = runTest {
        outbox("a")
        server.enqueue(
            ok(
                1,
                """[{"codeHash":"h1","winningTerminalId":"dev-2","winningScannedAt":"2026-09-10T09:00:00.000Z"},
                    {"codeHash":"h2","winningTerminalId":null,"winningScannedAt":"not a date"}]""",
            ),
        )
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"reviewedCodeHashes":[]}"""))
        assertTrue(engine().drainAll())
        val rows = db.conflictDao().observeAll().first()
        assertEquals(listOf("h1"), rows.map { it.codeHash })
        assertEquals("dev-2", rows.single().winningTerminalId)
    }

    @Test
    fun pendingClosesAreDrainedAfterScansAndConflictsMarked() = runTest {
        db.shiftCloseDao().insert(
            ShiftCloseEntity("e1", "s1", "op-1", 10, 8, 0, "material_shortage", "2026-09-10T12:00:00.000Z", "pending", null, null),
        )
        db.shiftCloseDao().insert(ShiftCloseEntity("e2", "s2", null, null, 3, 0, null, "2026-09-10T12:01:00.000Z", "pending", null, null))
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"outcome":"accepted"}"""))
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"outcome":"conflict","conflictCode":"multiple_devices"}"""))
        assertTrue(engine().drainAll())
        assertEquals("/station/shift-closures", server.takeRequest().path)
        val body = Json.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
        assertEquals("s2", body.getValue("shiftId").jsonPrimitive.content)
        assertEquals("null", body.getValue("reasonCode").toString())
        assertEquals("accepted", db.shiftCloseDao().forShift("s1")?.state)
        assertTrue(db.shiftCloseDao().pending().none { it.shiftId == "s1" })
        assertEquals("conflict", db.shiftCloseDao().forShift("s2")?.state)
        assertEquals("multiple_devices", db.shiftCloseDao().forShift("s2")?.conflictCode)
    }

    @Test
    fun reconciliationDeletesReviewedConflicts() = runTest {
        db.conflictDao().insertIgnore(
            listOf(
                ConflictEntity("h1", "dev-2", "2026-09-10T09:00:00.000Z", "2026-09-10T10:00:00.000Z"),
                ConflictEntity("h2", "dev-2", "2026-09-10T09:00:00.000Z", "2026-09-10T10:00:00.000Z"),
            ),
        )
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"reviewedCodeHashes":["h1","zzz"]}"""))
        assertTrue(engine().drainAll())
        val request = server.takeRequest()
        assertEquals("/station/conflicts/status", request.path)
        assertEquals(listOf("h2"), db.conflictDao().observeAll().first().map { it.codeHash })
    }

    @Test
    fun aRevokedCredentialRaisesTheBusAndFails() = runTest {
        outbox("a")
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"code":"STATION_CREDENTIAL_REVOKED"}"""))
        bus.events.test {
            assertFalse(engine().drainAll())
            awaitItem()
        }
    }

    @Test
    fun stateReportsPendingAndStuck() = runTest {
        outbox("a")
        val e = engine()
        assertEquals(1, e.state.first { it.pending == 1 }.pending)
        assertFalse(e.state.value.stuck)
        clock += 16 * 60 * 1000L
        e.tick()
        assertTrue(e.state.first { it.stuck }.stuck)
    }
}
