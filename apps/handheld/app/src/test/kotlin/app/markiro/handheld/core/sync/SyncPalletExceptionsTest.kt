package app.markiro.handheld.core.sync

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.network.NetworkModule
import app.markiro.handheld.core.network.RevocationBus
import app.markiro.handheld.core.network.RevocationInterceptor
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.storage.PalletEntity
import app.markiro.handheld.core.storage.PalletExceptionEntity
import app.markiro.handheld.core.storage.initializeRecoveryForTest
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
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The pallet half of the exceptions channel.
 *
 * Its silent-failure mode is not the box channel's. `applyPalletExceptions`
 * (`apps/api/src/modules/station-scans/pallet-ingest.ts`) resolves a fact
 * through the pallets carried by the same batch plus the ones the server
 * already holds, and does `if (id === undefined) continue` when the lookup
 * misses: no error, no receipt, no quarantine. A fact sent one batch too early
 * is therefore not retried -- it is dropped, and this device acknowledges it
 * anyway. These tests are about that ordering rule and about the batch identity
 * the channel now takes part in.
 */
@RunWith(AndroidJUnit4::class)
class SyncPalletExceptionsTest {
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

    private suspend fun closedPallet(palletId: String, closedAt: String, ackedAt: String? = null) =
        db.palletDao().insert(
            PalletEntity(
                palletId = palletId, shiftId = "s1", terminalId = null, sscc = "146800899000000012",
                openedAt = "2026-09-10T07:00:00.000Z", closedAt = closedAt, operatorId = "op-1",
                printState = "unknown", printReason = null, ackedAt = ackedAt,
            ),
        )

    private suspend fun queueReprint(palletId: String) = db.palletExceptionDao().insert(
        PalletExceptionEntity(
            kind = "reprint", palletId = palletId, shiftId = "s1", terminalId = "dev-1",
            operatorId = "op-1", reason = "Результат печати неизвестен",
            occurredAt = "2026-09-10T10:00:00.000Z",
            payloadJson = """{"kind":"reprint","palletId":"$palletId","shiftId":"s1","terminalId":"dev-1",""" +
                """"operatorId":"op-1","reason":"Результат печати неизвестен","occurredAt":"2026-09-10T10:00:00.000Z"}""",
            ackedAt = null,
        ),
    )

    private fun ok(applied: Int) = MockResponse().setResponseCode(201)
        .setBody("""{"applied":$applied,"alreadyApplied":false,"conflicts":[]}""")

    private fun bodyOf(): JsonObject =
        Json.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject

    @Test
    fun aBatchCarriesAReprintAlongsideTheClosureItNames() = runTest {
        closedPallet("p1", "2026-09-10T09:30:00.000Z")
        queueReprint("p1")
        server.enqueue(ok(0))
        assertEquals(SyncEngine.Step.SENT, engine().drainOnce())
        val body = bodyOf()
        assertEquals(1, body.getValue("pallets").jsonArray.size)
        val facts = body.getValue("palletExceptions").jsonArray
        assertEquals(1, facts.size)
        val fact = facts[0].jsonObject
        assertEquals("reprint", fact.getValue("kind").jsonPrimitive.content)
        assertEquals("p1", fact.getValue("palletId").jsonPrimitive.content)
        // Every key the server declares, including the ones a lenient encoder drops.
        assertEquals(
            listOf("kind", "palletId", "shiftId", "terminalId", "operatorId", "reason", "occurredAt"),
            fact.keys.toList(),
        )
        assertEquals(0, db.palletExceptionDao().unackedCount())
    }

    /** A pallet the server acknowledged long ago needs no closure in this batch. */
    @Test
    fun aReprintForAnAlreadyAcknowledgedPalletRidesABatchOfItsOwn() = runTest {
        closedPallet("p1", "2026-09-10T09:30:00.000Z", ackedAt = "2026-09-10T09:30:15.000Z")
        queueReprint("p1")
        server.enqueue(ok(0))
        assertEquals(SyncEngine.Step.SENT, engine().drainOnce())
        val body = bodyOf()
        // Nothing else is owed: an otherwise empty batch is still not empty.
        assertEquals(0, body.getValue("pallets").jsonArray.size)
        assertEquals(0, body.getValue("items").jsonArray.size)
        assertEquals(1, body.getValue("palletExceptions").jsonArray.size)
        assertEquals(0, db.palletExceptionDao().unackedCount())
    }

    /**
     * THE ordering rule, and it is reachable on a real device rather than a
     * corner case: `MAX_PALLET_CLOSURES` is 20, so a terminal holding 25
     * unacknowledged closures defers the 21st to the next batch. A reprint for
     * that pallet riding the first batch would be dropped by
     * `applyPalletExceptions` without a word -- and acknowledged here anyway.
     */
    @Test
    fun aReprintWaitsForAClosureThisBatchCannotCarry() = runTest {
        val overflow = SyncEngine.MAX_PALLET_CLOSURES + 5
        repeat(overflow) { closedPallet("p-%02d".format(it), "2026-09-10T09:%02d:00.000Z".format(it)) }
        // The 21st closure by close order: one past what a single batch carries.
        val deferred = "p-%02d".format(SyncEngine.MAX_PALLET_CLOSURES)
        queueReprint(deferred)

        server.enqueue(ok(0))
        // `drainOnce`, not `drainAll`: the loop's next pass picks the fact up as
        // soon as the closure lands, which is correct and would hide this.
        assertEquals(SyncEngine.Step.SENT, engine().drainOnce())
        val first = bodyOf()
        assertEquals(SyncEngine.MAX_PALLET_CLOSURES, first.getValue("pallets").jsonArray.size)
        assertFalse(
            "the deferred pallet's closure rode the first batch",
            first.getValue("pallets").jsonArray.any { it.jsonObject.getValue("palletId").jsonPrimitive.content == deferred },
        )
        assertEquals(0, first.getValue("palletExceptions").jsonArray.size)
        assertEquals(1, db.palletExceptionDao().unackedCount())

        // The closure lands in the next batch, and the fact rides with it.
        server.enqueue(ok(0))
        assertEquals(SyncEngine.Step.SENT, engine().drainOnce())
        val second = bodyOf()
        assertEquals(overflow - SyncEngine.MAX_PALLET_CLOSURES, second.getValue("pallets").jsonArray.size)
        assertTrue(
            second.getValue("pallets").jsonArray.any { it.jsonObject.getValue("palletId").jsonPrimitive.content == deferred },
        )
        val facts = second.getValue("palletExceptions").jsonArray
        assertEquals(1, facts.size)
        assertEquals(deferred, facts[0].jsonObject.getValue("palletId").jsonPrimitive.content)
        assertEquals(0, db.palletExceptionDao().unackedCount())
    }

    @Test
    fun aPinnedBatchDoesNotGrowNewPalletExceptions() = runTest {
        closedPallet("p1", "2026-09-10T09:30:00.000Z", ackedAt = "2026-09-10T09:30:15.000Z")
        closedPallet("p2", "2026-09-10T09:40:00.000Z", ackedAt = "2026-09-10T09:40:15.000Z")
        queueReprint("p1")
        server.enqueue(MockResponse().setResponseCode(500))
        val e = engine()
        assertFalse(e.drainAll())
        val attempt = bodyOf()
        assertEquals("1", MetaStore(db).get(MetaStore.SYNC_PENDING_PALLET_EXCEPTION_COUNT))

        queueReprint("p2")
        server.enqueue(ok(0))
        server.enqueue(ok(0))
        assertTrue(e.drainAll())

        val retry = bodyOf()
        // Byte-identical retry: the pinned set, under the pinned id.
        assertEquals(attempt.toString(), retry.toString())
        assertEquals(1, retry.getValue("palletExceptions").jsonArray.size)
        assertEquals("p1", retry.getValue("palletExceptions").jsonArray[0].jsonObject.getValue("palletId").jsonPrimitive.content)
        // The one queued since rides the batch after it, not the pinned one.
        val next = bodyOf()
        assertEquals("p2", next.getValue("palletExceptions").jsonArray[0].jsonObject.getValue("palletId").jsonPrimitive.content)
        assertEquals(0, db.palletExceptionDao().unackedCount())
        assertNull(MetaStore(db).get(MetaStore.SYNC_PENDING_PALLET_EXCEPTION_COUNT))
    }

    /**
     * Two batches identical in every other channel must not share a batch id.
     *
     * The server claims a batch id and short-circuits an already-claimed one
     * with `alreadyApplied` before it applies anything, so an id that does not
     * change when the pallet-exception set changes means the second fact is
     * never applied -- while this device acknowledges it. Every other channel
     * is folded into the id for exactly this reason; this asserts the new one
     * is too.
     */
    @Test
    fun theBatchIdChangesWhenOnlyThePalletExceptionSetDoes() = runTest {
        closedPallet("p1", "2026-09-10T09:30:00.000Z", ackedAt = "2026-09-10T09:30:15.000Z")
        queueReprint("p1")
        server.enqueue(ok(0))
        val e = engine()
        assertTrue(e.drainAll())
        val first = bodyOf().getValue("batchId").jsonPrimitive.content

        queueReprint("p1")
        server.enqueue(ok(0))
        assertTrue(e.drainAll())
        val second = bodyOf().getValue("batchId").jsonPrimitive.content

        assertNotEquals("the pallet-exception set is not folded into the batch id", first, second)
    }

    @Test
    fun theQueueDepthCountsPalletExceptions() = runTest {
        closedPallet("p1", "2026-09-10T09:30:00.000Z", ackedAt = "2026-09-10T09:30:15.000Z")
        queueReprint("p1")
        // The closure is acknowledged, so the fact is the only thing owed.
        assertEquals(1, engine().state.first { it.pending > 0 }.pending)
    }

    /** Acknowledged only once the server actually took the batch. */
    @Test
    fun palletExceptionsAreAcknowledgedOnlyAfterTheServerTakesTheBatch() = runTest {
        closedPallet("p1", "2026-09-10T09:30:00.000Z", ackedAt = "2026-09-10T09:30:15.000Z")
        queueReprint("p1")
        server.enqueue(MockResponse().setResponseCode(500))
        val e = engine()
        assertFalse(e.drainAll())
        assertEquals(1, db.palletExceptionDao().unackedCount())
        server.enqueue(ok(0))
        assertTrue(e.drainAll())
        assertEquals(0, db.palletExceptionDao().unackedCount())
        // Acknowledged rows are purged, not left to grow forever.
        assertEquals(0, db.palletExceptionDao().queued().size)
    }
}
