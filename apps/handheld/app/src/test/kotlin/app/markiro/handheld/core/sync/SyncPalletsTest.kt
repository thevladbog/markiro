package app.markiro.handheld.core.sync

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.network.NetworkModule
import app.markiro.handheld.core.network.RevocationBus
import app.markiro.handheld.core.network.RevocationInterceptor
import app.markiro.handheld.core.storage.BoxEntity
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.storage.OutboxEntity
import app.markiro.handheld.core.storage.PalletEntity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Pallets (06d) reporting to the server through the same sync batch boxes and
 * scans already ride.
 *
 * The one thing that matters here: a pallet closing while a batch awaits its
 * answer must NOT be folded into that batch. If it were, either the retry
 * would carry a different body under an id the server already applied (and
 * the closure would vanish silently, `SyncEngineTest`'s
 * `aBoxThatClosesWhileABatchIsInFlightWaitsForTheNextOneAndIsNotLost` guards
 * the box-shaped version of the identical defect), or -- worse for a pallet
 * specifically -- a physically labelled pallet would never be reported at
 * all.
 */
@RunWith(AndroidJUnit4::class)
class SyncPalletsTest {
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
                deviceId = "dev-1", deviceName = "ТСД 1", tenantId = "t-1", organizationName = "ООО", lineId = "l1",
                lineName = "Линия 2", kind = "handheld", serverUrl = server.url("/").toString(), pairedAt = 1L,
            ),
        )
    }

    @After
    fun tearDown() {
        engineScope.cancel()
        server.shutdown()
        db.close()
    }

    private fun engine(): SyncEngine {
        val client = OkHttpClient.Builder().addInterceptor(RevocationInterceptor(bus, Json { ignoreUnknownKeys = true })).build()
        return SyncEngine(
            db = db, meta = MetaStore(db.metaDao()), config = db.deviceConfigDao(),
            transport = SyncTransport(client) { server.url("/").toString() }, json = strict,
            scope = engineScope, clock = { clock },
        )
    }

    private suspend fun outbox(raw: String) = db.outboxDao().insert(
        OutboxEntity(
            shiftId = "s1", raw = raw, verdict = "ok", scannedAt = "2026-09-10T10:00:00.000Z", operatorId = "op-1",
            codeHash = "a".repeat(64), gtin14 = "04600682000013", serial = raw,
        ),
    )

    private suspend fun closedPallet(palletId: String, sscc: String = "046800899000000018", closedAt: String = "2026-09-10T11:00:00.000Z") =
        db.palletDao().insert(
            PalletEntity(
                palletId = palletId, shiftId = "s1", terminalId = null, sscc = sscc, openedAt = "2026-09-10T10:00:00.000Z",
                closedAt = closedAt, operatorId = "op-1", printState = "pending", printReason = null, ackedAt = null,
            ),
        )

    private suspend fun closedBox(
        boxId: String,
        sscc: String = "046800899000000019",
        palletId: String? = null,
        closedAt: String = "2026-09-10T11:00:00.000Z",
    ) = db.boxDao().insert(
        BoxEntity(
            boxId = boxId, shiftId = "s1", sscc = sscc, openedAt = "2026-09-10T10:00:00.000Z",
            closedAt = closedAt, operatorId = "op-1", printState = "pending", printReason = null, ackedAt = null, palletId = palletId,
        ),
    )

    private fun ok(applied: Int) =
        MockResponse().setResponseCode(201).setBody("""{"applied":$applied,"alreadyApplied":false,"conflicts":[]}""")

    private fun bodyOf(request: RecordedRequest) = Json.parseToJsonElement(request.body.readUtf8()).jsonObject

    private fun palletIdsOf(body: kotlinx.serialization.json.JsonObject) =
        body.getValue("pallets").jsonArray.map { it.jsonObject.getValue("palletId").jsonPrimitive.content }

    @Test
    fun aPalletThatClosesWhileABatchIsInFlightWaitsForTheNextOneAndIsNotLost() = runTest {
        // The defect this guards: if the pallet set were free to grow under a
        // pinned batch id, the retry would carry a different body under an id
        // the server has already applied, and the closure would vanish with no
        // trace -- for a pallet, that means a physically labelled unit the
        // server never learns about. So the retry stays byte-identical and the
        // pallet rides the next batch instead.
        closedPallet("p1")
        server.enqueue(MockResponse().setResponseCode(500))
        assertFalse(engine().drainAll())
        val first = bodyOf(server.takeRequest())

        closedPallet("p2")
        server.enqueue(ok(0))
        server.enqueue(ok(0))
        assertTrue(engine().drainAll())

        val retry = bodyOf(server.takeRequest())
        assertEquals(first.getValue("batchId"), retry.getValue("batchId"))
        assertEquals(listOf("p1"), palletIdsOf(retry))

        val next = bodyOf(server.takeRequest())
        assertNotEquals(first.getValue("batchId"), next.getValue("batchId"))
        assertEquals(listOf("p2"), palletIdsOf(next))
        assertNotNull(db.palletDao().get("p1")?.ackedAt)
        assertNotNull(db.palletDao().get("p2")?.ackedAt)
    }

    @Test
    fun aRetryOfTheSameBatchKeepsItsIdentityAndItsPallets() = runTest {
        // The other half: nothing changed, so the resend must be the same
        // batch rather than a second one the server would apply twice.
        closedPallet("p1")
        server.enqueue(MockResponse().setResponseCode(500))
        assertFalse(engine().drainAll())
        val first = bodyOf(server.takeRequest())
        server.enqueue(ok(0))
        assertTrue(engine().drainAll())
        val second = bodyOf(server.takeRequest())
        assertEquals(
            first.getValue("batchId").jsonPrimitive.content,
            second.getValue("batchId").jsonPrimitive.content,
        )
        assertEquals(listOf("p1"), palletIdsOf(second))
    }

    @Test
    fun carriesThePalletIdOnTheBoxClosure() = runTest {
        closedPallet("p1")
        closedBox("box-1", palletId = "p1")
        server.enqueue(ok(0))
        assertTrue(engine().drainAll())
        val box = bodyOf(server.takeRequest()).getValue("boxes").jsonArray.single().jsonObject
        assertEquals("p1", box.getValue("devicePalletId").jsonPrimitive.content)
    }

    @Test
    fun aBoxWithNoPalletCarriesANullDevicePalletId() = runTest {
        closedBox("box-1")
        server.enqueue(ok(0))
        assertTrue(engine().drainAll())
        val box = bodyOf(server.takeRequest()).getValue("boxes").jsonArray.single().jsonObject
        assertEquals("null", box.getValue("devicePalletId").toString())
    }

    @Test
    fun capsPalletsAtTheSharedLimit() = runTest {
        // MAX_PALLET_CLOSURES_PER_SYNC_BATCH (@markiro/domain) is 20, and the
        // server rejects a batch carrying more -- see SyncEngine.MAX_PALLET_CLOSURES's
        // own comment for why the two sides must agree.
        repeat(25) { closedPallet("p$it", closedAt = "2026-09-10T11:00:%02d.000Z".format(it)) }
        server.enqueue(ok(0))
        server.enqueue(ok(0))
        assertTrue(engine().drainAll())
        assertEquals(20, palletIdsOf(bodyOf(server.takeRequest())).size)
        assertEquals(5, palletIdsOf(bodyOf(server.takeRequest())).size)
    }

    @Test
    fun doesNotAcknowledgePalletsTheServerNeverTook() = runTest {
        closedPallet("p1")
        server.enqueue(MockResponse().setResponseCode(500))
        assertFalse(engine().drainAll())
        assertEquals(1, db.palletDao().unacked(50).size)
    }

    @Test
    fun aBatchOfPalletsAloneIsStillSent() = runTest {
        // An empty outbox with unacknowledged boxes OR pallets is not empty.
        closedPallet("p1")
        server.enqueue(ok(0))
        assertTrue(engine().drainAll())
        val body = bodyOf(server.takeRequest())
        assertEquals(0, body.getValue("items").jsonArray.size)
        assertEquals(0, body.getValue("boxes").jsonArray.size)
        assertEquals(listOf("p1"), palletIdsOf(body))
        assertNotNull(db.palletDao().get("p1")?.ackedAt)
    }

    @Test
    fun anAcknowledgedPalletIsNeverSentAgain() = runTest {
        closedPallet("p1")
        server.enqueue(ok(0))
        assertTrue(engine().drainAll())
        server.takeRequest()
        assertTrue(engine().drainAll())
        assertNull(server.takeRequest(1, java.util.concurrent.TimeUnit.SECONDS))
    }

    @Test
    fun aBatchPinnedBeforePalletsExistedStaysPalletFree() = runTest {
        // A pending batch written by a build (or an app instance) that predates
        // the pallet count must not grow one: its id is already fixed, so the
        // server would answer alreadyApplied and the closure would be lost --
        // exactly the rule SyncEngineTest's
        // `aBatchPinnedBeforeBoxesExistedStaysBoxFree` already enforces for boxes.
        outbox("a")
        server.enqueue(MockResponse().setResponseCode(500))
        assertFalse(engine().drainAll())
        server.takeRequest()
        db.metaDao().remove(MetaStore.SYNC_PENDING_PALLET_COUNT)
        closedPallet("p1")

        server.enqueue(ok(1))
        server.enqueue(ok(0))
        assertTrue(engine().drainAll())
        assertEquals(0, bodyOf(server.takeRequest()).getValue("pallets").jsonArray.size)
        // It rides the next batch instead.
        assertEquals(listOf("p1"), palletIdsOf(bodyOf(server.takeRequest())))
    }

    @Test
    fun theQueueIndicatorCountsPalletClosuresToo() = runTest {
        // The identical defect SyncEngineTest's theQueueIndicatorCountsClosuresNotJustScans
        // already guards for boxes: a closed pallet waiting to be reported is
        // queued work. Leaving it out of `pending` shows «Очередь 0» while a
        // physically labelled pallet still sits unsent.
        closedPallet("p1")
        assertEquals(1, engine().state.first { it.pending == 1 }.pending)
    }
}
