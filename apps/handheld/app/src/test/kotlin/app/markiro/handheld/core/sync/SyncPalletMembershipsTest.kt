package app.markiro.handheld.core.sync

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.network.NetworkModule
import app.markiro.handheld.core.network.RevocationBus
import app.markiro.handheld.core.network.RevocationInterceptor
import app.markiro.handheld.core.storage.BoxRegistryEntity
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MembershipStatus
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.storage.PalletEntity
import app.markiro.handheld.core.storage.PalletKind
import app.markiro.handheld.core.storage.PalletMembershipEntity
import app.markiro.handheld.core.storage.initializeRecoveryForTest
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
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.TimeUnit

/**
 * Warehouse pallets (room 18) reporting through the same sync batch every
 * other channel rides: the membership records themselves, and the warehouse
 * pallet's own closure, which carries no shift.
 *
 * The rules that matter: a membership pinned into a batch in flight is resent
 * byte-identically and one scanned since waits for the next batch; the server
 * answers exactly one outcome per submitted record, in submission order; and
 * an answer that is not shaped that way acks nothing at all, because nothing
 * may silently drop a membership.
 */
@RunWith(AndroidJUnit4::class)
class SyncPalletMembershipsTest {
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

    private fun meta() = MetaStore(db)

    private fun ok(applied: Int) =
        MockResponse().setResponseCode(201).setBody("""{"applied":$applied,"alreadyApplied":false,"conflicts":[]}""")

    private fun bodyOf(request: RecordedRequest) = Json.parseToJsonElement(request.body.readUtf8()).jsonObject

    /** A missing request must fail the test loudly, not hang the runner for the default timeout. */
    private fun takeRequest(): RecordedRequest = server.takeRequest(5, TimeUnit.SECONDS)!!

    private suspend fun warehousePallet(palletId: String, closed: Boolean) = db.palletDao().insert(
        PalletEntity(
            palletId = palletId, shiftId = null, terminalId = "dev-1", sscc = if (closed) "134600682000000017" else null,
            openedAt = "2026-09-18T08:00:00.000Z", closedAt = if (closed) "2026-09-18T09:00:00.000Z" else null, operatorId = "op-1",
            printState = "pending", printReason = null, ackedAt = null, kind = PalletKind.WAREHOUSE, productId = "p-1", deviceId = "dev-1",
        ),
    )

    private suspend fun productionPallet(palletId: String) = db.palletDao().insert(
        PalletEntity(
            palletId = palletId, shiftId = "s1", terminalId = "dev-1", sscc = "046800899000000018",
            openedAt = "2026-09-18T08:00:00.000Z", closedAt = "2026-09-18T09:00:00.000Z", operatorId = "op-1",
            printState = "pending", printReason = null, ackedAt = null,
        ),
    )

    private suspend fun membership(palletId: String, sscc: String) = db.palletMembershipDao().insert(
        PalletMembershipEntity(palletId, sscc, "2026-09-18T08:10:00.000Z", "op-1", MembershipStatus.PENDING, null, null, null, null),
    )

    private fun outcome(vararg entries: String) =
        MockResponse().setResponseCode(201).setBody("""{"applied":0,"alreadyApplied":false,"conflicts":[],"memberships":[${entries.joinToString(",")}]}""")

    private fun replayedOutcome(vararg entries: String) =
        MockResponse().setResponseCode(201).setBody("""{"applied":0,"alreadyApplied":true,"conflicts":[],"memberships":[${entries.joinToString(",")}]}""")

    private suspend fun boxRegistry(sscc: String, localPalletId: String?) = db.boxRegistryDao().upsert(
        BoxRegistryEntity(sscc = sscc, boxId = "box-$sscc", productId = "p-1", bottleCount = 6, contentKeysJson = "[]", updatedAt = "t", localPalletId = localPalletId),
    )

    @Test
    fun membershipsRideTheBatchInSubmissionOrderAndTakeTheirOutcomes() = runTest {
        warehousePallet("w1", closed = false)
        membership("w1", "034600682000000018"); membership("w1", "034600682000000025")
        // Both boxes were claimed by this device onto pallet "w1" at scan time
        // (registry §2.4). The accepted one keeps its claim -- the registry
        // refresh settles it; the rejected one must be released back so it can
        // be scanned again.
        boxRegistry("034600682000000018", localPalletId = "w1")
        boxRegistry("034600682000000025", localPalletId = "w1")
        server.enqueue(
            outcome(
                """{"palletId":"w1","boxSscc":"034600682000000018","status":"accepted"}""",
                """{"palletId":"w1","boxSscc":"034600682000000025","status":"already_on_pallet","winningPalletSscc":"00134600682000000099"}""",
            ),
        )
        assertTrue(engine().drainAll())
        val body = bodyOf(takeRequest())
        assertEquals(
            listOf("034600682000000018", "034600682000000025"),
            body.getValue("palletMemberships").jsonArray.map { it.jsonObject.getValue("boxSscc").jsonPrimitive.content },
        )
        val rows = db.palletMembershipDao().byPallet("w1")
        assertEquals(MembershipStatus.ACCEPTED, rows[0].status)
        assertEquals(MembershipStatus.REJECTED, rows[1].status)
        assertEquals("already_on_pallet", rows[1].reason)
        // Stored the way this device stores every SSCC: 18 raw digits, with the
        // server's AI-(00) element-string prefix stripped. The screen's own
        // `takeLast(6)` reads the same either way, but a comparison against a
        // local `sscc` would silently never match.
        assertEquals("134600682000000099", rows[1].winningPalletSscc)
        assertNull(meta().get(MetaStore.SYNC_PENDING_MEMBERSHIP_COUNT))
        assertEquals("w1", db.boxRegistryDao().bySscc("034600682000000018")?.localPalletId)
        assertNull(db.boxRegistryDao().bySscc("034600682000000025")?.localPalletId)
    }

    @Test
    fun aMembershipScannedWhileABatchIsInFlightWaitsForTheNextOne() = runTest {
        warehousePallet("w1", closed = false)
        membership("w1", "034600682000000018")
        server.enqueue(MockResponse().setResponseCode(500))
        assertFalse(engine().drainAll())
        val first = bodyOf(takeRequest())
        membership("w1", "034600682000000025")
        server.enqueue(outcome("""{"palletId":"w1","boxSscc":"034600682000000018","status":"accepted"}"""))
        server.enqueue(outcome("""{"palletId":"w1","boxSscc":"034600682000000025","status":"accepted"}"""))
        assertTrue(engine().drainAll())
        val retry = bodyOf(takeRequest())
        assertEquals(first.getValue("batchId"), retry.getValue("batchId"))
        assertEquals(1, retry.getValue("palletMemberships").jsonArray.size)
        assertEquals(1, bodyOf(takeRequest()).getValue("palletMemberships").jsonArray.size)
    }

    @Test
    fun aWarehouseClosureCarriesKindProductAndNoShift() = runTest {
        warehousePallet("w1", closed = true)
        server.enqueue(ok(0))
        assertTrue(engine().drainAll())
        val pallet = bodyOf(takeRequest()).getValue("pallets").jsonArray.single().jsonObject
        assertEquals("warehouse", pallet.getValue("kind").jsonPrimitive.content)
        assertEquals("p-1", pallet.getValue("productId").jsonPrimitive.content)
        assertEquals("null", pallet.getValue("shiftId").toString())
        assertNotNull(db.palletDao().get("w1")?.ackedAt)
    }

    @Test
    fun aWarehouseAndAProductionClosureBothReachTheServer() = runTest {
        // A warehouse pallet has no shift task, so grant negotiation answers
        // `false` for it. That is not a reason for either closure to be
        // stranded: both ride whichever batch is assembled and both end
        // acknowledged.
        warehousePallet("w1", closed = true)
        productionPallet("p1")
        server.enqueue(ok(0))
        server.enqueue(ok(0))
        assertTrue(engine().drainAll())
        assertNotNull(db.palletDao().get("w1")?.ackedAt)
        assertNotNull(db.palletDao().get("p1")?.ackedAt)
    }

    @Test
    fun theQueueIndicatorCountsMembershipsToo() = runTest {
        warehousePallet("w1", closed = false)
        membership("w1", "034600682000000018")
        assertEquals(1, engine().state.first { it.pending == 1 }.pending)
    }

    @Test
    fun aMissingOrMalformedMembershipsAnswerDoesNotAckTheRows() = runTest {
        warehousePallet("w1", closed = false)
        membership("w1", "034600682000000018")
        server.enqueue(MockResponse().setResponseCode(201).setBody("""{"applied":0,"alreadyApplied":false,"conflicts":[]}"""))
        assertFalse(engine().drainAll())
        assertEquals(MembershipStatus.SENT, db.palletMembershipDao().byPallet("w1").single().status)
    }

    @Test
    fun aReplayOfThePinnedBatchIsAckedFromTheSameAnswer() = runTest {
        // The first POST for this pinned batch never reached this device's
        // ears (timeout, dropped response, whatever): the batch id is resent
        // unchanged, and the server answers `alreadyApplied` with the exact
        // same per-record outcomes it committed the first time. That must ack
        // the rows just as a fresh `applied` answer would.
        warehousePallet("w1", closed = false)
        membership("w1", "034600682000000018")
        server.enqueue(replayedOutcome("""{"palletId":"w1","boxSscc":"034600682000000018","status":"accepted"}"""))
        assertTrue(engine().drainAll())
        assertEquals(MembershipStatus.ACCEPTED, db.palletMembershipDao().byPallet("w1").single().status)
        assertNull(meta().get(MetaStore.SYNC_PENDING_MEMBERSHIP_COUNT))
        assertNull(meta().get(MetaStore.SYNC_PENDING_BATCH_ID))
    }

    @Test
    fun anAlreadyAppliedAnswerWithoutMembershipsWedgesRatherThanGuessing() = runTest {
        // `alreadyApplied` alone does not say what happened to a membership
        // this batch carried -- a server that predates the channel, or one
        // that merely replayed the scan/box/pallet side, can answer
        // `alreadyApplied:true` with no `memberships` array at all. Guessing
        // an outcome would silently gain or lose a box on a pallet, so this
        // must fail exactly like a fresh non-`alreadyApplied` answer without
        // memberships does: the rows stay `sent` and the identical batch is
        // retried.
        warehousePallet("w1", closed = false)
        membership("w1", "034600682000000018")
        server.enqueue(MockResponse().setResponseCode(201).setBody("""{"applied":0,"alreadyApplied":true,"conflicts":[]}"""))
        assertFalse(engine().drainAll())
        assertEquals(MembershipStatus.SENT, db.palletMembershipDao().byPallet("w1").single().status)
        assertNotNull(meta().get(MetaStore.SYNC_PENDING_BATCH_ID))
    }

    @Test
    fun aPinWithAForgottenMembershipCountRevertsItsSentRowsToPending() = runTest {
        // `SYNC_PENDING_MEMBERSHIP_COUNT` missing means zero, never
        // "everything pending" (see the comment in `drainOnceOwned`) -- a
        // pin written by a build that predates this channel, or one whose
        // count key was otherwise lost, must not resend a `sent` row that
        // key no longer names. `clearPendingOwned` is the only place that
        // gives such a row back to the queue: reached here by corrupting the
        // stored count between the failed first attempt and the retry, which
        // is the same "count says fewer than what is actually `sent`" shape
        // a lost/corrupted pin produces in the field.
        warehousePallet("w1", closed = false)
        membership("w1", "034600682000000018")
        server.enqueue(MockResponse().setResponseCode(500))
        assertFalse(engine().drainAll())
        assertEquals(MembershipStatus.SENT, db.palletMembershipDao().byPallet("w1").single().status)
        assertNotNull(meta().get(MetaStore.SYNC_PENDING_BATCH_ID))
        meta().put(MetaStore.SYNC_PENDING_MEMBERSHIP_COUNT, "0")
        // With the membership count forgotten and this batch carrying nothing
        // else, the next drain sees every channel empty under the pin and
        // abandons it.
        assertTrue(engine().drainAll())
        assertNull(meta().get(MetaStore.SYNC_PENDING_BATCH_ID))
        assertEquals(MembershipStatus.PENDING, db.palletMembershipDao().byPallet("w1").single().status)
    }
}
