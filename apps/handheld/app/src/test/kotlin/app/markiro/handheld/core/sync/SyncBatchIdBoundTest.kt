package app.markiro.handheld.core.sync

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
import app.markiro.handheld.core.storage.PalletEntity
import app.markiro.handheld.core.storage.PalletExceptionEntity
import app.markiro.handheld.core.storage.ProductLabelEventEntity
import app.markiro.handheld.core.storage.ProductLabelJobEntity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
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
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

/**
 * The batch-id construction comment in `SyncEngine.drainOnce` argues, in
 * arithmetic, that a fully-loaded id (every channel at its cap, with
 * production-shaped 36-char UUID row ids) stays under the server's shared
 * `MAX_SYNC_BATCH_ID_CHARS`, because each channel is folded into a short
 * `idSignature` rather than concatenated raw. That argument was never
 * asserted: this loads every channel to its ceiling and checks the id that
 * actually comes out, so a future channel -- or a regression back to
 * concatenating raw ids -- cannot silently push it over without failing here.
 */
@RunWith(AndroidJUnit4::class)
class SyncBatchIdBoundTest {
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
                deviceId = UUID.randomUUID().toString(), deviceName = "ТСД 1", tenantId = "t-1", organizationName = "ООО",
                lineId = "l1", lineName = "Линия 2", kind = "handheld", serverUrl = server.url("/").toString(), pairedAt = 1L,
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
        val client = OkHttpClient.Builder().addInterceptor(RevocationInterceptor(bus, db.recovery, Json { ignoreUnknownKeys = true })).build()
        val transport = SyncTransport(app.markiro.handheld.core.network.GenerationCallFactory(client, db.recovery)) { server.url("/").toString() }
        return SyncEngine(
            db = db, meta = MetaStore(db), config = db.deviceConfigDao(),
            transport = transport, json = strict,
            scope = engineScope, clock = { clock },
        )
    }

    private suspend fun closedBox(closedAt: String) = db.boxDao().insert(
        BoxEntity(
            boxId = UUID.randomUUID().toString(), shiftId = "s1", sscc = "046800899000000019",
            openedAt = "2026-09-10T10:00:00.000Z", closedAt = closedAt, operatorId = "op-1",
            printState = "pending", printReason = null, ackedAt = null,
        ),
    )

    private suspend fun closedPallet(closedAt: String): String {
        val id = UUID.randomUUID().toString()
        db.palletDao().insert(
            PalletEntity(
                palletId = id, shiftId = "s1", terminalId = null, sscc = "046800899000000018",
                openedAt = "2026-09-10T10:00:00.000Z", closedAt = closedAt, operatorId = "op-1",
                printState = "pending", printReason = null, ackedAt = null,
            ),
        )
        return id
    }

    private suspend fun event(jobId: String, sequence: Int): String {
        val id = UUID.randomUUID().toString()
        db.productLabelEventDao().insert(
            ProductLabelEventEntity(
                eventId = id, jobId = jobId, sequence = sequence, kind = "sending",
                payloadJson = """{"eventId":"$id","jobId":"$jobId","sequence":$sequence,"kind":"sending"}""",
                occurredAt = "2026-09-10T09:%02d:%02d.000Z".format(sequence / 60, sequence % 60),
                ackedAt = null, quarantineCode = null,
            ),
        )
        return id
    }

    /**
     * `kind = "clear"` with a zero watermark: `BoxExceptionDao.sendable` lets
     * `undo`/`clear` past without waiting for a box closure, which is what
     * makes this channel reachable at its ceiling in one batch.
     */
    private suspend fun boxException(index: Int) = db.boxExceptionDao().insert(
        BoxExceptionEntity(
            kind = "clear", boxId = "box-$index", codeHash = null, targetScannedAt = null,
            shiftId = "s1", operatorId = "op-1", reason = null,
            occurredAt = "2026-09-10T13:%02d:%02d.000Z".format(index / 60, index % 60),
            payloadJson = """{"kind":"clear","boxId":"box-$index"}""",
            afterOutboxId = 0, ackedAt = null,
        ),
    )

    /** Names a pallet this same batch closes, which is what makes it sendable. */
    private suspend fun palletException(palletId: String) = db.palletExceptionDao().insert(
        PalletExceptionEntity(
            kind = "reprint", palletId = palletId, shiftId = "s1", terminalId = "dev-1",
            operatorId = "op-1", reason = "Результат печати неизвестен",
            occurredAt = "2026-09-10T14:00:00.000Z",
            payloadJson = """{"kind":"reprint","palletId":"$palletId"}""",
            ackedAt = null,
        ),
    )

    private fun job(id: String) = ProductLabelJobEntity(
        jobId = id, shiftId = "s1", codeHash = "c".repeat(64), canonicalRaw = "raw",
        acceptedAt = "2026-09-10T08:00:00.000Z", operatorId = "op-1", policyRevision = "rev",
        templateDigest = "a".repeat(64), payloadDigest = "p".repeat(64), bytesBase64 = "AAEC",
        bytesDigest = "b".repeat(64), language = "zpl", dpi = 203, latestSequence = 1,
        attemptId = "att", attemptNo = 1, attemptState = "prepared", verification = "none",
        verificationOutcome = "not_required", status = "prepared", lastFailure = null,
    )

    private fun ok(applied: Int, acceptedEventIds: List<String> = emptyList()) = MockResponse().setResponseCode(201).setBody(
        """{"applied":$applied,"alreadyApplied":false,"conflicts":[],""" +
            """"productLabelReceipt":{"acceptedEventIds":${acceptedEventIds.joinToString(",", "[", "]") { "\"$it\"" }},""" +
            """"quarantined":[]}}""",
    )

    private fun bodyOf(request: RecordedRequest) = Json.parseToJsonElement(request.body.readUtf8()).jsonObject

    @Test
    fun aFullyLoadedBatchIdStaysWithinTheSharedBound() = runTest {
        db.productLabelJobDao().insert(job("j1"))
        repeat(SyncEngine.MAX_BOX_CLOSURES) { closedBox("2026-09-10T11:%02d:%02d.000Z".format(it / 60, it % 60)) }
        val palletIds = (0 until SyncEngine.MAX_PALLET_CLOSURES)
            .map { closedPallet("2026-09-10T12:%02d:%02d.000Z".format(it / 60, it % 60)) }
        val eventIds = (0 until SyncEngine.MAX_PRODUCT_LABEL_EVENTS).map { event("j1", it) }
        // Both correction channels, which the earlier version of this test left
        // at their empty `"0"` signature -- under-measuring the worst case by
        // roughly the length of two real signatures.
        repeat(SyncEngine.MAX_EXCEPTIONS) { boxException(it) }
        repeat(SyncEngine.MAX_PALLET_EXCEPTIONS) { palletException(palletIds[it]) }

        // The response acknowledges every event too, so this stays a single
        // round trip -- an unacknowledged event would otherwise ride a second,
        // unloaded batch straight after and defeat the point of this test.
        server.enqueue(ok(0, eventIds))
        assertTrue(engine().drainAll())
        val body = bodyOf(server.takeRequest())

        // Every channel actually reached its ceiling -- otherwise this would not
        // be the worst case the shared bound is meant to survive.
        assertEquals(SyncEngine.MAX_BOX_CLOSURES, body.getValue("boxes").jsonArray.size)
        assertEquals(SyncEngine.MAX_PALLET_CLOSURES, body.getValue("pallets").jsonArray.size)
        assertEquals(SyncEngine.MAX_PRODUCT_LABEL_EVENTS, body.getValue("productLabelEvents").jsonArray.size)
        assertEquals(SyncEngine.MAX_EXCEPTIONS, body.getValue("exceptions").jsonArray.size)
        assertEquals(SyncEngine.MAX_PALLET_EXCEPTIONS, body.getValue("palletExceptions").jsonArray.size)

        val batchId = body.getValue("batchId").jsonPrimitive.content
        assertTrue(
            "batchId is ${batchId.length} chars, over SyncEngine.MAX_SYNC_BATCH_ID_CHARS (${SyncEngine.MAX_SYNC_BATCH_ID_CHARS})",
            batchId.length <= SyncEngine.MAX_SYNC_BATCH_ID_CHARS,
        )
    }

    // -- `boundedBatchId` itself. The loaded drain above measures today's worst
    // case; these pin down the fold that keeps the NEXT channel (or a device
    // whose outbox ceiling has grown into a 19-digit Long) from silently
    // crossing the bound and wedging every channel behind a 400 forever. --

    @Test
    fun aKeyUnderTheBoundIsReturnedUntouched() {
        val exact = "k".repeat(SyncEngine.MAX_SYNC_BATCH_ID_CHARS)
        assertEquals(exact, engine().boundedBatchId(exact))
        assertEquals("dev-1:inst-1:3:0:0:0:0:0", engine().boundedBatchId("dev-1:inst-1:3:0:0:0:0:0"))
    }

    @Test
    fun anOverLongKeyFoldsToABoundedDeterministicDigest() {
        val over = "k".repeat(SyncEngine.MAX_SYNC_BATCH_ID_CHARS + 1)
        val folded = engine().boundedBatchId(over)
        assertTrue("folded id is ${folded.length} chars", folded.length <= SyncEngine.MAX_SYNC_BATCH_ID_CHARS)
        assertTrue("a folded id must not be mistakable for a plain one", folded.startsWith("sync:"))
        // A retry of the SAME set must keep the same id, or the server applies it twice.
        assertEquals(folded, engine().boundedBatchId(over))
        // ...and two genuinely different sets must keep different ids, or the
        // second is answered `alreadyApplied` and lost.
        assertNotEquals(folded, engine().boundedBatchId(over + "x"))
    }
}
