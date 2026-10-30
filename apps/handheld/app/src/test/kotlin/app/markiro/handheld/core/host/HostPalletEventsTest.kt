package app.markiro.handheld.core.host

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.host.HostPalletFixtures.BOX_1
import app.markiro.handheld.core.host.HostPalletFixtures.BOX_2
import app.markiro.handheld.core.host.HostPalletFixtures.PALLET
import app.markiro.handheld.core.network.host.FactReceiptDto
import app.markiro.handheld.core.exceptions.DisassembleReason
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.storage.PalletExceptionEntity
import app.markiro.handheld.core.storage.MembershipStatus
import app.markiro.handheld.core.storage.PalletMembershipRemovalEntity
import app.markiro.handheld.core.storage.RemovalStatus
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class HostPalletEventsTest {
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

    private suspend fun events() = db.hostOutboxDao().queuedFor("events", 100)

    private fun events(clock: String) = HostPalletEvents(db, clock = { clock })

    @Test
    fun aWarehousePalletsFirstBoxMakesOpenAndAddEventsInOrderWithStableIds() = runTest {
        HostPalletFixtures.pallet(db)
        HostPalletFixtures.box(db, BOX_1, "2026-10-08T07:00:05.000Z")
        HostPalletFixtures.box(db, BOX_2, "2026-10-08T07:00:09.000Z")
        events("2026-10-15T10:00:00.000Z").freeze()
        val first = events()
        assertEquals(listOf("warehouse_pallet_opened", "pallet_box_added", "pallet_box_added"), first.map { it.kind })
        // Freezing again changes nothing: ids derive from the pallet and the box, and a frozen source is not frozen twice.
        events("2026-10-15T10:05:00.000Z").freeze()
        assertEquals(first.map { it.recordId to it.body }, events().map { it.recordId to it.body })
        assertEquals(listOf(MembershipStatus.SENT, MembershipStatus.SENT), db.palletMembershipDao().byPallet(PALLET).map { it.status })
    }

    @Test
    fun theClosingRecordHasTheShapeOfTheFixturesRecord() = runTest {
        HostPalletFixtures.pallet(db, closedAt = "2026-10-08T07:01:00.000Z", sscc = HostPalletFixtures.palletSscc(40))
        HostPalletFixtures.box(db, BOX_1, "2026-10-08T07:00:05.000Z")
        db.palletMembershipRemovalDao().insert(PalletMembershipRemovalEntity(0, PALLET, BOX_2, "2026-10-08T07:00:14.000Z", HostPalletFixtures.OPERATOR, RemovalStatus.PENDING))
        val tool = events("2026-10-15T10:00:00.000Z")
        tool.freeze()
        // The close waits for the settled boxes: acknowledge the open, the add and the removal, then it appears.
        HostAckMapper(db).apply(events(), events().map { FactReceiptDto(it.recordId, "accepted") })
        tool.freeze()
        val all = events()
        assertEquals(listOf("warehouse_pallet_closed"), all.map { it.kind })
        val fixture = HostFactsFixtures.fixture("pallet-events-request.json").getValue("records")
        val byKind = (fixture as kotlinx.serialization.json.JsonArray).map { it.jsonObject }.associateBy { it.getValue("kind").toString().trim('"') }
        val closed = Json.parseToJsonElement(all.single().body).jsonObject
        assertEquals(HostFactsFixtures.shape(byKind.getValue("warehouse_pallet_closed")), HostFactsFixtures.shape(closed))
        assertEquals(1, closed.getValue("data").jsonObject.getValue("boxCount").toString().toInt())
    }

    /** A closed pallet taken apart on this device, as `ExceptionEngine.disassemblePallet` leaves it. */
    private suspend fun takenApart(closeAcked: Boolean) {
        HostPalletFixtures.pallet(db, closedAt = "2026-10-08T07:01:00.000Z", sscc = HostPalletFixtures.palletSscc(40))
        if (closeAcked) db.palletDao().markAcked(listOf(PALLET), "2026-10-08T07:02:00.000Z")
        db.palletDao().markDisassembled(PALLET, "2026-10-08T07:05:00.000Z")
        db.palletExceptionDao().insert(
            PalletExceptionEntity(
                kind = "disassemble", palletId = PALLET, shiftId = null, terminalId = "d1", operatorId = HostPalletFixtures.OPERATOR,
                reason = DisassembleReason.WRONG_PRODUCT.audit, occurredAt = "2026-10-08T07:05:00.000Z", payloadJson = "{}", ackedAt = null,
            ),
        )
    }

    /** MKR-INS-14: the host never heard of a disassembly, so the boxes stayed «На паллете …» there. */
    @Test
    fun aPalletTakenApartIsSentOnceToAHostThatReadsItAfterItsClose() = runTest {
        takenApart(closeAcked = true)
        events("2026-10-15T10:00:00.000Z").freeze()
        assertEquals("a host never heard is not assumed to read it", emptyList<String>(), events().map { it.kind })
        MetaStore(db).put(MetaStore.HOST_PROTOCOL, "7")
        events("2026-10-15T10:00:00.000Z").freeze()
        assertEquals("a host of protocol 7 refuses the kind for good", emptyList<String>(), events().map { it.kind })
        MetaStore(db).put(MetaStore.HOST_PROTOCOL, "8")
        events("2026-10-15T10:00:00.000Z").freeze()
        val sent = events()
        assertEquals(listOf("warehouse_pallet_disassembled"), sent.map { it.kind })
        val record = Json.parseToJsonElement(sent.single().body).jsonObject
        val fixture = (HostFactsFixtures.fixture("pallet-events-request.json").getValue("records") as kotlinx.serialization.json.JsonArray)
            .map { it.jsonObject }.single { it.getValue("kind").toString().trim('"') == "warehouse_pallet_disassembled" }
        assertEquals(HostFactsFixtures.shape(fixture), HostFactsFixtures.shape(record))
        val data = record.getValue("data").jsonObject
        assertEquals("\"wrong_product\"", data.getValue("reasonCode").toString())
        assertEquals("\"2026-10-08T07:05:00.000Z\"", data.getValue("disassembledAt").toString())
        assertEquals("\"$PALLET\"", data.getValue("palletId").toString())
        // Frozen once: a second pass makes nothing, and the host's receipt settles the source for good.
        events("2026-10-15T10:05:00.000Z").freeze()
        assertEquals(sent.map { it.recordId to it.body }, events().map { it.recordId to it.body })
        HostAckMapper(db).apply(events(), events().map { FactReceiptDto(it.recordId, "accepted") })
        events("2026-10-15T10:10:00.000Z").freeze()
        assertEquals(emptyList<String>(), events().map { it.kind })
        assertEquals(0, db.palletExceptionDao().unackedCount())
    }

    @Test
    fun aDisassemblyWaitsForTheHostToAcknowledgeThePalletsClose() = runTest {
        takenApart(closeAcked = false)
        MetaStore(db).put(MetaStore.HOST_PROTOCOL, "8")
        events("2026-10-15T10:00:00.000Z").freeze()
        assertTrue("warehouse_pallet_disassembled" !in events().map { it.kind })
    }

    @Test
    fun theOpeningAddingAndRemovingRecordsHaveTheShapeOfTheFixturesRecords() = runTest {
        HostPalletFixtures.pallet(db)
        HostPalletFixtures.box(db, BOX_1, "2026-10-08T07:00:05.000Z")
        db.palletMembershipRemovalDao().insert(PalletMembershipRemovalEntity(0, PALLET, BOX_2, "2026-10-08T07:00:14.000Z", HostPalletFixtures.OPERATOR, RemovalStatus.PENDING))
        events("2026-10-15T10:00:00.000Z").freeze()
        val fixture = (HostFactsFixtures.fixture("pallet-events-request.json").getValue("records") as kotlinx.serialization.json.JsonArray)
            .map { it.jsonObject }.associateBy { it.getValue("kind").toString().trim('"') }
        for (row in events()) {
            val record = Json.parseToJsonElement(row.body).jsonObject
            assertEquals(row.kind, HostFactsFixtures.shape(fixture.getValue(row.kind)), HostFactsFixtures.shape(record))
        }
        assertEquals(3, events().size)
    }

    @Test
    fun theCloseWaitsForTheBoxEventsAndCountsTheBoxesTheHostKept() = runTest {
        HostPalletFixtures.pallet(db, closedAt = "2026-10-08T07:01:00.000Z", sscc = HostPalletFixtures.palletSscc(40))
        HostPalletFixtures.box(db, BOX_1, "2026-10-08T07:00:05.000Z")
        HostPalletFixtures.box(db, BOX_2, "2026-10-08T07:00:09.000Z")
        val tool = events("2026-10-15T10:00:00.000Z")
        tool.freeze()
        assertEquals("no close while the boxes are unanswered", listOf("warehouse_pallet_opened", "pallet_box_added", "pallet_box_added"), events().map { it.kind })
        val ids = events().map { it.recordId }
        val receipts = listOf(
            FactReceiptDto(ids[0], "accepted"),
            FactReceiptDto(ids[1], "accepted"),
            FactReceiptDto(ids[2], "rejected", "box_on_pallet"),
        )
        HostAckMapper(db).apply(events(), receipts)
        tool.freeze()
        val close = Json.parseToJsonElement(events().single().body).jsonObject.getValue("data").jsonObject
        assertEquals("1", close.getValue("boxCount").toString())
        assertEquals(HostFactsFixtures.PALLET_BLOCK, close.getValue("blockId").toString().trim('"'))
        assertEquals("40", close.getValue("serial").toString())
    }

    @Test
    fun aBoxScannedAgainAfterItWasTakenOffIsANewRecordAndTheTakingOffGoesBetween() = runTest {
        HostPalletFixtures.pallet(db)
        HostPalletFixtures.box(db, BOX_1, "2026-10-08T07:00:05.000Z")
        val tool = events("2026-10-15T10:00:00.000Z")
        tool.freeze()
        // taken off (the membership leaves with its row) and scanned again
        db.palletMembershipDao().delete(PALLET, BOX_1)
        db.palletMembershipRemovalDao().insert(PalletMembershipRemovalEntity(0, PALLET, BOX_1, "2026-10-08T07:00:30.000Z", HostPalletFixtures.OPERATOR, RemovalStatus.PENDING))
        HostPalletFixtures.box(db, BOX_1, "2026-10-08T07:00:40.000Z")
        tool.freeze()
        val kinds = events().map { it.kind }
        assertEquals(listOf("warehouse_pallet_opened", "pallet_box_added", "pallet_box_removed", "pallet_box_added"), kinds)
        assertNotEquals(events()[1].recordId, events()[3].recordId)
        // the removal is frozen: a box taken off once more is a row of its own, not the first one reused
        assertEquals(RemovalStatus.SENT, db.palletMembershipRemovalDao().all().single().status)
    }

    @Test
    fun anEmptyDraftIsNeverSentAndAnAcknowledgedOpeningIsNotSentAgain() = runTest {
        HostPalletFixtures.pallet(db)
        val tool = events("2026-10-15T10:00:00.000Z")
        assertEquals(0, tool.freeze())
        HostPalletFixtures.box(db, BOX_1, "2026-10-08T07:00:05.000Z")
        tool.freeze()
        HostAckMapper(db).apply(events(), events().map { FactReceiptDto(it.recordId, "accepted") })
        assertTrue(events().isEmpty())
        // another box on the same pallet: only the box, the host already has the pallet
        HostPalletFixtures.box(db, BOX_2, "2026-10-08T07:02:00.000Z")
        tool.freeze()
        assertEquals(listOf("pallet_box_added"), events().map { it.kind })
    }
}
