package app.markiro.handheld.feature.shift

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.backend.HostBackend
import app.markiro.handheld.core.box.SsccPool
import app.markiro.handheld.core.host.HostBlockSupplier
import app.markiro.handheld.core.host.HostCalls
import app.markiro.handheld.core.host.HostParticipation
import app.markiro.handheld.core.host.ShiftParticipationStore
import app.markiro.handheld.core.network.host.TransportFailure
import kotlinx.serialization.json.jsonArray
import kotlinx.coroutines.CancellationException
import app.markiro.handheld.core.network.CredentialDto
import app.markiro.handheld.core.network.DeviceDto
import app.markiro.handheld.core.network.PairResponse
import app.markiro.handheld.core.network.host.HostApi
import app.markiro.handheld.core.network.host.HostResult
import app.markiro.handheld.core.network.host.HostTransport
import app.markiro.handheld.core.pallets.SsccBlockApplier
import app.markiro.handheld.core.storage.DeviceRecovery
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.HostPairing
import app.markiro.handheld.core.storage.InMemoryCredentialStore
import app.markiro.handheld.core.storage.MetaStore
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ShiftRepositoryHostTest {
    private lateinit var db: HandheldDatabase
    private val id = "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b"

    @Before
    fun open() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        kotlinx.coroutines.runBlocking {
            val recovery = DeviceRecovery(db, InMemoryCredentialStore()).also { it.initialize() }
            val origin = "https://192.168.1.10:45710"
            recovery.restore(
                PairResponse(DeviceDto("d1", "ТСД", "handheld", "h1", "", null), CredentialDto("k1", origin), emptyList()),
                origin,
                HostPairing("ab".repeat(32), "h1", listOf("192.168.1.10")),
            )
            db.deviceConfigDao().get()!!.let { db.deviceConfigDao().upsert(it.copy(lineName = "Линия 2")) }
        }
    }

    @After
    fun close() = db.close()

    private fun fixture(name: String) = checkNotNull(javaClass.classLoader?.getResource(name)) { name }.readText()

    private class Script(val gets: Map<String, String>, val posts: MutableMap<String, ArrayDeque<HostResult>>) : HostTransport {
        override suspend fun get(path: String) = HostResult.Ok(200, gets.getValue(path), null)
        override suspend fun post(path: String, body: String) = posts.getValue(path).removeFirst()
    }

    private fun repository(script: Script): ShiftRepository {
        val api = HostApi(script)
        val pool = SsccPool(db)
        val supplier = HostBlockSupplier(db, MetaStore(db), api, pool, SsccBlockApplier(pool))
        val backend = HostBackend({ api }, db.deviceConfigDao(), db, supplier, HostCalls { }, null, db.operatorDao())
        return ShiftRepository(backend, db, Json { ignoreUnknownKeys = true }, pool)
    }

    private fun ok(body: String) = HostResult.Ok(200, body, null)
    private val block0 = """{"id":"b1000000-0000-4000-8000-000000000001","issuerPrefix":"460068200","extension":0,"fromSerial":1500,"toSerial":3499}"""
    private val block1 = """{"id":"b1000000-0000-4000-8000-000000000002","issuerPrefix":"460068200","extension":1,"fromSerial":40,"toSerial":239}"""

    @Test
    fun theListLandsInTheMirrorAndAnEntryGivesTheShiftItsTemplatesPrefixAndBlocks() = runTest {
        val script = Script(
            gets = mapOf("/v1/device/shifts" to fixture("device-shifts.json")),
            posts = mutableMapOf(
                "/v1/device/shifts/$id/enter" to ArrayDeque(listOf(ok(fixture("device-shift-entered-pallets.json")))),
                "/v1/device/sscc/blocks" to ArrayDeque(listOf(ok(block0), ok(block1))),
            ),
        )
        val repository = repository(script)
        assertTrue(repository.refreshList())
        assertEquals(setOf("OCT26-004", "OCT26-005/S"), db.shiftDao().all().map { it.number }.toSet())

        assertEquals(EnterResult.Ok, repository.enter(id))
        val shift = db.shiftDao().get(id)!!
        assertNotNull(shift.enteredAt)
        assertEquals("460068200", shift.ssccIssuerPrefix)
        assertEquals("04600682000013", shift.productGtin14)
        assertTrue(shift.boxLabelTemplate!!.contains("\"widthMm\":58"))
        assertTrue(shift.palletLabelTemplateSpec!!.contains("qty.boxes"))
        assertEquals(40, shift.palletBoxCapacity)
        assertEquals(id, db.deviceConfigDao().get()!!.activeShiftId)
        // Both serial streams are in the pool, with the host's block ids.
        assertEquals(1500L, db.ssccPoolDao().lowestWithRoom("460068200", 0)!!.nextSerial)
        assertEquals("b1000000-0000-4000-8000-000000000002", db.ssccPoolDao().lowestWithRoom("460068200", 1)!!.blockId)
    }

    @Test
    fun aShiftTheHostCallsClosedOrForOtherVersionsIsReportedAsThePeopleAlreadyRead() = runTest {
        val closed = HostResult.Ok(409, """{"error":{"code":"conflict","message":"m","details":{"constraint":"shift_status","status":"closed"}}}""", null)
        val update = HostResult.Ok(409, """{"error":{"code":"conflict","message":"m","details":{"constraint":"station_update"}}}""", null)
        assertEquals(EnterResult.Closed, repository(Script(emptyMap(), mutableMapOf("/v1/device/shifts/$id/enter" to ArrayDeque(listOf(closed))))).enter(id))
        assertEquals(EnterResult.UpdateRequired, repository(Script(emptyMap(), mutableMapOf("/v1/device/shifts/$id/enter" to ArrayDeque(listOf(update))))).enter(id))
    }

    private fun refusal(body: String) = HostResult.Ok(409, body, null)
    private fun enterPath() = "/v1/device/shifts/$id/enter"

    @Test
    fun aFullLineIsReportedWithItsNumbersAndNothingIsEntered() = runTest {
        db.shiftDao().upsert(ShiftEntityFixtures.bundled(id))
        db.deviceConfigDao().get()!!.let { db.deviceConfigDao().upsert(it.copy(activeShiftId = id)) }
        val script = Script(emptyMap(), mutableMapOf(enterPath() to ArrayDeque(listOf(refusal(fixture("error-shift-line-full.json"))))))
        assertEquals(EnterResult.LineFull(active = 2, maxStations = 2), repository(script).enter(id))
        // Work already running on this device is not stopped by a refusal of a new entry.
        assertEquals(id, db.deviceConfigDao().get()!!.activeShiftId)
        assertEquals("active", db.shiftDao().get(id)!!.status)
    }

    @Test
    fun anOldHostsBusyIsSaidInWordsAndIsNotAGenericRefusal() = runTest {
        val script = Script(emptyMap(), mutableMapOf(enterPath() to ArrayDeque(listOf(refusal(fixture("error-shift-busy.json"))))))
        assertEquals(EnterResult.Busy, repository(script).enter(id))
    }

    @Test
    fun aFullLineWhoseNumbersAreMissingFallsBackToBusy() = runTest {
        val body = """{"error":{"code":"conflict","message":"m","details":{"constraint":"shift_line_full"}}}"""
        assertEquals(EnterResult.Busy, repository(Script(emptyMap(), mutableMapOf(enterPath() to ArrayDeque(listOf(refusal(body)))))).enter(id))
    }

    @Test
    fun aClosedPartIsNeverEnteredAndItsShiftIsClosedOnThisDevice() = runTest {
        db.shiftDao().upsert(ShiftEntityFixtures.bundled(id))
        db.deviceConfigDao().get()!!.let { db.deviceConfigDao().upsert(it.copy(activeShiftId = id)) }
        val entered = Json.parseToJsonElement(fixture("device-shift-entered.json")).jsonObject
        val closedPart = JsonObject(entered + ("myState" to JsonPrimitive("closed")) + ("maxStations" to JsonPrimitive(2)))
        // Only the entry is scripted: a second request (the bundle re-entering) would fail the test.
        val script = Script(emptyMap(), mutableMapOf(enterPath() to ArrayDeque(listOf(ok(closedPart.toString())))))
        val before = db.shiftDao().get(id)!!
        assertEquals(EnterResult.PartClosed, repository(script).enter(id))
        val after = db.shiftDao().get(id)!!
        assertEquals("closed", after.status)
        // Nothing that starts work is written: the entry time and the bundle stay as they were.
        assertEquals(before.enteredAt, after.enteredAt)
        assertEquals(before.bundleFetchedAt, after.bundleFetchedAt)
        assertEquals(null, db.deviceConfigDao().get()!!.activeShiftId)
    }

    @Test
    fun aClosedPartWithNoLocalRowWritesNoWorkableRow() = runTest {
        val entered = Json.parseToJsonElement(fixture("device-shift-entered.json")).jsonObject
        val closedPart = JsonObject(entered + ("myState" to JsonPrimitive("closed")))
        val script = Script(emptyMap(), mutableMapOf(enterPath() to ArrayDeque(listOf(ok(closedPart.toString())))))
        assertEquals(EnterResult.PartClosed, repository(script).enter(id))
        assertEquals(null, db.shiftDao().get(id)?.enteredAt)
        assertEquals(null, db.deviceConfigDao().get()!!.activeShiftId)
    }

    // ---- Task 9: a leave frees the host's slot, and what the host did not settle stays owed ----

    private fun leavePath() = "/v1/device/shifts/$id/leave"
    private fun listPath() = "/v1/device/shifts"

    private fun shiftAnswer(myState: String): String {
        val first = Json.parseToJsonElement(fixture("device-shifts-participants.json")).jsonObject.getValue("shifts").jsonArray[0].jsonObject
        return JsonObject(first + ("myState" to JsonPrimitive(myState))).toString()
    }

    private suspend fun workingIn() {
        db.shiftDao().upsert(ShiftEntityFixtures.bundled(id))
        db.deviceConfigDao().get()!!.let { db.deviceConfigDao().upsert(it.copy(activeShiftId = id)) }
    }

    /** The backend keeps what the host answered, as in production. */
    private fun storeRepository(script: HostTransport): ShiftRepository {
        val api = HostApi(script)
        val pool = SsccPool(db)
        val supplier = HostBlockSupplier(db, MetaStore(db), api, pool, SsccBlockApplier(pool))
        val store = ShiftParticipationStore(db)
        val backend = HostBackend({ api }, db.deviceConfigDao(), db, supplier, HostCalls { }, null, db.operatorDao(), participation = store)
        return ShiftRepository(backend, db, Json { ignoreUnknownKeys = true }, pool, SsccBlockApplier(pool), store)
    }

    private fun scripted(vararg answers: HostResult) = Script(emptyMap(), mutableMapOf(leavePath() to ArrayDeque(answers.toList())))
    private fun refused(status: Int, code: String, constraint: String? = null) = HostResult.Ok(
        status,
        """{"error":{"code":"$code","message":"m"${constraint?.let { ""","details":{"constraint":"$it"}""" } ?: ""}}}""",
        null,
    )

    @Test
    fun leavingMarksTheShiftLeftAtOnceAndFreesTheHostsSlot() = runTest {
        workingIn()
        storeRepository(scripted(ok(shiftAnswer("left")))).leave(id)
        assertNotNull(db.shiftDao().get(id)!!.leftAt)
        assertEquals(null, db.deviceConfigDao().get()!!.activeShiftId)
        assertEquals(emptyList<String>(), ShiftParticipationStore(db).pendingLeaves())
        assertEquals("left", ShiftParticipationStore(db).get(id)!!.myState)
    }

    @Test
    fun aLeaveTheHostDidNotHearStaysOwedAndTheOperatorIsNotBlocked() = runTest {
        workingIn()
        storeRepository(scripted(HostResult.Failed(TransportFailure.UNREACHABLE))).leave(id)
        assertNotNull(db.shiftDao().get(id)!!.leftAt)
        assertEquals(null, db.deviceConfigDao().get()!!.activeShiftId)
        assertEquals(listOf(id), ShiftParticipationStore(db).pendingLeaves())
    }

    @Test
    fun aHostThatHoldsNoSlotOfTheDeviceOwesNothing() = runTest {
        workingIn()
        storeRepository(scripted(refused(409, "conflict", "shift_not_entered"))).leave(id)
        assertEquals(emptyList<String>(), ShiftParticipationStore(db).pendingLeaves())
        assertNotNull(db.shiftDao().get(id)!!.leftAt)
    }

    @Test
    fun anUnknownShiftAndAnInvalidLeaveAreDefinitePermanentRefusals() = runTest {
        workingIn()
        storeRepository(scripted(refused(404, "not_found"))).leave(id)
        assertEquals(emptyList<String>(), ShiftParticipationStore(db).pendingLeaves())
        workingIn()
        storeRepository(scripted(refused(400, "validation_failed"))).leave(id)
        assertEquals(emptyList<String>(), ShiftParticipationStore(db).pendingLeaves())
    }

    @Test
    fun aStaleLeaveTheHostIgnoredLeavesThePartActiveAndTheLeaveStaysOwed() = runTest {
        workingIn()
        // The host no-ops a token of an earlier stay and answers the part as it is: still `active`.
        storeRepository(scripted(ok(shiftAnswer("active")))).leave(id)
        assertEquals(listOf(id), ShiftParticipationStore(db).pendingLeaves())
        assertNotNull(db.shiftDao().get(id)!!.leftAt)
    }

    @Test
    fun aClosedPartOrALeftPartOwesNothing() = runTest {
        workingIn()
        storeRepository(scripted(ok(shiftAnswer("closed")))).leave(id)
        assertEquals(emptyList<String>(), ShiftParticipationStore(db).pendingLeaves())
    }

    @Test
    fun theMarkerIsWrittenBeforeTheHostIsAskedSoAKilledProcessLosesNoLeave() = runTest {
        workingIn()
        val killed = object : HostTransport {
            override suspend fun get(path: String) = error("no read")
            override suspend fun post(path: String, body: String): HostResult = throw CancellationException("process killed mid-call")
        }
        runCatching { storeRepository(killed).leave(id) }
        val row = db.shiftDao().get(id)!!
        assertNotNull(row.leftAt)
        assertEquals(null, db.deviceConfigDao().get()!!.activeShiftId)
        assertEquals(listOf(id), ShiftParticipationStore(db).pendingLeaves())
    }

    @Test
    fun anOfflinePauseIsSentByTheBeatWithoutRejoiningAndSurvivesTheListPrune() = runTest {
        workingIn()
        storeRepository(scripted(HostResult.Failed(TransportFailure.UNREACHABLE))).leave(id)
        // A list that does not name the shift (the orphan prune) must not drop the owed leave.
        ShiftParticipationStore(db).save(emptyList())
        assertEquals(listOf(id), ShiftParticipationStore(db).pendingLeaves())
        // The beat finds the host again: it sends the leave (and does not enter, the device is out).
        val transport = Script(
            emptyMap(),
            mutableMapOf(leavePath() to ArrayDeque(listOf(ok(shiftAnswer("left"))))),
        )
        val api = HostApi(transport)
        HostParticipation(db, { api }, HostCalls { }).beat()
        assertEquals(emptyList<String>(), ShiftParticipationStore(db).pendingLeaves())
        assertNotNull(db.shiftDao().get(id)!!.leftAt)
    }

    /** As in production (`BackendModule`): the repository holds the selector, which picks the host of a paired device. */
    private fun selectedRepository(script: Script): ShiftRepository {
        val api = HostApi(script)
        val pool = SsccPool(db)
        val supplier = HostBlockSupplier(db, MetaStore(db), api, pool, SsccBlockApplier(pool))
        val store = ShiftParticipationStore(db)
        val host = HostBackend({ api }, db.deviceConfigDao(), db, supplier, HostCalls { }, null, db.operatorDao(), participation = store)
        val cloud = object : app.markiro.handheld.core.backend.StationBackend by app.markiro.handheld.core.backend.NoBackend {}
        val selector = app.markiro.handheld.core.backend.BackendSelector(db.deviceConfigDao(), cloud, host)
        return ShiftRepository(selector, db, Json { ignoreUnknownKeys = true }, pool, SsccBlockApplier(pool), store)
    }

    @Test
    fun aLeaveThroughTheProductionSelectorReachesTheHostAndWhatItDidNotHearStaysOwed() = runTest {
        assertEquals("host", db.deviceConfigDao().get()!!.backend)
        workingIn()
        val unheard = scripted(HostResult.Failed(TransportFailure.UNREACHABLE))
        selectedRepository(unheard).leave(id)
        // Final review C1: the selector answered `null` without a call and the marker was cleared; the host never heard of the leave.
        assertTrue(unheard.posts.getValue(leavePath()).isEmpty())
        assertEquals(listOf(id), ShiftParticipationStore(db).pendingLeaves())

        workingIn()
        val heard = scripted(ok(shiftAnswer("left")))
        selectedRepository(heard).leave(id)
        assertTrue(heard.posts.getValue(leavePath()).isEmpty())
        assertEquals(emptyList<String>(), ShiftParticipationStore(db).pendingLeaves())
        assertEquals("left", ShiftParticipationStore(db).get(id)!!.myState)
    }

    @Test
    fun anAnswerThatSaysNothingOfThePartSettlesNoLeave() = runTest {
        workingIn()
        val silent = object : app.markiro.handheld.core.backend.StationBackend by app.markiro.handheld.core.backend.NoBackend {
            override suspend fun leave(shiftId: String): String? = null
        }
        val pool = SsccPool(db)
        ShiftRepository(silent, db, Json { ignoreUnknownKeys = true }, pool, SsccBlockApplier(pool), ShiftParticipationStore(db)).leave(id)
        // Only `left` or `closed` say the host holds no slot of this device any more.
        assertEquals(listOf(id), ShiftParticipationStore(db).pendingLeaves())
    }

    /** [shiftAnswer] with this device (`d1`) as a participant in [state] holding the token [rev]. */
    private fun answerWithMe(state: String, rev: Long): String {
        val root = Json.parseToJsonElement(shiftAnswer(state)).jsonObject
        val mine = kotlinx.serialization.json.buildJsonObject {
            put("deviceId", JsonPrimitive("d1"))
            put("deviceKind", JsonPrimitive("handheld"))
            put("deviceName", JsonPrimitive("ТСД"))
            put("state", JsonPrimitive(state))
            put("joinedRev", JsonPrimitive(rev))
        }
        return JsonObject(root + ("participants" to kotlinx.serialization.json.JsonArray(root.getValue("participants").jsonArray + mine))).toString()
    }

    /** The race of final review I1: the rejoin's entry is answered [entryAnswer] only after the operator's leave was answered. */
    private suspend fun leaveDuringRejoin(entryAnswer: HostResult): Pair<HostParticipation, MutableList<String>> {
        workingIn()
        // The host has this device's part as left (token 1): the beat will enter it again.
        ShiftParticipationStore(db).save(Json { ignoreUnknownKeys = true }.decodeFromString(
            app.markiro.handheld.core.network.host.DeviceShiftDto.serializer(), answerWithMe("left", 1),
        ))
        val listBody = """{"shifts":[${answerWithMe("left", 1)}]}"""
        val bodies = mutableListOf<String>()
        lateinit var repository: ShiftRepository
        var hostEntered = false
        val transport = object : HostTransport {
            override suspend fun get(path: String): HostResult = when (path) {
                listPath() -> ok(listBody)
                else -> error("nothing scripted for GET $path")
            }
            override suspend fun post(path: String, body: String): HostResult = when (path) {
                enterPath() -> {
                    // The rejoin's request is on its way; the operator taps «Выйти» and its leave is answered first (the part is still left
                    // at the host, token 1, so nothing changes there). Only then does the host carry out the entry: active, token 2.
                    repository.leave(id)
                    hostEntered = true
                    entryAnswer
                }
                leavePath() -> {
                    bodies += body
                    ok(answerWithMe("left", if (hostEntered) 2 else 1))
                }
                else -> error("nothing scripted for POST $path")
            }
        }
        val api = HostApi(transport)
        repository = storeRepository(transport)
        val beat = HostParticipation(db, { api }, HostCalls { })
        beat.beat()
        assertNotNull(db.shiftDao().get(id)!!.leftAt)
        assertEquals(null, db.deviceConfigDao().get()!!.activeShiftId)
        return beat to bodies
    }

    @Test
    fun aLeaveTappedWhileTheAutomaticRejoinIsInFlightStillFreesTheSlotTheRejoinTook() = runTest {
        val (beat, bodies) = leaveDuringRejoin(ok(answerWithMe("active", 2)))
        // The host now holds a slot for a device that is out; a leave must still be owed for it.
        assertEquals(listOf(id), ShiftParticipationStore(db).pendingLeaves())
        // The next beat ends the stay the rejoin made, with its token.
        beat.beat()
        assertEquals("""{"joinedRev":2}""", bodies.last())
        assertEquals(emptyList<String>(), ShiftParticipationStore(db).pendingLeaves())
    }

    @Test
    fun aRejoinWhoseAnswerIsLostWhileTheLeaveWasTappedStillOwesTheLeave() = runTest {
        // The host carried the entry out but its answer never arrived: the device cannot know, so the leave is owed again.
        leaveDuringRejoin(HostResult.Failed(TransportFailure.TIMEOUT))
        assertEquals(listOf(id), ShiftParticipationStore(db).pendingLeaves())
    }
}
