package app.markiro.handheld.feature.shift

import app.markiro.handheld.core.storage.initializeRecoveryForTest
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.storage.BoxEntity
import app.markiro.handheld.core.storage.CodeEntity
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.PalletEntity
import app.markiro.handheld.core.storage.ScanEventEntity
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ShiftCloserTest {
    private lateinit var db: HandheldDatabase

    @Before
    fun setUp() = runTest {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        db.deviceConfigDao().upsert(
            DeviceConfigEntity(
                deviceId = "dev-1", deviceName = "ТСД", tenantId = "t", organizationName = "ООО", lineId = "l1", lineName = "Линия 2",
                kind = "handheld", serverUrl = "http://x", pairedAt = 1L, activeShiftId = "s1",
            ),
        )
        db.shiftDao().upsert(ShiftEntityFixtures.bundled("s1").copy(plannedQty = 3))
        db.codeDao().insert(CodeEntity("h1", "s1", "04600682000013", "a", "2026-09-10T10:00:00.000Z"))
        db.codeDao().insert(CodeEntity("h2", "s1", "04600682000013", "b", "2026-09-10T10:01:00.000Z"))
        db.scanEventDao().insert(ScanEventEntity(shiftId = "s1", raw = "x", verdict = "invalid", scannedAt = "t", operatorId = null, codeHash = null))
        db.initializeRecoveryForTest()
    }

    @After
    fun tearDown() = db.close()

    private fun box(id: String, closedAt: String?) = BoxEntity(
        boxId = id, shiftId = "s1", sscc = if (closedAt == null) null else "04680089900000001$id".takeLast(18),
        openedAt = "2026-09-10T10:00:00.000Z", closedAt = closedAt, operatorId = "op-1",
        printState = "printed", printReason = null, ackedAt = null,
    )

    private fun pallet(id: String, closedAt: String?) = PalletEntity(
        palletId = id, shiftId = "s1", terminalId = "dev-1", sscc = if (closedAt == null) null else "146800899000000015",
        openedAt = "2026-09-10T10:00:00.000Z", closedAt = closedAt, operatorId = "op-1",
        printState = "printed", printReason = null, ackedAt = null,
    )

    @Test
    fun previewCountsAndRequiresAReasonWhenThePlanIsMissed() = runTest {
        val p = ShiftCloser(db).preview("s1")!!
        assertEquals(2, p.accepted)
        assertEquals(1, p.errors)
        assertEquals(3, p.plan)
        assertTrue(p.reasonRequired)
        db.shiftDao().upsert(ShiftEntityFixtures.bundled("s1").copy(plannedQty = null))
        assertFalse(ShiftCloser(db).preview("s1")!!.reasonRequired)
    }

    @Test
    fun closeWritesOnePendingRowClosesLocallyAndClearsTheActiveShift() = runTest {
        val closer = ShiftCloser(db) { 1_757_500_000_000L }
        val row = closer.close("s1", "op-1", "material_shortage")
        assertEquals("pending", row.state)
        assertEquals(3, row.plannedQtySnapshot)
        assertEquals(2, row.actualQty)
        assertEquals("material_shortage", row.reasonCode)
        assertEquals("closed", db.shiftDao().get("s1")?.status)
        assertNull(db.deviceConfigDao().get()?.activeShiftId)
        val again = closer.close("s1", "op-1", "equipment_stop")
        assertEquals(row.eventId, again.eventId)
    }

    /**
     * The count that rides `/station/shift-closures` into
     * `station_shift_close_events.closed_box_count`. It was hardcoded to 0, so
     * every shift a handheld closed recorded a false number rather than an
     * absent one -- invisible because nothing reads that column yet.
     *
     * The open box is the load-bearing part of the fixture: counting rows
     * instead of CLOSED rows would pass an assertion of 2 against two boxes,
     * so there have to be three.
     */
    @Test
    fun closeRecordsTheBoxesItActuallyClosedRatherThanZero() = runTest {
        db.boxDao().insert(box("b1", closedAt = "2026-09-10T10:30:00.000Z"))
        db.boxDao().insert(box("b2", closedAt = "2026-09-10T10:40:00.000Z"))
        db.boxDao().insert(box("b3", closedAt = null))

        val row = ShiftCloser(db) { 1_757_500_000_000L }.close("s1", "op-1", "material_shortage")

        assertEquals(2, row.closedBoxCount)
    }

    /**
     * A box taken apart after it was closed still counts: this is "how many
     * boxes did this shift close", a production fact a later event does not
     * undo, and it is the same rule the station applies to the same field. The
     * contrast is deliberate -- `PalletDao.boxCount` DOES exclude a disassembled
     * box, because it answers what is physically on a stack right now.
     */
    @Test
    fun aDisassembledBoxStillCountsAsClosed() = runTest {
        db.boxDao().insert(box("b1", closedAt = "2026-09-10T10:30:00.000Z"))
        db.boxDao().insert(
            box("b2", closedAt = "2026-09-10T10:40:00.000Z").copy(disassembledAt = "2026-09-10T11:00:00.000Z"),
        )

        val row = ShiftCloser(db) { 1_757_500_000_000L }.close("s1", "op-1", "material_shortage")

        assertEquals(2, row.closedBoxCount)
    }

    /**
     * Design brief 10 §9 puts boxes and pallets in the close summary. They are
     * absent, not zero, when the shift has none: «Паллеты 0» on every validation
     * close is noise, and zero has to stay meaningful for the aggregation shift
     * that really closed nothing.
     */
    @Test
    fun previewCountsBoxesAndPalletsOnlyForAShiftThatHasThem() = runTest {
        db.boxDao().insert(box("b1", closedAt = "2026-09-10T10:30:00.000Z"))
        db.palletDao().insert(pallet("p1", closedAt = "2026-09-10T10:45:00.000Z"))
        db.palletDao().insert(pallet("p2", closedAt = null))

        val validation = ShiftCloser(db).preview("s1")!!
        assertNull(validation.closedBoxes)
        assertNull(validation.closedPallets)

        db.shiftDao().upsert(ShiftEntityFixtures.bundled("s1").copy(plannedQty = 3, mode = "aggregation"))
        val boxesOnly = ShiftCloser(db).preview("s1")!!
        assertEquals(1, boxesOnly.closedBoxes)
        assertNull(boxesOnly.closedPallets)

        db.shiftDao().upsert(
            ShiftEntityFixtures.bundled("s1").copy(plannedQty = 3, mode = "aggregation", palletsEnabled = true),
        )
        val withPallets = ShiftCloser(db).preview("s1")!!
        assertEquals(1, withPallets.closedBoxes)
        assertEquals(1, withPallets.closedPallets)
    }

    @Test
    fun closeRefusesAMissingReasonWhenRequired() = runTest {
        val result = runCatching { ShiftCloser(db).close("s1", null, null) }
        assertTrue(result.exceptionOrNull() is IllegalArgumentException)
        assertNull(db.shiftCloseDao().forShift("s1"))
        assertEquals("active", db.shiftDao().get("s1")?.status)
    }

    /**
     * Closing never waits on a printer: an unresolved duplicate survives as a
     * record and its events still sync, but its bytes go, because that is what
     * bounds the disk.
     */
    @Test
    fun closingDropsTheDuplicateBytesAndKeepsAnUnresolvedJob() = runTest {
        db.productLabelJobDao().insert(
            app.markiro.handheld.core.storage.ProductLabelJobEntity(
                jobId = "j1", shiftId = "s1", codeHash = "c".repeat(64), canonicalRaw = "raw",
                acceptedAt = "2026-09-11T08:00:00.000Z", operatorId = "op-1", policyRevision = "rev",
                templateDigest = "a".repeat(64), payloadDigest = "p".repeat(64), bytesBase64 = "AAEC",
                bytesDigest = "b".repeat(64), language = "zpl", dpi = 203, latestSequence = 1,
                attemptId = "att", attemptNo = 1, attemptState = "delivery_unknown", verification = "none",
                verificationOutcome = "not_required", status = "attention", lastFailure = null,
            ),
        )
        db.productLabelEventDao().insert(
            app.markiro.handheld.core.storage.ProductLabelEventEntity(
                eventId = "e1", jobId = "j1", sequence = 1, kind = "prepared", payloadJson = "{}",
                occurredAt = "2026-09-11T08:00:00.000Z", ackedAt = null, quarantineCode = null,
            ),
        )

        // Under plan, so a reason is required; the retention rule is the same either way.
        ShiftCloser(db) { 1_757_500_000_000L }.close("s1", "op-1", "production_defect")

        val job = checkNotNull(db.productLabelJobDao().get("j1"))
        assertNull(job.bytesBase64)
        // The digest survives, so the queued event still describes what printed.
        assertEquals("b".repeat(64), job.bytesDigest)
        assertEquals(listOf("e1"), db.productLabelEventDao().unacked(10).map { it.eventId })
    }
}
