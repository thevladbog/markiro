package app.markiro.handheld.core.inventory

import app.markiro.handheld.core.storage.initializeRecoveryForTest
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.km.KmCodec
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.InventoryFixtures
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class InventoryRecorderTest {
    private lateinit var db: HandheldDatabase
    private var clock = 1_757_500_000_000L
    private val gs = "\u001d"
    private val sscc = "346006820000000014"

    private fun raw(serial: String, gtin: String = "04600000000015") = "01${gtin}21$serial${gs}93AbCd"
    private fun hash(serial: String) = KmCodec.hash(KmCodec.canonicalize(raw(serial)))

    @Before
    fun setUp() = runTest {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java).allowMainThreadQueries().build()
        db.deviceConfigDao().upsert(
            DeviceConfigEntity(
                deviceId = "dev-1", deviceName = "ТСД 1", tenantId = "t", organizationName = "ООО", lineId = "l1", lineName = "Линия 2",
                kind = "handheld", serverUrl = "http://x", pairedAt = 1L, activeInventoryId = "i1",
            ),
        )
        db.inventoryTaskDao().upsert(InventoryFixtures.task("i1"))
        db.inventorySnapshotCodeDao().insertAll(
            listOf(
                InventoryFixtures.code("snap", hash("A1"), serial = "A1", date = "2026-08-20"),
                InventoryFixtures.code("snap", hash("A2"), serial = "A2", date = "2026-08-22"),
                InventoryFixtures.code("snap", hash("B1"), serial = "B1", parentSscc = sscc, date = "2026-08-20"),
                InventoryFixtures.code("snap", hash("B2"), serial = "B2", parentSscc = sscc, date = "2026-08-20"),
                InventoryFixtures.code("snap", hash("P1"), serial = "P1", state = "MOVING_BY_UD", expected = false, protected = true),
                InventoryFixtures.code("snap", hash("R1"), serial = "R1", status = "RETIRED", expected = false),
            ),
        )
        db.initializeRecoveryForTest()
    }

    @After
    fun tearDown() = db.close()

    private fun recorder() = InventoryRecorder(db) { clock }

    @Test
    fun everyVerdictAndTheFirstScanAdoptsTheCodeDate() = runTest {
        val r = recorder()
        val ok = r.record("i1", raw("A1"), "op-1") as RecordOutcome.Recorded
        assertEquals(InventoryVerdict.EXPECTED, ok.verdict)
        assertEquals("…A1", ok.tail)
        assertEquals("2026-08-20", r.activeDate("i1"))
        assertEquals(InventoryVerdict.DUPLICATE, (r.record("i1", raw("A1"), "op-1") as RecordOutcome.Recorded).verdict)
        assertEquals(InventoryVerdict.PROTECTED, (r.record("i1", raw("P1"), "op-1") as RecordOutcome.Recorded).verdict)
        val retired = r.record("i1", raw("R1"), "op-1") as RecordOutcome.Recorded
        assertEquals(InventoryVerdict.KNOWN_INELIGIBLE, retired.verdict)
        assertEquals("RETIRED", retired.sourceStatus)
        assertEquals(InventoryVerdict.UNKNOWN, (r.record("i1", raw("ZZ"), "op-1") as RecordOutcome.Recorded).verdict)
        val again = r.record("i1", raw("ZZ"), "op-1") as RecordOutcome.Recorded
        assertEquals(InventoryVerdict.DUPLICATE, again.verdict)
        assertEquals("dev-1", again.winner?.deviceId)
        val wrongGtin = r.record("i1", raw("X", gtin = "04600682000013"), "op-1") as RecordOutcome.Recorded
        assertEquals(InventoryVerdict.INVALID, wrongGtin.verdict)
        assertEquals("wrong_gtin", wrongGtin.invalidReason)
        assertEquals(InventoryVerdict.INVALID, (r.record("i1", "garbage", "op-1") as RecordOutcome.Recorded).verdict)
        assertEquals(6, db.inventoryOutboxDao().count("i1"))
        assertEquals(listOf(1L, 2L, 3L, 4L, 5L, 6L), db.inventoryOutboxDao().head("i1", 10).map { it.deviceSequence })
        assertEquals(1, db.inventoryResultDao().observeCount("i1", "expected").first())
        assertEquals(3, db.inventoryResultDao().observeCountForDevice("i1", "dev-1").first())
    }

    @Test
    fun aDateMismatchHoldsTheScanUntilAcceptedOrTheDateChanges() = runTest {
        val r = recorder()
        r.record("i1", raw("A1"), "op-1")
        val held = r.record("i1", raw("A2"), "op-1")
        assertTrue(held is RecordOutcome.DateMismatch)
        assertEquals("2026-08-20", (held as RecordOutcome.DateMismatch).activeDate)
        assertEquals("2026-08-22", held.codeDate)
        assertEquals(1, db.inventoryOutboxDao().count("i1"))
        val accepted = r.record("i1", raw("A2"), "op-1", acceptMismatch = true) as RecordOutcome.Recorded
        assertEquals(InventoryVerdict.EXPECTED, accepted.verdict)
        assertEquals("2026-08-20", db.inventoryEventDao().get(accepted.eventId!!)?.activeProductionDate)
        r.setActiveDate("i1", "2026-08-22", "op-1")
        assertEquals("2026-08-22", r.activeDate("i1"))
    }

    @Test
    fun aBoxClaimsItsUnclaimedChildrenAndCountsThem() = runTest {
        val r = recorder()
        r.record("i1", raw("B1"), "op-1")
        val box = r.record("i1", "00$sscc", "op-1") as RecordOutcome.Recorded
        assertEquals(InventoryVerdict.EXPECTED, box.verdict)
        assertEquals("known_box", box.scanKind)
        assertEquals(1, box.claimedCount)
        assertEquals(2, box.boxChildCount)
        assertEquals("…0014", box.tail)
        val dup = r.record("i1", "00$sscc", "op-1") as RecordOutcome.Recorded
        assertEquals(InventoryVerdict.DUPLICATE, dup.verdict)
        val unknownBox = r.record("i1", "00346006820000000021", "op-1") as RecordOutcome.Recorded
        assertEquals(InventoryVerdict.UNKNOWN, unknownBox.verdict)
        assertEquals("old_box", unknownBox.scanKind)
        val event = db.inventoryEventDao().get(box.eventId!!)
        assertEquals("known_box:$sscc", event?.normalizedIdentity)
        assertEquals(sscc, event?.canonicalRaw)
        assertNull(event?.codeHash)
    }

    @Test
    fun theSameEventIdIsRecordedOnce() = runTest {
        val r = recorder()
        val first = r.record("i1", raw("A1"), "op-1", eventId = "e-1") as RecordOutcome.Recorded
        val replay = r.record("i1", raw("A1"), "op-1", eventId = "e-1") as RecordOutcome.Recorded
        assertEquals(first.verdict, replay.verdict)
        assertEquals(1, db.inventoryOutboxDao().count("i1"))
    }

    @Test
    fun eventJsonFollowsTheDomainKeyOrder() = runTest {
        val r = recorder()
        val out = r.record("i1", raw("A1"), "op-1", eventId = "e-1") as RecordOutcome.Recorded
        val json = db.inventoryOutboxDao().head("i1", 1).single().payloadJson
        assertEquals(
            """{"eventId":"e-1","deviceSequence":1,"operatorId":"op-1","scannedAt":"${out.scannedAt}","kind":"item",""" +
                """"normalizedIdentity":"item:${hash("A1")}","codeHash":"${hash("A1")}","canonicalRaw":"${raw("A1").replace(gs, "\\u001d")}",""" +
                """"activeProductionDate":"2026-08-20","localVerdict":"expected"}""",
            json,
        )
    }
}
