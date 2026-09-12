package app.markiro.handheld.core.inventory

import app.markiro.handheld.core.storage.reconnectSameDeviceForTest
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.cash.turbine.test
import app.markiro.handheld.core.network.NetworkModule
import app.markiro.handheld.core.network.RevocationBus
import app.markiro.handheld.core.network.RevocationInterceptor
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.InventoryEventEntity
import app.markiro.handheld.core.storage.InventoryFixtures
import app.markiro.handheld.core.storage.InventoryOutboxEntity
import app.markiro.handheld.core.storage.InventoryTerminalStateEntity
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.sync.SyncTransport
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.cancel
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
class InventorySyncEngineTest {
    private lateinit var db: HandheldDatabase
    private lateinit var server: MockWebServer
    private val bus = RevocationBus()
    private var clock = 1_757_500_000_000L
    private val snap = "22222222-2222-4222-8222-222222222222"

    /**
     * The engines below publish their state with an eagerly started flow, which keeps reading Room
     * for as long as its scope lives. Left running past the database it reads, it throws into
     * whichever test happens to run next, so the scope is owned here and cancelled before the close.
     */
    private val engineScope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)

    @Before
    fun setUp() = runTest {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java).allowMainThreadQueries().build()
        server = MockWebServer().also { it.start() }
        db.deviceConfigDao().upsert(
            DeviceConfigEntity(
                deviceId = "dev-1", deviceName = "ТСД 1", tenantId = "t", organizationName = "ООО", lineId = "l1", lineName = "Линия 2",
                kind = "handheld", serverUrl = server.url("/").toString(), pairedAt = 1L, activeInventoryId = "i1",
            ),
        )
        db.inventoryTaskDao().upsert(InventoryFixtures.task("i1", snapshotId = snap))
        db.inventoryTerminalStateDao().upsert(InventoryTerminalStateEntity("i1", snap, "op-1", "2026-08-20", 4, null, 0, "t"))
        db.initializeRecoveryForTest()
    }

    @After
    fun tearDown() {
        engineScope.cancel()
        server.shutdown()
        db.close()
    }

    private fun engine(): InventorySyncEngine {
        val client = OkHttpClient.Builder().addInterceptor(RevocationInterceptor(bus, db.recovery, Json { ignoreUnknownKeys = true })).build()
        return InventorySyncEngine(
            db, MetaStore(db), db.deviceConfigDao(), SyncTransport(app.markiro.handheld.core.network.GenerationCallFactory(client, db.recovery)) { server.url("/").toString() }, NetworkModule.strictJson(),
            engineScope, clock = { clock },
        )
    }

    private fun hashOf(n: Long) = n.toString().padStart(64, '0')

    private suspend fun event(n: Long, verdict: String = "expected"): InventoryEventEntity {
        val hash = hashOf(n)
        val e = InventoryEventEntity(
            eventId = "e$n", inventoryId = "i1", snapshotId = snap, deviceSequence = n, operatorId = "op-1", scannedAt = "2026-08-25T10:00:0$n.000Z",
            kind = "item", normalizedIdentity = "item:$hash", codeHash = hash, canonicalRaw = "010460000000001521S$n", activeProductionDate = "2026-08-20",
            localVerdict = verdict, claimedCount = 1, winnerEventId = null, winnerDeviceId = null, winnerScannedAt = null, serverStatus = null,
        )
        db.inventoryEventDao().insert(e)
        db.inventoryResultDao().insertIgnore(InventoryFixtures.result("i1", snap, hash, "e$n", "dev-1"))
        db.inventoryOutboxDao().insert(
            InventoryOutboxEntity(inventoryId = "i1", snapshotId = snap, eventId = "e$n", deviceSequence = n, payloadJson = InventoryBatchCodec.eventJson(e), createdAt = "t"),
        )
        return e
    }

    private fun outcome(eventId: String, status: String, reason: String, claims: String = "[]", claimed: Int = 0, conflicts: Int = 0) =
        """{"eventId":"$eventId","status":"$status","reasonCode":"$reason","claimedCount":$claimed,"conflictCount":$conflicts,"claims":$claims}"""

    private fun response(request: String, outcomes: List<String>): String {
        val req = Json.parseToJsonElement(request).jsonObject
        return """{"inventoryId":"i1","snapshotId":"$snap","snapshotRevision":1,"batchId":"${req.getValue("batchId").jsonPrimitive.content}",""" +
            """"payloadDigest":"${req.getValue("payloadDigest").jsonPrimitive.content}","sequenceCeiling":${req.getValue("sequenceCeiling").jsonPrimitive.content},""" +
            """"resultRevision":7,"outcomes":[${outcomes.joinToString(",")}]}"""
    }

    private fun progress(items: String = "[]", cursor: String? = null, next: String? = null, revision: Int = 7) = MockResponse().setBody(
        """{"inventoryId":"i1","snapshotId":"$snap","snapshotRevision":1,"cursor":${cursor?.let { "\"$it\"" } ?: "null"},""" +
            """"resultRevision":$revision,"items":$items,"nextCursor":${next?.let { "\"$it\"" } ?: "null"}}""",
    )

    /** MockWebServer answers before it can read the request, so a first attempt fails and pins the batch; the answer is built from the pinned request. */
    private suspend fun answerPinned(engine: InventorySyncEngine, vararg outcomes: String) {
        server.enqueue(MockResponse().setResponseCode(500))
        assertFalse(engine.drainAll())
        val request = server.takeRequest().body.readUtf8()
        server.enqueue(MockResponse().setResponseCode(200).setBody(response(request, outcomes.toList())))
        server.enqueue(progress())
    }

    @Test
    fun postsADigestedBatchAndAcknowledgesIt() = runTest {
        event(1)
        event(2)
        val e = engine()
        val claim = """[{"codeHash":"${hashOf(1)}","status":"claimed","winner":{"codeHash":"${hashOf(1)}","eventId":"e1","deviceId":"dev-1","scannedAt":"2026-08-25T10:00:01.000Z"}}]"""
        answerPinned(e, outcome("e1", "applied", "CLAIM_APPLIED", claim, claimed = 1), outcome("e2", "replay", "BATCH_REPLAY"))
        assertTrue(e.drainAll())
        val first = server.takeRequest()
        assertEquals("/station/inventories/i1/event-batches", first.path)
        val body = Json.parseToJsonElement(first.body.readUtf8()).jsonObject
        assertEquals(2, body.getValue("events").jsonArray.size)
        assertEquals("2", body.getValue("sequenceCeiling").jsonPrimitive.content)
        assertEquals("0", body.getValue("pendingEventCount").jsonPrimitive.content)
        assertEquals("0", body.getValue("openBoxCount").jsonPrimitive.content)
        val events = body.getValue("events").jsonArray.map { it.toString() }
        assertEquals(InventoryBatchCodec.digest(InventoryBatchCodec.payloadJson(snap, 2, 0, events)), body.getValue("payloadDigest").jsonPrimitive.content)
        assertEquals("/station/inventories/i1/progress?limit=200", server.takeRequest().path)
        assertEquals(0, db.inventoryOutboxDao().count("i1"))
        assertEquals("applied", db.inventoryEventDao().get("e1")?.serverStatus)
        assertEquals("replay", db.inventoryEventDao().get("e2")?.serverStatus)
        assertNull(db.metaDao().get(MetaStore.inventoryPin("i1")))
        assertEquals(clock, e.state.value.lastSuccessAt)
    }

    @Test
    fun aLostClaimReplacesTheWinnerAndStopsCountingForThisDevice() = runTest {
        event(1)
        val e = engine()
        val lost = """[{"codeHash":"${hashOf(1)}","status":"duplicate","winner":{"codeHash":"${hashOf(1)}","eventId":"x","deviceId":"dev-2","scannedAt":"2026-08-25T09:00:00.000Z"}}]"""
        answerPinned(e, outcome("e1", "duplicate", "CLAIM_LOST", lost, conflicts = 1))
        assertTrue(e.drainAll())
        val row = db.inventoryResultDao().get("i1", hashOf(1))
        assertEquals("dev-2", row?.winningDeviceId)
        assertEquals("server", row?.source)
        assertEquals(0, db.inventoryResultDao().observeCountForDevice("i1", "dev-1").first())
        assertEquals("duplicate", db.inventoryEventDao().get("e1")?.serverStatus)
    }

    @Test
    fun aLostClaimInsideAnAppliedOutcomeStillReplacesTheWinner() = runTest {
        event(1)
        val e = engine()
        val lost = """[{"codeHash":"${hashOf(1)}","status":"duplicate","winner":{"codeHash":"${hashOf(1)}","eventId":"x","deviceId":"dev-2","scannedAt":"2026-08-25T09:00:00.000Z"}}]"""
        answerPinned(e, outcome("e1", "applied", "CLAIM_APPLIED", lost, conflicts = 1))
        assertTrue(e.drainAll())
        val row = db.inventoryResultDao().get("i1", hashOf(1))
        assertEquals("dev-2", row?.winningDeviceId)
        assertEquals("server", row?.source)
        assertEquals("applied", db.inventoryEventDao().get("e1")?.serverStatus)
    }

    @Test
    fun quarantineClosesTheTaskAndKeepsTheRest() = runTest {
        event(1)
        event(2)
        val e = engine()
        answerPinned(e, outcome("e1", "quarantined", "INVENTORY_CLOSED"), outcome("e2", "quarantined", "INVENTORY_CLOSED"))
        assertTrue(e.drainAll())
        assertEquals("closed", db.inventoryTaskDao().get("i1")?.state)
        assertEquals("i1", e.state.value.closedInventoryId)
        assertEquals(0, db.inventoryOutboxDao().count("i1"))
    }

    @Test
    fun aResponseForAnotherBatchIsNotAnAck() = runTest {
        event(1)
        val e = engine()
        val foreign = """{"batchId":"other","payloadDigest":"${"0".repeat(64)}","sequenceCeiling":1}"""
        server.enqueue(MockResponse().setResponseCode(200).setBody(response(foreign, listOf(outcome("e1", "applied", "CLAIM_APPLIED")))))
        assertFalse(e.drainAll())
        assertEquals(1, db.inventoryOutboxDao().count("i1"))
        assertNotNull(db.metaDao().get(MetaStore.inventoryPin("i1")))
    }

    @Test
    fun progressPagesAddOtherTerminalsClaimsAndAdvanceTheCursor() = runTest {
        val hash = "9".padStart(64, '0')
        val e = engine()
        server.enqueue(
            progress(
                """[{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","revision":5,"correctedAt":"2026-08-25T10:00:00.000Z","kind":"claim","codeHash":"$hash",""" +
                    """"classification":"expected","observedProductionDate":"2026-08-20","winner":{"codeHash":"$hash","eventId":"z","deviceId":"dev-2","scannedAt":"2026-08-25T09:00:00.000Z"}}]""",
                next = "5:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            ),
        )
        server.enqueue(
            progress(
                """[{"id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","revision":6,"correctedAt":"2026-08-25T10:01:00.000Z","kind":"correction","codeHash":"$hash",""" +
                    """"classification":"voided","observedProductionDate":null,"winner":null}]""",
                cursor = "5:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                next = "6:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            ),
        )
        // The server always continues past a non-empty page; only an empty page ends the feed.
        server.enqueue(progress(cursor = "6:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"))
        assertTrue(e.drainAll())
        assertEquals("/station/inventories/i1/progress?limit=200", server.takeRequest().path)
        assertEquals("/station/inventories/i1/progress?cursor=5%3Aaaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&limit=200", server.takeRequest().path)
        assertEquals("/station/inventories/i1/progress?cursor=6%3Abbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb&limit=200", server.takeRequest().path)
        assertNull(db.inventoryResultDao().get("i1", hash))
        assertEquals(7L, db.inventoryTerminalStateDao().get("i1")?.progressResultRevision)
        assertEquals("6:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", db.inventoryTerminalStateDao().get("i1")?.progressCursor)
    }

    @Test
    fun aProgressPageWhoseNextCursorDoesNotFollowItsItemsIsRejected() = runTest {
        val hash = "9".padStart(64, '0')
        val claim = """[{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","revision":5,"correctedAt":"2026-08-25T10:00:00.000Z","kind":"claim","codeHash":"$hash",""" +
            """"classification":"expected","observedProductionDate":"2026-08-20","winner":{"codeHash":"$hash","eventId":"z","deviceId":"dev-2","scannedAt":"2026-08-25T09:00:00.000Z"}}]"""
        // Items without a continuation would silently end the feed early.
        server.enqueue(progress(claim))
        assertFalse(engine().drainAll())
        // A continuation without items would be re-read forever.
        server.enqueue(progress(next = "5:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))
        assertFalse(engine().drainAll())
        assertEquals(2, server.requestCount)
        assertNull(db.inventoryResultDao().get("i1", hash))
        assertNull(db.inventoryTerminalStateDao().get("i1")?.progressCursor)
    }

    @Test
    fun aClaimByAnotherTerminalMakesTheNextLocalScanADuplicate() = runTest {
        val hash = "9".padStart(64, '0')
        server.enqueue(
            progress(
                """[{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","revision":5,"correctedAt":"2026-08-25T10:00:00.000Z","kind":"claim","codeHash":"$hash",""" +
                    """"classification":"expected","observedProductionDate":"2026-08-20","winner":{"codeHash":"$hash","eventId":"z","deviceId":"dev-2","scannedAt":"2026-08-25T09:00:00.000Z"}}]""",
                next = "5:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            ),
        )
        server.enqueue(progress(cursor = "5:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))
        assertTrue(engine().drainAll())
        val row = db.inventoryResultDao().get("i1", hash)
        assertEquals("dev-2", row?.winningDeviceId)
        assertEquals(1, db.inventoryResultDao().observeCount("i1", "expected").first())
    }

    @Test
    fun aRevokedCredentialRaisesTheBusAndFails() = runTest {
        event(1)
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"code":"STATION_CREDENTIAL_REVOKED"}"""))
        bus.events.test {
            assertFalse(engine().drainAll())
            awaitItem()
        }
    }
    @Test fun recoveryResendsPinnedInventoryBytesAndAppliesExactEventAcknowledgements() = runTest {
        val saved = event(1)
        val e = engine()
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"code":"STATION_CREDENTIAL_REVOKED"}"""))
        assertFalse(e.drainAll())
        val original = server.takeRequest().body.readUtf8()
        val pin = db.metaDao().get(MetaStore.inventoryPin("i1"))
        assertEquals(saved, db.inventoryEventDao().get("e1"))
        db.reconnectSameDeviceForTest()
        assertEquals(pin, db.metaDao().get(MetaStore.inventoryPin("i1")))
        server.enqueue(MockResponse().setBody(response(original, listOf(outcome("e1", "replay", "BATCH_REPLAY")))))
        server.enqueue(progress())
        assertTrue(e.drainAll())
        val retry = server.takeRequest()
        assertEquals(original, retry.body.readUtf8())
        assertEquals("restored-synthetic-key", retry.getHeader("x-api-key"))
        server.takeRequest()
        assertEquals(0, db.inventoryOutboxDao().count("i1"))
        assertEquals("replay", db.inventoryEventDao().get("e1")?.serverStatus)
        assertNull(db.metaDao().get(MetaStore.inventoryPin("i1")))
    }

    @Test fun lateInventoryAcknowledgementKeepsOriginalEventAndPinnedRequest() = runTest {
        val saved = event(1)
        val arrived = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        server.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
            override fun dispatch(request: okhttp3.mockwebserver.RecordedRequest): MockResponse {
                val body = request.body.readUtf8()
                arrived.complete(Unit)
                runBlocking { release.await() }
                return MockResponse().setBody(response(body, listOf(outcome("e1", "replay", "BATCH_REPLAY"))))
            }
        }
        val oldRequest = async { engine().drainAll() }
        arrived.await()
        val pin = db.metaDao().get(MetaStore.inventoryPin("i1"))
        db.recovery.reject(db.recovery.token())
        db.reconnectSameDeviceForTest()
        release.complete(Unit)
        assertFalse(oldRequest.await())
        assertEquals(saved, db.inventoryEventDao().get("e1"))
        assertEquals(1, db.inventoryOutboxDao().count("i1"))
        assertEquals(pin, db.metaDao().get(MetaStore.inventoryPin("i1")))
    }

}
