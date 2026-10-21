package app.markiro.handheld.feature.shift

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.backend.HostBackend
import app.markiro.handheld.core.box.SsccPool
import app.markiro.handheld.core.host.HostBlockSupplier
import app.markiro.handheld.core.host.HostCalls
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
}
