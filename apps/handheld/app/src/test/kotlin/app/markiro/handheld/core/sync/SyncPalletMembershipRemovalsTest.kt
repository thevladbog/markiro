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
import app.markiro.handheld.core.storage.PalletMembershipRemovalEntity
import app.markiro.handheld.core.storage.RemovalStatus
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
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.TimeUnit

/**
 * Taking a box back off an open warehouse pallet (design spec §3.3), riding
 * the same sync batch every other channel does.
 *
 * The rules that matter: a removal pinned into a batch in flight is resent
 * byte-identically and one queued since waits for the next batch; the server
 * answers exactly one outcome per submitted record, in submission order; an
 * answer not shaped that way acks nothing; and every terminal status consumes
 * the row, with only the statuses that say the box is free touching the
 * registry mirror.
 */
@RunWith(AndroidJUnit4::class)
class SyncPalletMembershipRemovalsTest {
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

    private suspend fun boxRegistry(sscc: String, palletId: String?, palletActive: Boolean) = db.boxRegistryDao().upsert(
        BoxRegistryEntity(
            sscc = sscc, boxId = "box-$sscc", productId = "p-1", bottleCount = 6, contentKeysJson = "[]", updatedAt = "t",
            palletId = palletId, palletActive = palletActive,
        ),
    )

    private suspend fun membership(palletId: String, sscc: String) = db.palletMembershipDao().insert(
        PalletMembershipEntity(palletId, sscc, "2026-09-18T08:10:00.000Z", "op-1", MembershipStatus.PENDING, null, null, null, null),
    )

    private suspend fun removal(palletId: String, sscc: String) = db.palletMembershipRemovalDao().insert(
        PalletMembershipRemovalEntity(
            palletId = palletId, sscc = sscc, removedAt = "2026-09-18T08:20:00.000Z", operatorId = "op-1", status = RemovalStatus.PENDING,
        ),
    )

    private fun outcome(vararg entries: String) = MockResponse().setResponseCode(201)
        .setBody("""{"applied":0,"alreadyApplied":false,"conflicts":[],"membershipRemovals":[${entries.joinToString(",")}]}""")

    private fun membershipOutcome(removals: String, memberships: String) = MockResponse().setResponseCode(201).setBody(
        """{"applied":0,"alreadyApplied":false,"conflicts":[],"memberships":[$memberships],"membershipRemovals":[$removals]}""",
    )

    @Test
    fun removalsRideTheBatchInOrderAndAreDeletedOnAnyAnswer() = runTest {
        warehousePallet("w1", closed = false)
        removal("w1", "034600682000000018")
        removal("w1", "034600682000000025")
        // Both boxes read as sitting on the server's pallet `srv` in the
        // registry mirror. Only the answer that says the box is free may
        // clear that; a closed pallet leaves the mirror to the next refresh.
        boxRegistry("034600682000000018", palletId = "srv", palletActive = true)
        boxRegistry("034600682000000025", palletId = "srv", palletActive = true)
        server.enqueue(
            outcome(
                """{"palletId":"w1","boxSscc":"034600682000000018","status":"removed"}""",
                """{"palletId":"w1","boxSscc":"034600682000000025","status":"pallet_closed"}""",
            ),
        )
        assertTrue(engine().drainAll())
        val body = bodyOf(takeRequest())
        val sent = body.getValue("palletMembershipRemovals").jsonArray.map { it.jsonObject }
        assertEquals(
            listOf("034600682000000018", "034600682000000025"),
            sent.map { it.getValue("boxSscc").jsonPrimitive.content },
        )
        assertEquals("2026-09-18T08:20:00.000Z", sent[0].getValue("removedAt").jsonPrimitive.content)
        assertEquals("op-1", sent[0].getValue("operatorId").jsonPrimitive.content)
        // Terminal either way: the queue is empty afterwards.
        assertTrue(db.palletMembershipRemovalDao().all().isEmpty())
        assertNull(meta().get(MetaStore.SYNC_PENDING_MEMBERSHIP_REMOVAL_COUNT))
        val removed = db.boxRegistryDao().bySscc("034600682000000018")
        assertNull(removed?.palletId)
        assertFalse(removed!!.palletActive)
        val untouched = db.boxRegistryDao().bySscc("034600682000000025")
        assertEquals("srv", untouched?.palletId)
        assertTrue(untouched!!.palletActive)
    }

    @Test
    fun aMissingOrShortRemovalsAnswerDoesNotAckTheRows() = runTest {
        warehousePallet("w1", closed = false)
        removal("w1", "034600682000000018")
        server.enqueue(MockResponse().setResponseCode(201).setBody("""{"applied":0,"alreadyApplied":false,"conflicts":[]}"""))
        assertFalse(engine().drainAll())
        assertEquals(RemovalStatus.SENT, db.palletMembershipRemovalDao().all().single().status)
    }

    @Test
    fun aRemovalQueuedWhileABatchIsInFlightWaitsForTheNextOne() = runTest {
        warehousePallet("w1", closed = false)
        removal("w1", "034600682000000018")
        server.enqueue(MockResponse().setResponseCode(500))
        assertFalse(engine().drainAll())
        val first = bodyOf(takeRequest())
        removal("w1", "034600682000000025")
        server.enqueue(outcome("""{"palletId":"w1","boxSscc":"034600682000000018","status":"removed"}"""))
        server.enqueue(outcome("""{"palletId":"w1","boxSscc":"034600682000000025","status":"removed"}"""))
        assertTrue(engine().drainAll())
        val retry = bodyOf(takeRequest())
        assertEquals(first.getValue("batchId"), retry.getValue("batchId"))
        assertEquals(1, retry.getValue("palletMembershipRemovals").jsonArray.size)
        assertEquals(1, bodyOf(takeRequest()).getValue("palletMembershipRemovals").jsonArray.size)
    }

    @Test
    fun theQueueIndicatorCountsRemovalsToo() = runTest {
        warehousePallet("w1", closed = false)
        removal("w1", "034600682000000018")
        assertEquals(1, engine().state.first { it.pending == 1 }.pending)
    }

    @Test
    fun aRemovalAndAMembershipShareOneBatch() = runTest {
        warehousePallet("w1", closed = false)
        membership("w1", "034600682000000032")
        removal("w1", "034600682000000018")
        boxRegistry("034600682000000018", palletId = "srv", palletActive = true)
        server.enqueue(
            membershipOutcome(
                removals = """{"palletId":"w1","boxSscc":"034600682000000018","status":"removed"}""",
                memberships = """{"palletId":"w1","boxSscc":"034600682000000032","status":"accepted"}""",
            ),
        )
        assertTrue(engine().drainAll())
        val body = bodyOf(takeRequest())
        assertEquals(1, body.getValue("palletMemberships").jsonArray.size)
        assertEquals(1, body.getValue("palletMembershipRemovals").jsonArray.size)
        assertTrue(db.palletMembershipRemovalDao().all().isEmpty())
        assertEquals(MembershipStatus.ACCEPTED, db.palletMembershipDao().byPallet("w1").single().status)
        assertNull(db.boxRegistryDao().bySscc("034600682000000018")?.palletId)
    }
}
