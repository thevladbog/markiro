package app.markiro.handheld.core.sync

import app.markiro.handheld.core.storage.reconnectSameDeviceForTest
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.network.NetworkModule
import app.markiro.handheld.core.network.RevocationBus
import app.markiro.handheld.core.network.RevocationInterceptor
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.storage.OutboxEntity
import app.markiro.handheld.core.storage.ProductLabelEventEntity
import app.markiro.handheld.core.storage.ProductLabelJobEntity
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
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DuplicateSyncTest {
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
        db.productLabelJobDao().insert(job("j1"))
        db.initializeRecoveryForTest()
    }

    @After
    fun tearDown() {
        engineScope.cancel()
        server.shutdown()
        db.close()
    }

    @Test fun occurrenceReceiptReclassifiesProvisionalOriginalBeforeAcknowledgingScans() = runTest {
        val raw = "010460068200001321AAA\u001d93CRYPTO"
        val km = app.markiro.handheld.core.km.KmCodec.canonicalize(raw)
        val hash = app.markiro.handheld.core.km.KmCodec.hash(km)
        val shift = app.markiro.handheld.feature.shift.ShiftEntityFixtures.bundled("s1").copy(validationPrintMode="duplicate_dm")
        db.shiftDao().upsert(shift)
        val outcome = app.markiro.handheld.core.scan.ScanRecorder(db) { clock }.record(shift,raw,"op-1")
        server.enqueue(MockResponse().setBody("""{"applied":1,"alreadyApplied":false,"conflicts":[],"validationOccurrences":[{"shiftId":"s1","codeHash":"$hash","scannedAt":"${outcome.scannedAt}","outcome":"reprocessed"}]}"""))
        assertEquals(SyncEngine.Step.SENT, engine().drainOnce())
        assertEquals("reprocessed",db.validationDao().get("s1",hash)?.outcome)
        assertNull(db.codeDao().get(hash))
        assertEquals(1,db.codeDao().countForShift("s1"))
        assertEquals(0,db.outboxDao().countNow())
    }

    @Test fun acknowledgedOccurrenceCanLoseLaterWithoutLosingItsPrintEvidence() = runTest {
        val job=db.productLabelJobDao().get("j1")!!.copy(status="completed")
        db.productLabelJobDao().update(job)
        db.validationDao().insert(app.markiro.handheld.core.storage.ValidationOccurrenceEntity("s1",job.codeHash,job.acceptedAt,job.canonicalRaw,"04600682000013","AAA","op-1","dev-1",null,null,"reprocessed","reprocessed","reprocessed"))
        server.enqueue(MockResponse().setBody("""{"protocol":"validation-reprocessing-v1","occurrences":[{"shiftId":"s1","codeHash":"${job.codeHash}","scannedAt":"${job.acceptedAt}","outcome":"conflict"}]}"""))
        engine().reconcileValidationOccurrences()
        val request=server.takeRequest()
        assertEquals("/station/validation-occurrences/status",request.path)
        assertTrue(request.body.readUtf8().contains(job.acceptedAt))
        assertEquals("conflict",db.validationDao().get("s1",job.codeHash)?.outcome)
        assertEquals(0,db.codeDao().countForShift("s1"))
        db.productLabelJobDao().purgeSettledEverywhere()
        db.productLabelJobDao().dropBytesForShift("s1")
        assertEquals(job,db.productLabelJobDao().get("j1"))
    }
    @Test fun malformedOccurrenceReceiptDoesNotAcknowledgePinnedScans() = runTest {
        scan("raw")
        server.enqueue(MockResponse().setBody("""{"applied":1,"alreadyApplied":false,"validationOccurrences":{}}"""))
        assertEquals(SyncEngine.Step.FAILED,engine().drainOnce())
        assertEquals(1,db.outboxDao().countNow())
    }

    private fun engine(): SyncEngine {
        val client = OkHttpClient.Builder().addInterceptor(RevocationInterceptor(bus, db.recovery, Json { ignoreUnknownKeys = true })).build()
        return SyncEngine(
            db = db, meta = MetaStore(db), config = db.deviceConfigDao(),
            transport = SyncTransport(app.markiro.handheld.core.network.GenerationCallFactory(client, db.recovery)) { server.url("/").toString() }, json = strict,
            scope = engineScope, clock = { clock },
        )
    }

    private fun job(id: String) = ProductLabelJobEntity(
        jobId = id, shiftId = "s1", codeHash = "c".repeat(64), canonicalRaw = "raw",
        acceptedAt = "2026-09-11T08:00:00.000Z", operatorId = "op-1", policyRevision = "rev",
        templateDigest = "a".repeat(64), payloadDigest = "p".repeat(64), bytesBase64 = "AAEC",
        bytesDigest = "b".repeat(64), language = "zpl", dpi = 203, latestSequence = 1,
        attemptId = "att", attemptNo = 1, attemptState = "prepared", verification = "none",
        verificationOutcome = "not_required", status = "prepared", lastFailure = null,
    )

    private suspend fun event(id: String, sequence: Int, jobId: String = "j1", occurredAt: String = "2026-09-11T08:00:0$sequence.000Z") =
        db.productLabelEventDao().insert(
            ProductLabelEventEntity(
                eventId = id, jobId = jobId, sequence = sequence, kind = "sending",
                payloadJson = """{"eventId":"$id","jobId":"$jobId","sequence":$sequence,"kind":"sending"}""",
                occurredAt = occurredAt, ackedAt = null, quarantineCode = null,
            ),
        )

    private suspend fun scan(raw: String) = db.outboxDao().insert(
        OutboxEntity(
            shiftId = "s1", raw = raw, verdict = "ok", scannedAt = "2026-09-11T08:00:00.000Z", operatorId = "op-1",
            codeHash = "a".repeat(64), gtin14 = "04600682000013", serial = raw,
        ),
    )

    private fun ok(applied: Int, receipt: String? = null) = MockResponse().setResponseCode(201).setBody(
        """{"applied":$applied,"alreadyApplied":false,"conflicts":[]""" +
            (receipt?.let { ""","productLabelReceipt":$it""" } ?: "") + "}",
    )

    private fun receipt(accepted: List<String> = emptyList(), quarantined: List<Pair<String, String>> = emptyList()) =
        """{"protocol":"validation-dm-duplicate-v1","acceptedEventIds":${accepted.joinToString(",", "[", "]") { "\"$it\"" }},""" +
            """"quarantined":${quarantined.joinToString(",", "[", "]") { """{"eventId":"${it.first}","code":"${it.second}"}""" }}}"""

    private fun bodyOf(request: okhttp3.mockwebserver.RecordedRequest) =
        Json.parseToJsonElement(request.body.readUtf8()).jsonObject

    @Test
    fun eventsRideTheSameBatchAsScans() = runTest {
        scan("a")
        event("e1", 1)
        server.enqueue(ok(1, receipt(accepted = listOf("e1"))))
        assertTrue(engine().drainAll())
        val body = bodyOf(server.takeRequest())
        assertEquals(1, body.getValue("items").jsonArray.size)
        val events = body.getValue("productLabelEvents").jsonArray
        assertEquals(1, events.size)
        assertEquals("e1", events[0].jsonObject.getValue("eventId").jsonPrimitive.content)
    }

    /** An empty outbox with unsent events is not empty. */
    @Test
    fun aBatchOfEventsAloneIsStillSent() = runTest {
        event("e1", 1)
        server.enqueue(ok(0, receipt(accepted = listOf("e1"))))
        assertTrue(engine().drainAll())
        assertEquals(1, bodyOf(server.takeRequest()).getValue("productLabelEvents").jsonArray.size)
        assertNull(db.productLabelEventDao().unacked(10).firstOrNull())
    }

    /** The server refuses a gap, so the drain may not reorder a job's events. */
    @Test
    fun aJobsEventsAreSentInSequenceOrder() = runTest {
        event("e3", 3)
        event("e1", 1)
        event("e2", 2)
        server.enqueue(ok(0, receipt(accepted = listOf("e1", "e2", "e3"))))
        assertTrue(engine().drainAll())
        val events = bodyOf(server.takeRequest()).getValue("productLabelEvents").jsonArray
        assertEquals(
            listOf("e1", "e2", "e3"),
            events.map { it.jsonObject.getValue("eventId").jsonPrimitive.content },
        )
    }

    @Test
    fun aBatchIsCappedAtOneHundredEvents() = runTest {
        repeat(120) { event("e$it", it + 1, occurredAt = "2026-09-11T08:00:00.%03dZ".format(it)) }
        server.enqueue(ok(0, receipt(accepted = (0 until 100).map { "e$it" })))
        server.enqueue(ok(0, receipt(accepted = (100 until 120).map { "e$it" })))
        assertTrue(engine().drainAll())
        assertEquals(100, bodyOf(server.takeRequest()).getValue("productLabelEvents").jsonArray.size)
        assertEquals(20, bodyOf(server.takeRequest()).getValue("productLabelEvents").jsonArray.size)
    }

    /**
     * A batch in flight carries the event set it already chose. Growing one whose
     * id is fixed is how a record gets answered `alreadyApplied` and lost -- the
     * same rule box closures already follow.
     */
    @Test
    fun aPinnedBatchDoesNotPickUpEventsRecordedSince() = runTest {
        event("e1", 1)
        server.enqueue(MockResponse().setResponseCode(503))
        assertTrue(!engine().drainAll())
        server.takeRequest()

        event("e2", 2)
        server.enqueue(ok(0, receipt(accepted = listOf("e1"))))
        engine().drainAll()
        val retried = bodyOf(server.takeRequest()).getValue("productLabelEvents").jsonArray
        assertEquals(listOf("e1"), retried.map { it.jsonObject.getValue("eventId").jsonPrimitive.content })
    }

    @Test
    fun acceptedEventIdsLeaveTheQueue() = runTest {
        event("e1", 1)
        event("e2", 2)
        server.enqueue(ok(0, receipt(accepted = listOf("e1", "e2"))))
        assertTrue(engine().drainAll())
        assertEquals(emptyList<String>(), db.productLabelEventDao().unacked(10).map { it.eventId })
    }

    /** Quarantine is not delivery: the event leaves the queue but keeps its code. */
    @Test
    fun aQuarantinedEventIsNotTreatedAsAccepted() = runTest {
        event("e1", 1)
        server.enqueue(ok(0, receipt(quarantined = listOf("e1" to "policy_mismatch"))))
        assertTrue(engine().drainAll())
        assertEquals(emptyList<String>(), db.productLabelEventDao().unacked(10).map { it.eventId })
        assertEquals("policy_mismatch", db.productLabelEventDao().bySequence("j1").single().quarantineCode)
    }

    /**
     * An event the receipt does not mention stays owed. Acknowledging everything
     * sent -- the way box closures are acknowledged -- would drop it silently.
     */
    @Test
    fun anEventTheReceiptIgnoresStaysInTheQueue() = runTest {
        event("e1", 1)
        event("e2", 2)
        server.enqueue(ok(0, receipt(accepted = listOf("e1"))))
        server.enqueue(ok(0, receipt(accepted = listOf("e2"))))
        assertTrue(engine().drainAll())
        // The first drain left e2 owed, so a second pass picked it up.
        assertEquals(emptyList<String>(), db.productLabelEventDao().unacked(10).map { it.eventId })
        assertEquals(2, server.requestCount)
    }

    /** A response with no receipt at all acknowledges nothing. */
    @Test
    fun aResponseWithoutAReceiptLeavesEveryEventOwed() = runTest {
        event("e1", 1)
        server.enqueue(ok(0))
        engine().drainAll()
        assertEquals(listOf("e1"), db.productLabelEventDao().unacked(10).map { it.eventId })
    }

    @Test
    fun theSyncIndicatorCountsUnsentEvents() = runTest {
        event("e1", 1)
        event("e2", 2)
        // Room answers on its own threads, so the combined state arrives after
        // the flow is collected rather than at the moment it is built.
        assertEquals(2, engine().state.first { it.pending > 0 }.pending)
    }

    /**
     * `jsonObject` and friends THROW on the wrong kind, and nothing above this
     * catches: the throw would unwind the sync loop, which never restarts. A
     * captive portal answering 200 with another shape must be survivable.
     */
    @Test
    fun aReceiptOfTheWrongShapeIsIgnoredRatherThanFatal() = runTest {
        event("e1", 1)
        server.enqueue(
            MockResponse().setResponseCode(201).setBody(
                """{"applied":0,"alreadyApplied":false,"conflicts":[],""" +
                    """"productLabelReceipt":{"protocol":"x","acceptedEventIds":"not-an-array","quarantined":[1,null,{"eventId":2}]}}""",
            ),
        )
        server.enqueue(ok(0, receipt(accepted = listOf("e1"))))
        assertTrue(engine().drainAll())
        // Nothing was acknowledged from the broken receipt, and the loop lived.
        assertEquals(emptyList<String>(), db.productLabelEventDao().unacked(10).map { it.eventId })
        assertEquals(2, server.requestCount)
    }

    /** A batch id must change with its event set, or the second one is answered `alreadyApplied` and lost. */
    @Test
    fun differentEventSetsOfTheSameSizeSignDifferently() = runTest {
        event("e1", 1)
        server.enqueue(MockResponse().setResponseCode(503))
        engine().drainAll()
        val first = Json.parseToJsonElement(server.takeRequest().body.readUtf8())
            .jsonObject.getValue("batchId").jsonPrimitive.content

        db.productLabelEventDao().markAcked(listOf("e1"), "2026-09-11T09:00:00.000Z")
        db.metaDao().remove(MetaStore.SYNC_PENDING_BATCH_ID)
        db.metaDao().remove(MetaStore.SYNC_PENDING_CEILING)
        db.metaDao().remove(MetaStore.SYNC_PENDING_LABEL_COUNT)
        event("e2", 2)
        server.enqueue(MockResponse().setResponseCode(503))
        engine().drainAll()
        val second = Json.parseToJsonElement(server.takeRequest().body.readUtf8())
            .jsonObject.getValue("batchId").jsonPrimitive.content

        assertTrue("$first == $second", first != second)
    }
    @Test fun recoveryResendsExactLabelEventsAndBytesWithNewCredential() = runTest {
        event("e1", 1)
        scan("exact\u001dscan")
        val e = engine()
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"code":"STATION_CREDENTIAL_REVOKED"}"""))
        assertFalse(e.drainAll())
        val original = server.takeRequest().body.readUtf8()
        assertEquals(job("j1"), db.productLabelJobDao().get("j1"))
        assertEquals(1, db.productLabelEventDao().unacked(5).size)
        db.reconnectSameDeviceForTest()
        server.enqueue(ok(1, receipt(accepted = listOf("e1"))))
        assertTrue(e.drainAll())
        val retry = server.takeRequest()
        assertEquals(original, retry.body.readUtf8())
        assertEquals("restored-synthetic-key", retry.getHeader("x-api-key"))
        assertEquals("AAEC", db.productLabelJobDao().get("j1")?.bytesBase64)
        assertTrue(db.productLabelEventDao().unacked(5).isEmpty())
    }

}
