package app.markiro.handheld.core.host

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.host.HostPalletFixtures.BOX_1
import app.markiro.handheld.core.host.HostPalletFixtures.BOX_2
import app.markiro.handheld.core.host.HostPalletFixtures.PALLET
import app.markiro.handheld.core.host.HostPalletFixtures.ok
import app.markiro.handheld.core.host.HostPalletFixtures.routes
import app.markiro.handheld.core.network.host.FactReceiptDto
import app.markiro.handheld.core.network.host.HostApi
import app.markiro.handheld.core.storage.BoxRegistryEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MembershipStatus
import app.markiro.handheld.core.storage.PalletMembershipRemovalEntity
import app.markiro.handheld.core.storage.RemovalStatus
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class HostPalletConflictTest {
    private lateinit var db: HandheldDatabase

    @Before
    fun open() = runBlocking {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        db.deviceConfigDao().upsert(HostFactsFixtures.config(db))
        db.initializeRecoveryForTest()
        HostFactsFixtures.pool(db)
    }

    @After
    fun close() = db.close()

    private suspend fun registryRow(sscc: String, claimedBy: String? = null) = db.boxRegistryDao().upsert(
        BoxRegistryEntity(sscc, "b-$sscc", HostPalletFixtures.PRODUCT, 12, "[]", "2026-10-08T07:00:00Z", localPalletId = claimedBy),
    )

    private suspend fun frozen() = HostPalletEvents(db, clock = { "2026-10-15T10:00:00.000Z" }).also { it.freeze() }.let { db.hostOutboxDao().queuedFor("events", 100) }

    @Test
    fun boxOnPalletReleasesTheBoxLocallyAndRejectsTheMembershipWithoutStoppingTheQueue() = runTest {
        HostPalletFixtures.pallet(db)
        HostPalletFixtures.box(db, BOX_1, "2026-10-08T07:00:05.000Z")
        HostPalletFixtures.box(db, BOX_2, "2026-10-08T07:00:09.000Z")
        registryRow(BOX_1, claimedBy = PALLET)
        registryRow(BOX_2, claimedBy = PALLET)
        val events = frozen()
        val receipts = Json.decodeFromString<app.markiro.handheld.core.network.host.FactReceiptsDto>(
            """{"receipts":[{"id":"${events[0].recordId}","outcome":"accepted"},{"id":"${events[1].recordId}","outcome":"rejected","code":"box_on_pallet",""" +
                """"details":{"palletSscc":"146006820000000409","palletId":"a1000000-0000-4000-8000-0000000000b2"}},{"id":"${events[2].recordId}","outcome":"accepted"}]}""",
        ).receipts
        assertEquals(3, HostAckMapper(db, now = { "2026-10-15T10:01:00.000Z" }).apply(events, receipts))
        val state = db.palletMembershipDao().byPallet(PALLET).associate { it.sscc to it }
        assertEquals(MembershipStatus.REJECTED, state.getValue(BOX_1).status)
        assertEquals("box_on_pallet", state.getValue(BOX_1).reason)
        assertEquals("146006820000000409", state.getValue(BOX_1).winningPalletSscc)
        assertEquals(MembershipStatus.ACCEPTED, state.getValue(BOX_2).status)
        // the claim is released and the registry already says where the box is
        assertNull(db.boxRegistryDao().bySscc(BOX_1)!!.localPalletId)
        assertEquals("146006820000000409", db.boxRegistryDao().bySscc(BOX_1)!!.palletSscc)
        assertEquals(PALLET, db.boxRegistryDao().bySscc(BOX_2)!!.localPalletId)
        assertEquals(0, db.hostOutboxDao().quarantinedCount())
        assertEquals(0, db.hostOutboxDao().queuedCount())
    }

    @Test
    fun aConflictReceiptOfAnAddIsTheSameRefusal() = runTest {
        HostPalletFixtures.pallet(db)
        HostPalletFixtures.box(db, BOX_1, "2026-10-08T07:00:05.000Z")
        val events = frozen()
        HostAckMapper(db).apply(
            events,
            listOf(
                FactReceiptDto(events[0].recordId, "accepted"),
                FactReceiptDto(events[1].recordId, "conflict", details = Json.parseToJsonElement("""{"palletSscc":"146006820000000409"}""").jsonObject),
            ),
        )
        assertEquals(MembershipStatus.REJECTED, db.palletMembershipDao().byPallet(PALLET).single().status)
        assertEquals(0, db.hostOutboxDao().quarantinedCount())
    }

    @Test
    fun aRefusalOfThePalletItselfIsQuarantinedWithTheHostsCodeAndTheBoxStaysInFlight() = runTest {
        HostPalletFixtures.pallet(db)
        HostPalletFixtures.box(db, BOX_1, "2026-10-08T07:00:05.000Z")
        val events = frozen()
        HostAckMapper(db).apply(
            events,
            listOf(FactReceiptDto(events[0].recordId, "rejected", "feature_disabled"), FactReceiptDto(events[1].recordId, "rejected", "pallet_unknown")),
        )
        assertEquals(mapOf("warehouse_pallet_opened" to "feature_disabled", "pallet_box_added" to "pallet_unknown"), db.hostOutboxDao().quarantined().associate { it.kind to it.reason })
        assertEquals(MembershipStatus.SENT, db.palletMembershipDao().byPallet(PALLET).single().status)
    }

    @Test
    fun aRemovalOfABoxTheHostNeverHeardOfLeavesQuietly() = runTest {
        HostPalletFixtures.pallet(db)
        HostPalletFixtures.box(db, BOX_1, "2026-10-08T07:00:05.000Z")
        db.palletMembershipRemovalDao().insert(PalletMembershipRemovalEntity(0, PALLET, BOX_2, "2026-10-08T07:00:14.000Z", HostPalletFixtures.OPERATOR, RemovalStatus.PENDING))
        val events = frozen()
        val removal = events.single { it.kind == "pallet_box_removed" }
        HostAckMapper(db).apply(listOf(removal), listOf(FactReceiptDto(removal.recordId, "rejected", "box_not_found")))
        assertEquals(0, db.hostOutboxDao().quarantinedCount())
        assertTrue(db.palletMembershipRemovalDao().all().isEmpty())
    }

    @Test
    fun theEngineSendsTheEventsOnTheirOwnChannelAndThePalletClosesInALaterRoundOfTheSamePass() = runTest {
        HostPalletFixtures.pallet(db, closedAt = "2026-10-08T07:01:00.000Z", sscc = HostPalletFixtures.palletSscc(40))
        HostPalletFixtures.box(db, BOX_1, "2026-10-08T07:00:05.000Z")
        val answers = ArrayDeque<(List<String>) -> String>()
        val transport = object : app.markiro.handheld.core.network.host.HostTransport {
            val posts = mutableListOf<Pair<String, String>>()
            override suspend fun get(path: String) = error("no GET")
            override suspend fun post(path: String, body: String): app.markiro.handheld.core.network.host.HostResult {
                posts += path to body
                val ids = Json.parseToJsonElement(body).jsonObject.getValue("records").jsonArray.map { it.jsonObject.getValue("id").jsonPrimitive.content }
                return ok("""{"receipts":[${ids.joinToString(",") { """{"id":"$it","outcome":"accepted"}""" }}]}""")
            }
        }
        val engine = HostSyncEngine(db, { HostApi(transport) }, HostAckMapper(db), HostCalls { })
        assertTrue(engine.drainAll())
        assertEquals(listOf("/v1/device/pallet-events", "/v1/device/pallet-events"), transport.posts.map { it.first })
        val kinds = transport.posts.map { p -> Json.parseToJsonElement(p.second).jsonObject.getValue("records").jsonArray.map { it.jsonObject.getValue("kind").jsonPrimitive.content } }
        assertEquals(listOf(listOf("warehouse_pallet_opened", "pallet_box_added"), listOf("warehouse_pallet_closed")), kinds)
        assertEquals(0, db.hostOutboxDao().queuedCount())
        assertTrue("the close is acknowledged", db.palletDao().get(PALLET)!!.ackedAt != null)
        // a second pass has nothing to send
        assertTrue(engine.drainAll())
        assertEquals(2, transport.posts.size)
        assertEquals(0, answers.size)
    }
}
