package app.markiro.handheld.core.sync

import app.markiro.handheld.core.storage.reconnectSameDeviceForTest
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.network.NetworkModule
import app.markiro.handheld.core.network.RevocationBus
import app.markiro.handheld.core.network.RevocationInterceptor
import app.markiro.handheld.core.storage.BoxEntity
import app.markiro.handheld.core.storage.BoxExceptionEntity
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.storage.OutboxEntity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The channel exists so a correction reaches the server. These tests are about
 * the two ways it can fail silently: leaving before the scan it corrects, and
 * being acknowledged when the server never took it.
 */
@RunWith(AndroidJUnit4::class)
class SyncExceptionsTest {
    private lateinit var db: HandheldDatabase
    private lateinit var server: MockWebServer
    private val bus = RevocationBus()
    private val strict = NetworkModule.strictJson()
    private val clock = 1_757_500_000_000L
    private val engineScope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)

    @Before
    fun setUp() = runTest {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        server = MockWebServer().also { it.start() }
        db.deviceConfigDao().upsert(
            DeviceConfigEntity(
                deviceId = "dev-1", deviceName = "ТСД 1", tenantId = "t-1", organizationName = "ООО",
                lineId = "l1", lineName = "Линия 2", kind = "handheld",
                serverUrl = server.url("/").toString(), pairedAt = 1L,
            ),
        )
        db.initializeRecoveryForTest()
    }

    @After
    fun tearDown() {
        engineScope.cancel()
        server.shutdown()
        db.close()
    }

    private fun engine(): SyncEngine {
        val client = OkHttpClient.Builder()
            .addInterceptor(RevocationInterceptor(bus, db.recovery, Json { ignoreUnknownKeys = true })).build()
        return SyncEngine(
            db = db, meta = MetaStore(db), config = db.deviceConfigDao(),
            transport = SyncTransport(app.markiro.handheld.core.network.GenerationCallFactory(client, db.recovery)) { server.url("/").toString() },
            json = strict, scope = engineScope, clock = { clock },
        )
    }

    private suspend fun outbox(raw: String) = db.outboxDao().insert(
        OutboxEntity(
            shiftId = "s1", raw = raw, verdict = "ok", scannedAt = "2026-09-10T10:00:00.000Z",
            operatorId = "op-1", codeHash = raw.padEnd(64, '0'), gtin14 = "04600682000013",
            serial = raw, boxId = "box-1",
        ),
    )

    private suspend fun queue(kind: String, boxId: String = "box-1", afterOutboxId: Long = 0) =
        db.boxExceptionDao().insert(
            BoxExceptionEntity(
                kind = kind, boxId = boxId,
                codeHash = if (kind == "undo") "a".repeat(64) else null,
                targetScannedAt = if (kind == "undo") "2026-09-10T09:59:00.000Z" else null,
                shiftId = "s1", operatorId = "op-1",
                reason = if (kind == "disassemble" || kind == "reprint") "Неверный товар" else null,
                occurredAt = "2026-09-10T10:00:00.000Z",
                payloadJson = """{"kind":"$kind","boxId":"$boxId","codeHash":null,"targetScannedAt":null,""" +
                    """"shiftId":"s1","terminalId":"dev-1","operatorId":"op-1","reason":null,""" +
                    """"occurredAt":"2026-09-10T10:00:00.000Z"}""",
                afterOutboxId = afterOutboxId, ackedAt = null,
            ),
        )

    private fun ok(applied: Int) = MockResponse().setResponseCode(201)
        .setBody("""{"applied":$applied,"alreadyApplied":false,"conflicts":[]}""")

    private fun bodyOf(): JsonObject =
        Json.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject

    @Test
    fun aBatchCarriesTheExceptionsWhoseTargetsItAlsoCarries() = runTest {
        outbox("a")
        queue("undo", afterOutboxId = db.outboxDao().maxId())
        server.enqueue(ok(1))
        assertTrue(engine().drainAll())
        val body = bodyOf()
        assertEquals(1, body.getValue("items").jsonArray.size)
        val exceptions = body.getValue("exceptions").jsonArray
        assertEquals(1, exceptions.size)
        assertEquals("undo", exceptions[0].jsonObject.getValue("kind").jsonPrimitive.content)
        assertEquals(0, db.boxExceptionDao().unackedCount())
    }

    /**
     * The whole point of the watermark. A device that packed offline has more
     * scans queued than one batch carries; the correction must wait for its own.
     */
    @Test
    fun anExceptionDoesNotLeaveBeforeItsScan() = runTest {
        repeat(SyncEngine.BATCH_SIZE + 1) { outbox("s$it") }
        queue("undo", afterOutboxId = db.outboxDao().maxId())
        server.enqueue(ok(SyncEngine.BATCH_SIZE))
        server.enqueue(ok(1))
        assertTrue(engine().drainAll())
        assertEquals(0, bodyOf().getValue("exceptions").jsonArray.size)
        assertEquals(1, bodyOf().getValue("exceptions").jsonArray.size)
    }

    @Test
    fun aPinnedBatchDoesNotGrowNewExceptions() = runTest {
        outbox("a")
        queue("clear", afterOutboxId = db.outboxDao().maxId())
        server.enqueue(MockResponse().setResponseCode(500))
        val e = engine()
        assertFalse(e.drainAll())
        queue("clear", boxId = "box-2", afterOutboxId = 0)
        server.enqueue(ok(1))
        server.enqueue(ok(0))
        assertTrue(e.drainAll())
        bodyOf()
        val retried = bodyOf().getValue("exceptions").jsonArray
        assertEquals(1, retried.size)
        assertEquals("box-1", retried[0].jsonObject.getValue("boxId").jsonPrimitive.content)
        assertEquals(
            "box-2",
            bodyOf().getValue("exceptions").jsonArray[0].jsonObject.getValue("boxId").jsonPrimitive.content,
        )
    }

    @Test
    fun exceptionsAreAcknowledgedOnlyAfterTheServerTakesTheBatch() = runTest {
        outbox("a")
        queue("clear", afterOutboxId = db.outboxDao().maxId())
        server.enqueue(MockResponse().setResponseCode(500))
        val e = engine()
        assertFalse(e.drainAll())
        assertEquals(1, db.boxExceptionDao().unackedCount())
        server.enqueue(ok(1))
        assertTrue(e.drainAll())
        assertEquals(0, db.boxExceptionDao().unackedCount())
    }

    /** A closed-box fact waits for the closure the server has to have seen first. */
    @Test
    fun aDisassembleWaitsForItsClosure() = runTest {
        db.boxDao().insert(
            BoxEntity(
                boxId = "box-9", shiftId = "s1", sscc = "000000000000000017",
                openedAt = "2026-09-10T09:00:00.000Z", closedAt = "2026-09-10T09:30:00.000Z",
                operatorId = "op-1", printState = "printed", printReason = null, ackedAt = null,
            ),
        )
        queue("disassemble", boxId = "box-9")
        server.enqueue(ok(0))
        // `drainOnce`, not `drainAll`: the loop's next pass would pick the fact
        // up as soon as the first batch acknowledged the closure, which is
        // correct behaviour and would hide what this test is about.
        assertEquals(SyncEngine.Step.SENT, engine().drainOnce())
        val body = bodyOf()
        assertEquals(1, body.getValue("boxes").jsonArray.size)
        // The closure rides this batch; the fact about it rides the next.
        assertEquals(0, body.getValue("exceptions").jsonArray.size)
        assertEquals(1, db.boxExceptionDao().unackedCount())
    }

    @Test
    fun theQueueDepthCountsExceptions() = runTest {
        queue("clear")
        assertEquals(1, engine().state.first { it.pending > 0 }.pending)
    }
    @Test fun recoveryResendsExceptionAndItsScanWithIdenticalBatchIdentity() = runTest {
        outbox("exact\u001dscan")
        queue("undo", afterOutboxId = db.outboxDao().maxId())
        val e = engine()
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"code":"STATION_CREDENTIAL_REVOKED"}"""))
        assertFalse(e.drainAll())
        val original = server.takeRequest().body.readUtf8()
        assertEquals(1, db.boxExceptionDao().unackedCount())
        db.reconnectSameDeviceForTest()
        server.enqueue(ok(1))
        assertTrue(e.drainAll())
        val retry = server.takeRequest()
        assertEquals(original, retry.body.readUtf8())
        assertEquals("restored-synthetic-key", retry.getHeader("x-api-key"))
        assertEquals(0, db.boxExceptionDao().unackedCount())
    }

}
