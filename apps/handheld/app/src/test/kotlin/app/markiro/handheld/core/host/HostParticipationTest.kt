package app.markiro.handheld.core.host

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.network.host.HostApi
import app.markiro.handheld.core.network.host.HostResult
import app.markiro.handheld.core.network.host.HostTransport
import app.markiro.handheld.core.network.host.TransportFailure
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
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
class HostParticipationTest {
    private lateinit var db: HandheldDatabase
    private val shift = HostFactsFixtures.SHIFT
    private val me = "00000000-0000-4000-8000-000000000001"
    private val listPath = "/v1/device/shifts"
    private val leavePath = "/v1/device/shifts/$shift/leave"

    /** Exact paths, answers in order; a path with nothing scripted fails the test. */
    private class Exact(val answers: MutableMap<String, ArrayDeque<HostResult>>) : HostTransport {
        val requests = mutableListOf<String>()
        val bodies = mutableListOf<String>()
        /** Runs while a POST is in flight, before the host answers: what the operator does on the device meanwhile. */
        var during: (suspend () -> Unit)? = null
        override suspend fun get(path: String): HostResult = next("GET", path)
        override suspend fun post(path: String, body: String): HostResult {
            bodies += body
            during?.invoke()
            return next("POST", path)
        }
        private fun next(method: String, path: String): HostResult {
            requests += "$method $path"
            return (answers[path] ?: error("nothing scripted for $method $path")).removeFirst()
        }
    }

    @Before
    fun open() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java).allowMainThreadQueries().build()
        kotlinx.coroutines.runBlocking { db.deviceConfigDao().upsert(HostFactsFixtures.config(db).copy(activeShiftId = shift)) }
        db.initializeRecoveryForTest()
    }

    @After
    fun close() = db.close()

    private fun fixture(name: String) = checkNotNull(javaClass.classLoader?.getResource(name)) { name }.readText()
    private fun ok(body: String) = HostResult.Ok(200, body, null)
    private fun listBody() = fixture("device-shifts-participants.json")
    private fun oneShift() = Json.parseToJsonElement(listBody()).jsonObject.getValue("shifts").jsonArray[0].toString()
    private var clock = 1_000L
    private fun store() = ShiftParticipationStore(db, myDeviceId = { me }, clock = { clock })

    private fun participation(transport: Exact) =
        HostParticipation(db, { HostApi(transport) }, HostCalls { }, store(), db.deviceConfigDao())

    @Test
    fun aBeatWhileAShiftIsWorkedReadsTheListAndKeepsItsFigures() = runTest {
        val transport = Exact(mutableMapOf(listPath to ArrayDeque(listOf(ok(listBody())))))
        participation(transport).beat()
        assertEquals(listOf("GET $listPath"), transport.requests)
        assertEquals(547L, store().get(shift)!!.accepted)
    }

    @Test
    fun aBeatWithNoShiftBeingWorkedAsksNothing() = runTest {
        db.deviceConfigDao().get()!!.let { db.deviceConfigDao().upsert(it.copy(activeShiftId = null)) }
        val transport = Exact(mutableMapOf())
        participation(transport).beat()
        assertEquals(emptyList<String>(), transport.requests)
    }

    @Test
    fun aCloudDeviceIsNeverAskedAnything() = runTest {
        db.deviceConfigDao().get()!!.let { db.deviceConfigDao().upsert(it.copy(backend = "cloud")) }
        val transport = Exact(mutableMapOf())
        val p = participation(transport)
        p.beat()
        assertFalse(p.refresh())
        assertEquals(emptyList<String>(), transport.requests)
    }

    @Test
    fun aHostThatDoesNotAnswerMarksTheWorkedShiftsFiguresStale() = runTest {
        store().save(Json { ignoreUnknownKeys = true }.decodeFromString(app.markiro.handheld.core.network.host.DeviceShiftsDto.serializer(), listBody()).shifts)
        val transport = Exact(mutableMapOf(listPath to ArrayDeque(listOf(HostResult.Failed(TransportFailure.UNREACHABLE)))))
        val p = participation(transport)
        assertFalse(p.refresh())
        assertTrue(store().get(shift)!!.stale)
        // The next answer clears it.
        transport.answers[listPath] = ArrayDeque(listOf(ok(listBody())))
        assertTrue(p.refresh())
        assertFalse(store().get(shift)!!.stale)
    }

    @Test
    fun markStaleIsWhatABeatThatNeverReachedTheHostDoes() = runTest {
        store().save(Json { ignoreUnknownKeys = true }.decodeFromString(app.markiro.handheld.core.network.host.DeviceShiftsDto.serializer(), listBody()).shifts)
        participation(Exact(mutableMapOf())).markStale()
        assertTrue(store().get(shift)!!.stale)
    }

    @Test
    fun anOwedLeaveIsSentWhileTheDeviceIsStillOutAndThenForgotten() = runTest {
        db.shiftDao().upsert(HostFactsFixtures.shift().copy(leftAt = 5L))
        store().markLeavePending(shift)
        val transport = Exact(mutableMapOf(leavePath to ArrayDeque(listOf(ok(oneShift()))), listPath to ArrayDeque(listOf(ok(listBody())))))
        participation(transport).beat()
        assertEquals(listOf("POST $leavePath", "GET $listPath"), transport.requests)
        assertEquals(emptyList<String>(), store().pendingLeaves())
        assertNotNull(store().get(shift))
    }

    @Test
    fun anOwedLeaveCarriesTheStoredTokenAndAnAnswerStillActiveSettlesItAsAlreadyReEntered() = runTest {
        db.shiftDao().upsert(HostFactsFixtures.shift().copy(leftAt = 5L))
        store().markLeavePending(shift)
        // The participation of this shift as an earlier answer left it: this device's token 7.
        db.recovery.commit {
            db.metaDao().put(
                app.markiro.handheld.core.storage.MetaEntity(
                    ShiftParticipationStore.key(shift),
                    """{"shiftId":"$shift","myState":"left","fetchedAt":1,"joinedRev":7}""",
                ),
            )
        }
        val transport = Exact(mutableMapOf(leavePath to ArrayDeque(listOf(ok(oneShift()))), listPath to ArrayDeque(listOf(ok(listBody())))))
        participation(transport).beat()
        assertEquals(listOf("""{"joinedRev":7}"""), transport.bodies)
        // The host answered the part still active (its token moved on): nothing is owed any more.
        assertEquals(emptyList<String>(), store().pendingLeaves())
    }

    @Test
    fun anOwedLeaveOfAShiftTheDeviceEnteredAgainIsDroppedNotSent() = runTest {
        db.shiftDao().upsert(HostFactsFixtures.shift().copy(leftAt = null))
        store().markLeavePending(shift)
        val transport = Exact(mutableMapOf(listPath to ArrayDeque(listOf(ok(listBody())))))
        participation(transport).beat()
        assertEquals(listOf("GET $listPath"), transport.requests)
        assertEquals(emptyList<String>(), store().pendingLeaves())
    }

    @Test
    fun anOwedLeaveStaysOwedWhileTheHostIsNotReachedAndIsDroppedWhenTheHostHoldsNoSlot() = runTest {
        db.shiftDao().upsert(HostFactsFixtures.shift().copy(leftAt = 5L))
        store().markLeavePending(shift)
        val down = Exact(mutableMapOf(leavePath to ArrayDeque(listOf(HostResult.Failed(TransportFailure.TIMEOUT))), listPath to ArrayDeque(listOf(HostResult.Failed(TransportFailure.TIMEOUT)))))
        participation(down).beat()
        assertEquals(listOf(shift), store().pendingLeaves())
        val refused = HostResult.Ok(409, """{"error":{"code":"conflict","message":"m","details":{"constraint":"shift_not_entered"}}}""", null)
        val held = Exact(mutableMapOf(leavePath to ArrayDeque(listOf(refused)), listPath to ArrayDeque(listOf(ok(listBody())))))
        participation(held).beat()
        assertEquals(emptyList<String>(), store().pendingLeaves())
        assertNull(db.metaDao().get(ShiftParticipationStore.leaveKey(shift)))
    }

    private val other = "11111111-1111-4111-8111-111111111111"
    private val otherLeavePath = "/v1/device/shifts/$other/leave"
    private fun refusal(status: Int, body: String) = HostResult.Ok(status, body, null)
    private fun envelope(code: String, constraint: String? = null) =
        """{"error":{"code":"$code","message":"m"${constraint?.let { ""","details":{"constraint":"$it"}""" } ?: ""}}}"""

    /** The host's list with this device's own part of the worked shift in [state]. */
    private fun listWithMyState(state: String): String {
        val root = Json.parseToJsonElement(listBody()).jsonObject
        val shifts = root.getValue("shifts").jsonArray.mapIndexed { i, s ->
            if (i == 0) kotlinx.serialization.json.JsonObject(s.jsonObject + ("myState" to kotlinx.serialization.json.JsonPrimitive(state))) else s
        }
        return kotlinx.serialization.json.JsonObject(root + ("shifts" to kotlinx.serialization.json.JsonArray(shifts))).toString()
    }

    private suspend fun owe(id: String) {
        db.shiftDao().upsert(HostFactsFixtures.shift(id).copy(leftAt = 5L))
        store().markLeavePending(id)
    }

    @Test
    fun oneLeaveTheHostKeepsFailingDoesNotStopTheOthersFromBeingSent() = runTest {
        owe(shift)
        owe(other)
        val transport = Exact(
            mutableMapOf(
                leavePath to ArrayDeque(listOf(refusal(500, envelope("internal")))),
                otherLeavePath to ArrayDeque(listOf(ok(oneShift()))),
                listPath to ArrayDeque(listOf(ok(listBody()))),
            ),
        )
        participation(transport).beat()
        assertEquals(setOf("POST $leavePath", "POST $otherLeavePath"), transport.requests.filter { it.startsWith("POST") }.toSet())
        // The failing one stays owed (it could still succeed); the sent one is forgotten.
        assertEquals(listOf(shift), store().pendingLeaves())
    }

    @Test
    fun aHostThatCannotBeReachedEndsTheSendingPassButLosesNoLeave() = runTest {
        owe(shift)
        owe(other)
        val first = store().pendingLeaves().first()
        val transport = Exact(
            mutableMapOf(
                "/v1/device/shifts/$first/leave" to ArrayDeque(listOf(HostResult.Failed(TransportFailure.TIMEOUT))),
                listPath to ArrayDeque(listOf(HostResult.Failed(TransportFailure.TIMEOUT))),
            ),
        )
        participation(transport).beat()
        // The second leave was not tried (a script for it would have been missing): the host is down, nothing is settled.
        assertEquals(setOf(shift, other), store().pendingLeaves().toSet())
    }

    @Test
    fun onlyTheHostsDefinitePerShiftRefusalsSettleALeave() = runTest {
        val settles = listOf(
            refusal(404, envelope("not_found")),
            refusal(400, envelope("validation_failed")),
            refusal(409, envelope("conflict", "shift_not_entered")),
        )
        for (answer in settles) {
            owe(shift)
            participation(Exact(mutableMapOf(leavePath to ArrayDeque(listOf(answer)), listPath to ArrayDeque(listOf(ok(listBody())))))).beat()
            assertEquals(answer.toString(), emptyList<String>(), store().pendingLeaves())
        }
        val keeps = listOf(
            refusal(403, envelope("forbidden")),
            refusal(401, envelope("unauthorized")),
            refusal(409, envelope("conflict", "license_restricted")),
            refusal(409, envelope("conflict", "shift_status")),
            refusal(404, "<html>not the host</html>"),
            refusal(502, "bad gateway"),
            refusal(503, envelope("restore_pending")),
            HostResult.Failed(TransportFailure.CERT_MISMATCH),
        )
        for (answer in keeps) {
            owe(shift)
            participation(Exact(mutableMapOf(leavePath to ArrayDeque(listOf(answer)), listPath to ArrayDeque(listOf(ok(listBody())))))).beat()
            assertEquals(answer.toString(), listOf(shift), store().pendingLeaves())
            db.recovery.commit { db.metaDao().remove(ShiftParticipationStore.leaveKey(shift)) }
        }
    }

    @Test
    fun aPartTheHostHasAsLeftWhileThisDeviceWorksTheShiftIsEnteredAgain() = runTest {
        db.shiftDao().upsert(HostFactsFixtures.shift().copy(leftAt = null))
        val enterPath = "/v1/device/shifts/$shift/enter"
        val transport = Exact(mutableMapOf(listPath to ArrayDeque(listOf(ok(listWithMyState("left")))), enterPath to ArrayDeque(listOf(ok(oneShift())))))
        participation(transport).beat()
        assertEquals(listOf("GET $listPath", "POST $enterPath"), transport.requests)
        // The answer (the part is active) is kept.
        assertEquals("active", store().get(shift)!!.myState)
        assertNull(db.shiftDao().get(shift)!!.leftAt)
    }

    @Test
    fun aLeftPartIsNotEnteredAgainWhileTheDeviceIsOutOfTheShiftOrItsLineIsFullOrItIsActive() = runTest {
        val enterPath = "/v1/device/shifts/$shift/enter"
        // The device itself left: the host is right.
        db.shiftDao().upsert(HostFactsFixtures.shift().copy(leftAt = 5L))
        var t = Exact(mutableMapOf(listPath to ArrayDeque(listOf(ok(listWithMyState("left"))))))
        participation(t).beat()
        assertEquals(listOf("GET $listPath"), t.requests)
        // Working, the part active at the host: nothing to do.
        db.shiftDao().upsert(HostFactsFixtures.shift().copy(leftAt = null))
        t = Exact(mutableMapOf(listPath to ArrayDeque(listOf(ok(listWithMyState("active"))))))
        participation(t).beat()
        assertEquals(listOf("GET $listPath"), t.requests)
        // Working, left at the host, the line is full: asked again on the next beat, nothing changes meanwhile.
        t = Exact(mutableMapOf(listPath to ArrayDeque(listOf(ok(listWithMyState("left")))), enterPath to ArrayDeque(listOf(refusal(409, envelope("conflict", "shift_line_full"))))))
        participation(t).beat()
        assertEquals(listOf("GET $listPath", "POST $enterPath"), t.requests)
        assertEquals("left", store().get(shift)!!.myState)
    }

    @Test
    fun anAnswerToAnEarlierPauseDoesNotSettleThePauseAskedAgainWhileItWasInFlight() = runTest {
        owe(shift)
        val transport = Exact(mutableMapOf(leavePath to ArrayDeque(listOf(ok(oneShift()))), listPath to ArrayDeque(listOf(ok(listBody())))))
        // The leave is on its way; the operator enters again and pauses again (the marker is written anew).
        transport.during = {
            clock = 2_000L
            store().markLeavePending(shift)
        }
        participation(transport).beat()
        // The answer was to the first pause: the second is still owed, with its own marker.
        assertEquals(listOf(shift), store().pendingLeaves())
        assertEquals("2000", db.metaDao().get(ShiftParticipationStore.leaveKey(shift)))
    }

    @Test
    fun aSettlingRefusalToAnEarlierPauseDoesNotSettleThePauseAskedAgainEither() = runTest {
        owe(shift)
        val refused = refusal(409, envelope("conflict", "shift_not_entered"))
        val transport = Exact(mutableMapOf(leavePath to ArrayDeque(listOf(refused)), listPath to ArrayDeque(listOf(ok(listBody())))))
        transport.during = {
            clock = 2_000L
            store().markLeavePending(shift)
        }
        participation(transport).beat()
        assertEquals(listOf(shift), store().pendingLeaves())
    }

    @Test
    fun anOwedLeaveDroppedBecauseTheDeviceIsInDoesNotDropAPauseMarkedMeanwhile() = runTest {
        // Read as «in the shift again»: the drop is of that marker only. The store is asked once; a marker rewritten after the read stays.
        db.shiftDao().upsert(HostFactsFixtures.shift().copy(leftAt = null))
        store().markLeavePending(shift)
        val owed = store().owedLeaves().single()
        assertFalse(owed.stillOut)
        clock = 3_000L
        store().markLeavePending(shift)
        store().clearLeavePending(shift, owed.marker)
        assertEquals(listOf(shift), store().pendingLeaves())
    }

    @Test
    fun theTokenOfAnOwedLeaveIsTheOneReadWithItsMarkerNotOneThatAnEntryWroteDuringTheSend() = runTest {
        db.shiftDao().upsert(HostFactsFixtures.shift().copy(leftAt = 5L))
        store().markLeavePending(shift)
        db.recovery.commit {
            db.metaDao().put(app.markiro.handheld.core.storage.MetaEntity(ShiftParticipationStore.key(shift), """{"shiftId":"$shift","myState":"left","fetchedAt":1,"joinedRev":7}"""))
        }
        val owed = store().owedLeaves().single()
        assertEquals(7L, owed.joinedRev)
        assertTrue(owed.stillOut)
        assertEquals("1000", owed.marker)
        // An entry since moves the token on; the read already made stays what it was (the host ignores a leave of the earlier stay).
        db.recovery.commit {
            db.metaDao().put(app.markiro.handheld.core.storage.MetaEntity(ShiftParticipationStore.key(shift), """{"shiftId":"$shift","myState":"active","fetchedAt":2,"joinedRev":99}"""))
        }
        assertEquals(7L, owed.joinedRev)
        assertEquals(99L, store().owedLeaves().single().joinedRev)
    }
}
