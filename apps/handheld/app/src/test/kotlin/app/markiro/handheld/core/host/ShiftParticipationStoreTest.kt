package app.markiro.handheld.core.host

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.network.host.DeviceShiftDto
import app.markiro.handheld.core.network.host.DeviceShiftsDto
import app.markiro.handheld.core.network.host.ShiftParticipantDto
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
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
class ShiftParticipationStoreTest {
    private lateinit var db: HandheldDatabase
    private val json = Json { ignoreUnknownKeys = true }
    /** The first participant of the host's fixture: the device that reads the fixture as its own (`myState` is `active`). */
    private val me = "7c9e6679-7425-40de-944b-e07fc1f90ae7"
    private val shiftId = "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b"
    /** The fixture's second shift: closed, listed without totals or byDevice. */
    private val closedShiftId = "6d2c9b1e-3a4f-4e5d-8b7a-9c0d1e2f3a4b"
    private var now = 1_760_000_000_000L

    @Before
    fun open() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java).allowMainThreadQueries().build()
        db.initializeRecoveryForTest()
    }

    @After
    fun close() = db.close()

    private fun store() = ShiftParticipationStore(db, myDeviceId = { me }, clock = { now })

    private fun shifts(file: String = "device-shifts-participants.json"): List<DeviceShiftDto> =
        json.decodeFromString(
            DeviceShiftsDto.serializer(),
            checkNotNull(javaClass.classLoader?.getResource(file)) { "$file is not in the test resources" }.readText(),
        ).shifts

    private fun part(id: String, state: String) = ShiftParticipantDto(deviceId = id, deviceKind = "station", deviceName = "n", state = state)

    @Test
    fun aSharedShiftIsKeptWithTheFiguresTheStripAndTheCloseNeed() = runTest {
        store().save(shifts())
        val p = checkNotNull(store().get(shiftId))
        assertEquals(2, p.maxStations)
        assertEquals("active", p.myState)
        assertEquals(2, p.participantsEver)
        assertEquals(1, p.active)
        // The other participant closed its part: nobody else keeps the shift open.
        assertEquals(0, p.othersOpen)
        assertEquals(547L, p.accepted)
        assertEquals(427L, p.myAccepted)
        assertEquals(45, p.boxesClosed)
        assertEquals("2026-10-08T09:41:07Z", p.asOf)
        assertEquals(now, p.fetchedAt)
        assertFalse(p.stale)
        // This device's own leave token, from its participant row.
        assertEquals(12L, p.joinedRev)
        // The fixture's closed shift comes without figures and nothing was stored for it: nothing is made.
        assertNull(store().get(closedShiftId))
    }

    @Test
    fun aClosedShiftListedWithoutFiguresKeepsTheStoredOnesAndTakesItsParticipantsAndState() = runTest {
        store().save(shifts())
        val fetched = now
        now += 60_000
        val active = shifts().first { it.status == "active" }
        // The host's list now names the same shift closed, without totals, byDevice or this device's token.
        store().save(
            listOf(
                active.copy(
                    status = "closed",
                    myState = "closed",
                    participants = listOf(part(me, "closed"), part("9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d", "closed")),
                    totals = null,
                    byDevice = null,
                ),
            ),
        )
        val p = checkNotNull(store().get(shiftId))
        assertEquals("closed", p.myState)
        assertEquals(0, p.othersOpen)
        assertEquals(547L, p.accepted)
        assertEquals(427L, p.myAccepted)
        assertEquals(45, p.boxesClosed)
        assertEquals("2026-10-08T09:41:07Z", p.asOf)
        // The figures are as old as the answer that had them.
        assertEquals(fetched, p.fetchedAt)
        assertEquals(12L, p.joinedRev)
    }

    @Test
    fun othersOpenCountsTheActiveAndLeftParticipantsOtherThanThisDevice() = runTest {
        val base = shifts().first { it.status == "active" }
        store().save(base.copy(participants = listOf(part(me, "active"), part("x", "left"), part("y", "closed"))))
        assertEquals(1, store().get(shiftId)!!.othersOpen)
        store().save(base.copy(participants = listOf(part(me, "active"), part("x", "left"), part("z", "active"))))
        assertEquals(2, store().get(shiftId)!!.othersOpen)
        assertEquals(2, store().get(shiftId)!!.active)
    }

    @Test
    fun aShiftTheHostNoLongerListsLosesItsFigures() = runTest {
        store().save(shifts())
        assertNotNull(store().get(shiftId))
        store().save(emptyList())
        assertNull(store().get(shiftId))
    }

    @Test
    fun aListOfAnOlderHostStoresNothing() = runTest {
        store().save(shifts("device-shifts.json"))
        assertTrue(db.metaDao().withPrefix(ShiftParticipationStore.PREFIX).isEmpty())
    }

    @Test
    fun anUnreachableHostMarksTheFiguresStaleUntilTheNextAnswer() = runTest {
        store().save(shifts())
        store().markStale(shiftId)
        assertTrue(store().get(shiftId)!!.stale)
        // Nothing is invented for a shift that has no figures.
        store().markStale("no-such-shift")
        assertNull(store().get("no-such-shift"))
        now += 15_000
        store().save(shifts())
        val p = store().get(shiftId)!!
        assertFalse(p.stale)
        assertEquals(now, p.fetchedAt)
    }

    @Test
    fun anOwedLeaveIsRememberedUntilItIsCleared() = runTest {
        assertEquals(emptyList<String>(), store().pendingLeaves())
        store().markLeavePending(shiftId)
        store().markLeavePending("other")
        assertEquals(setOf(shiftId, "other"), store().pendingLeaves().toSet())
        // Only the pause that was sent is settled: another marker (a pause asked again meanwhile) leaves it owed.
        store().clearLeavePending(shiftId, "not-the-marker")
        assertEquals(setOf(shiftId, "other"), store().pendingLeaves().toSet())
        store().clearLeavePending(shiftId, now.toString())
        assertEquals(listOf("other"), store().pendingLeaves())
    }

    @Test
    fun aPauseAskedAgainWritesALaterMarkerEvenWithinOneTick() = runTest {
        store().markLeavePending(shiftId)
        val first = db.metaDao().get(ShiftParticipationStore.leaveKey(shiftId))!!.toLong()
        store().markLeavePending(shiftId)
        val second = db.metaDao().get(ShiftParticipationStore.leaveKey(shiftId))!!.toLong()
        assertTrue("$second must be after $first", second > first)
        // A clock set back never writes an earlier marker either.
        now -= 10_000
        store().markLeavePending(shiftId)
        assertTrue(db.metaDao().get(ShiftParticipationStore.leaveKey(shiftId))!!.toLong() > second)
    }

    @Test
    fun aCloseNoteIsKeptPerShift() = runTest {
        assertNull(store().closeNote(shiftId))
        store().noteClose(shiftId, ShiftParticipationStore.NOTE_PART_CLOSED)
        assertEquals("part_closed", store().closeNote(shiftId))
        assertNull(store().closeNote("other"))
    }

    @Test
    fun aDamagedValueReadsAsNoFiguresNotACrash() = runTest {
        db.recovery.commit { db.metaDao().put(app.markiro.handheld.core.storage.MetaEntity(ShiftParticipationStore.key(shiftId), "{not json")) }
        assertNull(store().get(shiftId))
    }

    private fun withAsOf(shift: DeviceShiftDto, asOf: String, accepted: Long) =
        shift.copy(totals = shift.totals!!.copy(accepted = accepted, asOf = asOf))

    @Test
    fun aReadOlderThanTheStoredOneNeverTakesTheFiguresBack() = runTest {
        val base = shifts().first { it.status == "active" }
        store().save(withAsOf(base, "2026-10-08T09:41:07Z", 547))
        now += 5_000
        store().save(listOf(withAsOf(base, "2026-10-08T09:40:00Z", 500)))
        val p = store().get(shiftId)!!
        assertEquals(547L, p.accepted)
        assertEquals("2026-10-08T09:41:07Z", p.asOf)
        now += 5_000
        store().save(withAsOf(base, "2026-10-08T09:42:00Z", 560))
        assertEquals(560L, store().get(shiftId)!!.accepted)
    }

    @Test
    fun anOlderReadIsTakenWhenTheStoredOneWasSeenMoreThanAMinuteBefore() = runTest {
        val base = shifts().first { it.status == "active" }
        store().save(withAsOf(base, "2026-10-08T09:41:07Z", 547))
        now += 60_000
        // A host clock set back must not freeze the figures.
        store().save(listOf(withAsOf(base, "2026-10-08T09:00:00Z", 100)))
        val p = store().get(shiftId)!!
        assertEquals(100L, p.accepted)
        assertEquals(now, p.fetchedAt)
    }

    @Test
    fun aSkippedStaleReadKeepsTheStoredLeaveToken() = runTest {
        val base = shifts().first { it.status == "active" }
        store().save(withAsOf(base, "2026-10-08T09:41:07Z", 547))
        now += 1_000
        val reentered = base.copy(
            participants = base.participants!!.map { if (it.deviceId == me) it.copy(joinedRev = 99L) else it },
            totals = base.totals!!.copy(asOf = "2026-10-08T09:30:00Z"),
        )
        store().save(listOf(reentered))
        assertEquals(12L, store().get(shiftId)!!.joinedRev)
    }

    @Test
    fun aCloseNoteOfAShiftTheHostNoLongerListsIsForgottenButAnOwedLeaveIsNot() = runTest {
        store().save(shifts())
        store().noteClose(shiftId, ShiftParticipationStore.NOTE_REASON_MISSING)
        store().noteClose("gone", ShiftParticipationStore.NOTE_PART_CLOSED)
        store().markLeavePending("gone")
        store().save(shifts())
        assertEquals("reason_missing", store().closeNote(shiftId))
        assertNull(store().closeNote("gone"))
        assertEquals(listOf("gone"), store().pendingLeaves())
    }

    @Test
    fun anOlderReadIsRefusedUpToAMinuteAndTakenFromThere() = runTest {
        val base = shifts().first { it.status == "active" }
        val seen = now
        store().save(withAsOf(base, "2026-10-08T09:41:07Z", 547))
        // 59.999 s after the stored read was seen: still refused (a 30 s window would take it).
        now = seen + 59_999
        store().save(listOf(withAsOf(base, "2026-10-08T09:00:00Z", 100)))
        assertEquals(547L, store().get(shiftId)!!.accepted)
        assertEquals(seen, store().get(shiftId)!!.fetchedAt)
        // 60 s: taken.
        now = seen + 60_000
        store().save(listOf(withAsOf(base, "2026-10-08T09:00:00Z", 100)))
        assertEquals(100L, store().get(shiftId)!!.accepted)
        assertEquals(seen + 60_000, store().get(shiftId)!!.fetchedAt)
        // And 60.001 s after that read: taken as well.
        now += 60_001
        store().save(listOf(withAsOf(base, "2026-10-08T08:00:00Z", 50)))
        assertEquals(50L, store().get(shiftId)!!.accepted)
    }

    @Test
    fun aReadWithoutAnAsOfChangesNothingWithinTheMinuteAsTheStationsNullCompareDoes() = runTest {
        val base = shifts().first { it.status == "active" }.copy(totals = null, byDevice = null)
        val seen = now
        store().save(listOf(base.copy(participants = listOf(part(me, "active")))))
        assertNull(store().get(shiftId)!!.asOf)
        assertEquals(1, store().get(shiftId)!!.participantsEver)
        now = seen + 59_999
        store().save(listOf(base.copy(participants = listOf(part(me, "active"), part("x", "active")))))
        assertEquals(1, store().get(shiftId)!!.participantsEver)
        now = seen + 60_000
        store().save(listOf(base.copy(participants = listOf(part(me, "active"), part("x", "active")))))
        assertEquals(2, store().get(shiftId)!!.participantsEver)
    }

    @Test
    fun anActiveShiftListedWithoutFiguresKeepsTheStoredOnesLikeAnyRowThatLacksThem() = runTest {
        store().save(shifts())
        val fetched = now
        now += 20_000
        val active = shifts().first { it.status == "active" }
        // Not closed, no totals and no byDevice (the station's COALESCE keeps them for any row that lacks them): the participants are new.
        store().save(listOf(active.copy(totals = null, byDevice = null, participants = listOf(part(me, "active"), part("x", "active"), part("y", "active")))))
        val p = checkNotNull(store().get(shiftId))
        assertEquals(3, p.participantsEver)
        assertEquals(547L, p.accepted)
        assertEquals(427L, p.myAccepted)
        assertEquals(45, p.boxesClosed)
        assertEquals("2026-10-08T09:41:07Z", p.asOf)
        assertEquals(fetched, p.fetchedAt)
    }

    @Test
    fun aReadWithTotalsButNoPerDeviceRowsKeepsTheStoredShareOfThisDevice() = runTest {
        store().save(shifts())
        now += 20_000
        val active = shifts().first { it.status == "active" }
        store().save(listOf(active.copy(byDevice = null, totals = active.totals!!.copy(accepted = 560, asOf = "2026-10-08T09:42:00Z"))))
        val p = checkNotNull(store().get(shiftId))
        assertEquals(560L, p.accepted)
        assertEquals(427L, p.myAccepted)
    }

    private val at = "2026-10-08T09:40:00.000Z"

    /** A code this device scanned in the fixture's shared shift; [pending]: its scan still waits for the host's receipt (an `outbox` row, frozen and queued). */
    private suspend fun scanned(hash: String, pending: Boolean = false, quarantined: Boolean = false) {
        db.codeDao().insert(app.markiro.handheld.core.storage.CodeEntity(hash, shiftId, "04600682000013", hash, at))
        if (!pending && !quarantined) return
        val id = db.outboxDao().insert(
            app.markiro.handheld.core.storage.OutboxEntity(
                shiftId = shiftId, raw = hash, verdict = "ok", scannedAt = at, operatorId = null, codeHash = hash, gtin14 = "04600682000013", serial = hash,
            ),
        )
        db.hostOutboxDao().insert(
            app.markiro.handheld.core.storage.HostOutboxEntity(
                recordId = "rec-$hash", target = "facts", kind = "scan", sourceKind = "scan", sourceKey = id.toString(), body = "{}",
                state = if (quarantined) "quarantined" else "queued", reason = if (quarantined) "validation_failed" else null, createdAt = at,
            ),
        )
    }

    private fun answer(accepted: Long, mine: Long, asOf: String = "2026-10-08T09:41:07Z"): DeviceShiftDto {
        val active = shifts().first { it.status == "active" }
        return active.copy(
            totals = active.totals!!.copy(accepted = accepted, asOf = asOf),
            byDevice = active.byDevice!!.map { if (it.deviceId == me) it.copy(accepted = mine) else it },
        )
    }

    /**
     * PR #775 (Codex P2): the host took this device's scan of X (acknowledged: the outbox row is gone), then an earlier offline scan of X from another
     * device displaced it. The host's read credits this device with nothing: the acknowledged code it no longer credits is kept as `displaced`, so
     * the shift-wide total counts X once.
     */
    @Test
    fun anAcknowledgedCodeTheHostNoLongerCreditsIsKeptAsDisplaced() = runTest {
        scanned("x")
        store().save(listOf(answer(accepted = 1, mine = 0)))
        val p = checkNotNull(store().get(shiftId))
        assertEquals(1, p.displaced)
        val local = db.codeDao().countForShift(shiftId)
        assertEquals(1, app.markiro.handheld.feature.shift.SharedShiftRules.shiftTotal(p, local, db.codeDao().lostForShift(shiftId)))
        // The host credits it again (or never displaced it): nothing displaced.
        now += 15_000
        store().save(listOf(answer(accepted = 1, mine = 1, asOf = "2026-10-08T09:41:22Z")))
        assertEquals(0, store().get(shiftId)!!.displaced)
    }

    @Test
    fun aScanStillWaitingForItsReceiptIsNotMistakenForADisplacedOne() = runTest {
        // X was displaced; Y, scanned later, is not acknowledged yet, so the host cannot credit it; Z was refused (quarantined: `lost`).
        scanned("x")
        scanned("y", pending = true)
        scanned("z", quarantined = true)
        store().save(listOf(answer(accepted = 1, mine = 0)))
        val p = checkNotNull(store().get(shiftId))
        assertEquals(1, p.displaced)
        val local = db.codeDao().countForShift(shiftId)
        // X once (the other device's), Y once (this device's, pending), Z nobody's.
        assertEquals(2, app.markiro.handheld.feature.shift.SharedShiftRules.shiftTotal(p, local, db.codeDao().lostForShift(shiftId)))
    }

    @Test
    fun aReadWithoutPerDeviceRowsOrTotalsKeepsTheStoredDisplacedCount() = runTest {
        scanned("x")
        store().save(listOf(answer(accepted = 1, mine = 0)))
        now += 20_000
        val active = answer(accepted = 1, mine = 0)
        // The host's share of this device did not change, so neither did what it no longer credits.
        store().save(listOf(active.copy(byDevice = null, totals = active.totals!!.copy(asOf = "2026-10-08T09:42:00Z"))))
        assertEquals(1, store().get(shiftId)!!.displaced)
        store().save(listOf(active.copy(status = "closed", myState = "closed", totals = null, byDevice = null)))
        assertEquals(1, store().get(shiftId)!!.displaced)
    }

    @Test
    fun aHostThatCreditsMoreThanTheAcknowledgedCodesDisplacesNothing() = runTest {
        // A receipt lost on the way: the host holds the scan, the device still waits for the receipt. Never a negative correction.
        scanned("x", pending = true)
        store().save(listOf(answer(accepted = 1, mine = 1)))
        assertEquals(0, store().get(shiftId)!!.displaced)
    }

    @Test
    fun aDatabaseReopenedFromItsFileStillOwesTheLeave() = runTest {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val name = "owed-leave-reopen.db"
        context.deleteDatabase(name)
        var file = Room.databaseBuilder(context, HandheldDatabase::class.java, name).allowMainThreadQueries().build()
        try {
            file.initializeRecoveryForTest()
            ShiftParticipationStore(file, myDeviceId = { me }, clock = { now }).markLeavePending(shiftId)
            file.close()
            // The process died: nothing but the file is left.
            file = Room.databaseBuilder(context, HandheldDatabase::class.java, name).allowMainThreadQueries().build()
            file.initializeRecoveryForTest()
            assertEquals(listOf(shiftId), ShiftParticipationStore(file, myDeviceId = { me }, clock = { now }).pendingLeaves())
        } finally {
            file.close()
            context.deleteDatabase(name)
        }
    }
}
